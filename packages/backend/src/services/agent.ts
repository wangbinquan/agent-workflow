// Agent service — CRUD on the agents table.
// JSON fields (outputs / skills / permission / frontmatterExtra) are stored as
// strings in the DB and (un)marshaled at this boundary. Routes upstream see
// pure JS objects.

import type {
  Agent,
  AgentInputPort,
  AgentSkillRef,
  CreateAgent,
  RenameAgent,
  UpdateAgent,
} from '@agent-workflow/shared'
import {
  AgentInputPortSchema,
  AgentInputPortsSchema,
  AgentSkillRefSchema,
} from '@agent-workflow/shared'
import { and, eq, inArray, like, notInArray, type SQL } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import {
  agents,
  mcps,
  plugins,
  resourceGrants,
  scheduledTasks,
  tasks,
  workflows,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { agentsDependingOnIn, validateDependsOn } from './agentDeps'
import { agentRefFenceGroups, resolveAgentRefsUsable } from './agentRefs'
import {
  discloseRefsSync,
  discloseScheduleRefs,
  isResourceAdminActor,
  listGrantedResourceIds,
} from './resourceAcl'
import type { Actor } from '@/auth/actor'
import { getRuntime } from './runtimeRegistry'
import { isAgentLaunching } from './agentLaunchReservation'
import { isOwnerNameUniqueViolation, ownerScopedNameWhere } from './ownerScopedName'
import { assertRefsUsableInTx } from './resourceRefs'

type AgentRow = typeof agents.$inferSelect

export async function listAgents(db: DbClient): Promise<Agent[]> {
  const rows = await db.select().from(agents)
  return rows.map(rowToAgent)
}

/** Fetch an agent by its canonical resource id. */
export async function getAgentById(db: DbClient, id: string): Promise<Agent | null> {
  const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1)
  const row = rows[0]
  return row ? rowToAgent(row) : null
}

/**
 * RFC-223 (T15) — a Drizzle `WHERE` that resolves a frozen workflow-snapshot
 * agent-single node by canonical id only. `agentName` is display-only; a
 * name-only/corrupt snapshot returns `null` and callers fail closed. The R4-1
 * quarantine sentinel likewise resolves to no row.
 */
export function snapshotNodeAgentWhere(node: unknown): SQL | null {
  const rec = node as Record<string, unknown>
  if (typeof rec.agentId === 'string' && rec.agentId.length > 0) return eq(agents.id, rec.agentId)
  return null
}

export async function createAgent(
  db: DbClient,
  input: CreateAgent,
  opts?: {
    ownerUserId?: string
    builtin?: boolean
    actor?: Actor | null
    id?: string
    /** Deterministic race-test seam after preflight, before the final dbTxSync. */
    beforeWriteTransaction?: () => void | Promise<void>
  },
): Promise<Agent> {
  const ownerUserId = opts?.ownerUserId ?? null
  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(ownerScopedNameWhere(agents.ownerUserId, agents.name, ownerUserId, input.name))
    .limit(1)
  if (existing.length > 0) {
    throw new ConflictError('agent-name-in-use', `agent '${input.name}' already exists`)
  }

  // RFC-223 (PR-1): the agent's own id, minted up front so the dependsOn cycle
  // guard can self-check by id (a name authored in agent.md can't reference an
  // id that does not exist yet, but update() re-uses the same by-id guard).
  const id = opts?.id ?? ulid()

  // RFC-223 (PR-1, Codex impl-gate P1-2): resolve id-or-name references to
  // canonical ids AND enforce per-ref ACL in ONE pass, so the id the ACL gate
  // approves is the exact id persisted (no check-then-resolve TOCTOU). On create
  // every reference is new. A null actor (framework seeder) resolves without the
  // ACL gate. P1-1: a missing managed skill is kept as an unresolved managed ref,
  // never demoted to a repo-local project ref.
  const resolved = await resolveAgentRefsUsable(db, opts?.actor ?? null, {
    mcp: input.mcp,
    plugins: input.plugins ?? [],
    dependsOn: input.dependsOn,
    skills: input.skills,
  })
  const mcpIds = resolved.mcp
  const pluginIds = resolved.plugins
  const dependsOnIds = resolved.dependsOn
  const skillRefs = resolved.skills

  // RFC-022 save-time guard: not-found / self-ref / cycle all throw a 400
  // DomainError with the corresponding code. Runs *before* the insert so
  // partially-validated rows never land in the DB. Keyed by id (RFC-223 PR-1);
  // pass the proposed name so a self-name dep (whose id doesn't exist yet) is
  // still caught as agent-dependency-self.
  await validateDependsOn(db, id, dependsOnIds)

  // RFC-028 save-time guard: every `mcp[]` entry must resolve to an existing
  // mcps row. Without this, agents save successfully but fail at runtime when
  // the scheduler tries to load the row (or worse, succeeds with a partial
  // closure that silently drops the missing reference).
  await validateMcpReferences(db, mcpIds)

  // RFC-031: every entry in input.plugins must point at an existing + enabled
  // plugins row. Failure here surfaces as 422 plugin-not-found / -disabled.
  await validatePluginReferences(db, pluginIds)

  // RFC-111 (Codex audit F6): a pinned runtime NAME must resolve to an existing
  // runtimes row. Without this, an agent.md import / API call can pin an unknown
  // or typo'd runtime (e.g. `claude_code`) that saves fine but silently falls back
  // to built-in opencode at dispatch — a hard-to-detect runtime/profile drift.
  await validateRuntimeReference(db, input.runtime)

  const now = Date.now()
  // RFC-005: outputKinds is a sidecar map ported through `frontmatter_extra`
  // (under reserved key `outputKinds`) until a dedicated column is needed.
  // services/review.ts:loadUpstreamPortKind reads from the same place.
  //
  // RFC-060 PR-B: same pattern for `role` and `outputWrapperPortNames` — both
  // are stored as reserved keys under frontmatter_extra and lifted back out
  // to top-level Agent fields by rowToAgent. role: 'normal' is the default
  // and is never persisted (keeps existing agents' fmExtra byte-identical).
  const fmExtra = { ...input.frontmatterExtra } as Record<string, unknown>
  if (input.outputKinds !== undefined) fmExtra.outputKinds = input.outputKinds
  if (input.role !== undefined && input.role !== 'normal') {
    fmExtra.role = input.role
  }
  if (input.outputWrapperPortNames !== undefined) {
    fmExtra.outputWrapperPortNames = input.outputWrapperPortNames
  }
  await opts?.beforeWriteTransaction?.()
  try {
    dbTxSync(db, (tx) => {
      // Every create ref is new. This is the authorization/existence
      // linearization point; async validators above remain preflight only.
      assertRefsUsableInTx(
        tx,
        opts?.actor ?? null,
        agentRefFenceGroups(
          {
            mcp: mcpIds,
            plugins: pluginIds,
            dependsOn: dependsOnIds,
            skills: skillRefs,
          },
          undefined,
          resolved.matchedManagedSkillIds,
        ),
      )
      tx.insert(agents)
        .values({
          id,
          name: input.name,
          description: input.description,
          outputs: JSON.stringify(input.outputs),
          // RFC-166: declarative input ports (own column, symmetrical to outputs).
          // Normalize through the schema on write so the column is canonical (kind
          // default applied, unknown keys stripped) even if a service-layer caller
          // bypassed CreateAgentSchema's zod parse.
          inputs: serializeInputs(input.inputs),
          syncOutputsOnIterate: input.syncOutputsOnIterate,
          runtime: input.runtime ?? null, // RFC-111
          permission: JSON.stringify(input.permission),
          // RFC-223 (PR-1): resolved id refs / typed skill refs (already deduped).
          skills: serializeSkillRefs(skillRefs),
          dependsOn: JSON.stringify(dependsOnIds),
          mcp: JSON.stringify(mcpIds),
          // RFC-031: plugin id array; T6 enforces existence + enabled at save
          // time, T7 unions across the dependsOn closure at runner injection time.
          plugins: JSON.stringify(pluginIds),
          frontmatterExtra: JSON.stringify(fmExtra),
          bodyMd: input.bodyMd,
          // RFC-099: creator becomes owner; new resources default to 'public' (D18).
          ownerUserId,
          visibility: 'public',
          // RFC-104: built-in marker — only seedFusionResources passes builtin:true;
          // never set via any HTTP path (CreateAgentSchema omits it).
          builtin: opts?.builtin ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    })
  } catch (error) {
    if (isOwnerNameUniqueViolation(error, 'agents', 'agents_owner_name_unique')) {
      throw new ConflictError('agent-name-in-use', `agent '${input.name}' already exists`)
    }
    throw error
  }

  const created = await getAgentById(db, id)
  if (created === null) throw new Error('agent disappeared right after insert')
  return created
}

export async function updateAgent(
  db: DbClient,
  id: string,
  patch: UpdateAgent,
  actor?: Actor | null,
  fence?: { expectedUpdatedAt: number; expectedAclRevision: number },
  hooks?: {
    /** Deterministic race-test seam after preflight, before the final dbTxSync. */
    beforeWriteTransaction?: () => void | Promise<void>
  },
): Promise<Agent> {
  const existing = await getAgentById(db, id)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', 'agent not found')
  }

  // RFC-223 (PR-1, Codex impl-gate P1-2): resolve patched id-or-name refs →
  // canonical ids AND enforce ACL in ONE pass, then store the SAME resolved
  // arrays. Only NEWLY-added references are ACL-checked (D15) — the diff compares
  // RESOLVED IDS against the already-stored ids, so a grandfathered ref
  // re-submitted by name is not mis-flagged as new. undefined patch fields are
  // left untouched. Skills keep unresolved managed refs (no project demotion, P1-1).
  const resolvedRefs = await resolveAgentRefsUsable(
    db,
    actor ?? null,
    {
      mcp: patch.mcp ?? existing.mcp,
      plugins: patch.plugins ?? existing.plugins,
      dependsOn: patch.dependsOn ?? existing.dependsOn,
      skills: patch.skills ?? existing.skills,
    },
    existing,
  )
  const dependsOnIds = patch.dependsOn !== undefined ? resolvedRefs.dependsOn : undefined
  const mcpIds = patch.mcp !== undefined ? resolvedRefs.mcp : undefined
  const pluginIds = patch.plugins !== undefined ? resolvedRefs.plugins : undefined
  const skillRefs = patch.skills !== undefined ? resolvedRefs.skills : undefined

  // RFC-022 save-time guard — only when the caller actually patched dependsOn.
  // PATCH that doesn't touch the field keeps the existing closure validity.
  // Keyed by the agent's own id (RFC-223 PR-1) so a self-dep is caught by id.
  if (dependsOnIds !== undefined) {
    await validateDependsOn(db, existing.id, dependsOnIds)
  }

  // RFC-028 save-time guard — only when caller patched mcp.
  if (mcpIds !== undefined) {
    await validateMcpReferences(db, mcpIds)
  }

  // RFC-031 save-time guard — only when caller patched plugins.
  if (pluginIds !== undefined) {
    await validatePluginReferences(db, pluginIds)
  }

  // RFC-111 (Codex audit F6): same guard for a patched runtime pin — a NAME must
  // resolve to an existing runtimes row (null = clear to inherit, skips the check).
  // RFC-118: pass the existing pin so re-saving an already-pinned (now-disabled)
  // runtime is allowed (D6); only a CHANGED pin must target an enabled runtime.
  if (patch.runtime !== undefined) {
    await validateRuntimeReference(db, patch.runtime, existing.runtime)
  }

  const set: Partial<typeof agents.$inferInsert> = {}
  if (patch.description !== undefined) set.description = patch.description
  if (patch.outputs !== undefined) set.outputs = JSON.stringify(patch.outputs)
  if (patch.inputs !== undefined) set.inputs = serializeInputs(patch.inputs) // RFC-166
  if (patch.syncOutputsOnIterate !== undefined)
    set.syncOutputsOnIterate = patch.syncOutputsOnIterate
  if (patch.permission !== undefined) set.permission = JSON.stringify(patch.permission)
  // RFC-115 round-trip fix: actually persist the runtime column. A registry NAME
  // pins; null clears back to inherit (config.defaultRuntime); undefined leaves it
  // untouched (sparse-patch). Before this branch the set-builder skipped runtime
  // entirely, so the edit form could neither repoint nor un-pin an agent.
  if (patch.runtime !== undefined) set.runtime = patch.runtime
  // RFC-223 (PR-1): persist the resolved id refs / typed skill refs (deduped by
  // the resolver), never the raw name-or-id wire values.
  if (skillRefs !== undefined) set.skills = serializeSkillRefs(skillRefs)
  if (dependsOnIds !== undefined) set.dependsOn = JSON.stringify(dependsOnIds)
  if (mcpIds !== undefined) set.mcp = JSON.stringify(mcpIds)
  if (pluginIds !== undefined) set.plugins = JSON.stringify(pluginIds)
  // RFC-005: merge outputKinds into frontmatter_extra alongside the explicit
  // patch (if any). Tests that PATCH only outputKinds preserve the rest of
  // frontmatter_extra; tests that PATCH only frontmatterExtra drop outputKinds
  // only if the caller passes a fresh object without that key (existing
  // overwrite semantics).
  //
  // RFC-060 PR-B: extend the same merge to `role` and `outputWrapperPortNames`.
  // A patch that touches either of these three sidecar fields (or
  // frontmatterExtra itself) triggers the merge; the others stay at their
  // current row values.
  if (
    patch.frontmatterExtra !== undefined ||
    patch.outputKinds !== undefined ||
    patch.role !== undefined ||
    patch.outputWrapperPortNames !== undefined
  ) {
    const baseFm =
      patch.frontmatterExtra !== undefined
        ? { ...patch.frontmatterExtra }
        : ((JSON.parse(existing.frontmatterExtra !== undefined ? '{}' : '{}') as Record<
            string,
            unknown
          >) ?? {})
    if (patch.frontmatterExtra === undefined) {
      // Caller patched only a sidecar — start from current row state.
      const fresh = await getAgentById(db, id)
      if (fresh !== null) {
        Object.assign(baseFm, fresh.frontmatterExtra)
        if (fresh.outputKinds !== undefined && patch.outputKinds === undefined) {
          ;(baseFm as Record<string, unknown>).outputKinds = fresh.outputKinds
        }
        if (fresh.role !== undefined && fresh.role !== 'normal' && patch.role === undefined) {
          ;(baseFm as Record<string, unknown>).role = fresh.role
        }
        if (
          fresh.outputWrapperPortNames !== undefined &&
          patch.outputWrapperPortNames === undefined
        ) {
          ;(baseFm as Record<string, unknown>).outputWrapperPortNames = fresh.outputWrapperPortNames
        }
      }
    }
    if (patch.outputKinds !== undefined) {
      ;(baseFm as Record<string, unknown>).outputKinds = patch.outputKinds
    }
    if (patch.role !== undefined) {
      if (patch.role === 'normal') {
        delete (baseFm as Record<string, unknown>).role
      } else {
        ;(baseFm as Record<string, unknown>).role = patch.role
      }
    }
    if (patch.outputWrapperPortNames !== undefined) {
      ;(baseFm as Record<string, unknown>).outputWrapperPortNames = patch.outputWrapperPortNames
    }
    set.frontmatterExtra = JSON.stringify(baseFm)
  }
  if (patch.bodyMd !== undefined) set.bodyMd = patch.bodyMd

  await hooks?.beforeWriteTransaction?.()
  dbTxSync(db, (tx) => {
    const revisionFenced = fence !== undefined && actor !== undefined && actor !== null
    const currentRow = revisionFenced
      ? requireAgentMutationRevision(tx, id, actor, fence)
      : tx.select().from(agents).where(eq(agents.id, id)).get()
    if (currentRow === undefined) {
      throw new NotFoundError('agent-not-found', 'agent not found')
    }
    const current = rowToAgent(currentRow)
    const nextRefs = {
      mcp: mcpIds ?? current.mcp,
      plugins: pluginIds ?? current.plugins,
      dependsOn: dependsOnIds ?? current.dependsOn,
      skills: skillRefs ?? current.skills,
    }
    // Diff against the row snapshot from THIS transaction. A lost grant on an
    // unchanged ref remains grandfathered; only ids this write introduces are
    // re-authorized and existence-fenced.
    assertRefsUsableInTx(
      tx,
      actor ?? null,
      agentRefFenceGroups(nextRefs, current, resolvedRefs.matchedManagedSkillIds),
    )

    set.updatedAt = Math.max(Date.now(), currentRow.updatedAt + 1)
    const where = revisionFenced
      ? and(
          eq(agents.id, id),
          eq(agents.updatedAt, fence.expectedUpdatedAt),
          eq(agents.aclRevision, fence.expectedAclRevision),
        )
      : eq(agents.id, id)
    const result = tx.update(agents).set(set).where(where).run()
    if (revisionFenced && changesOf(result) !== 1) throw staleAgentError(id)
  })
  const updated = await getAgentById(db, id)
  if (updated === null) throw new Error('agent disappeared after update')
  return updated
}

export async function deleteAgent(
  db: DbClient,
  id: string,
  actor: Actor,
  fence?: { expectedUpdatedAt: number; expectedAclRevision: number },
): Promise<void> {
  const existing = await getAgentById(db, id)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', 'agent not found')
  }
  const name = existing.name
  // RFC-203 T6: reference-disclosure grant sets, pre-fetched OUTSIDE the
  // guard transaction (dbTxSync is sync) — used only to decide which
  // referencing resource NAMES the refusal details may show.
  const wfGranted = isResourceAdminActor(actor)
    ? new Set<string>()
    : await listGrantedResourceIds(db, actor, 'workflow')
  const agGranted = isResourceAdminActor(actor)
    ? new Set<string>()
    : await listGrantedResourceIds(db, actor, 'agent')
  // RFC-165 (F17-r3): guards + the delete run in ONE dbTxSync — the old
  // check-then-await-then-write shape let a reference land between the check
  // and the delete. All reads below use the synchronous tx surface.
  dbTxSync(db, (tx) => {
    // Canonical-id fence: a rename cannot retarget this operation. A concurrent
    // delete is reported as the same non-enumerating 404 as an absent id.
    if (fence === undefined) {
      const fenceRow = tx.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).get()
      if (fenceRow === undefined) {
        throw new NotFoundError('agent-not-found', 'agent not found')
      }
    } else {
      requireAgentMutationRevision(tx, id, actor, fence)
    }

    // RFC-175 (§2e): refuse while a single-agent launch holds this agent's id.
    // The launch resolves the agent by NAME from a frozen snapshot, so deleting
    // (then recreating same-name) mid-launch would run a DIFFERENT agent than
    // the task recorded (ABA). Synchronous in-process reservation (single-process
    // daemon), checked here in the same tx as the delete; the launch's
    // post-acquire re-verify covers the reverse check→acquire race.
    if (isAgentLaunching(existing.id)) {
      throw new ConflictError(
        'agent-launching',
        `agent '${name}' has a task launch in progress; retry after it completes`,
      )
    }
    const wfRows = tx
      .select({
        id: workflows.id,
        name: workflows.name,
        definition: workflows.definition,
        ownerUserId: workflows.ownerUserId,
        visibility: workflows.visibility,
      })
      .from(workflows)
      .all()
    const refs = workflowsUsingAgentIn(wfRows, existing.id)
    if (refs.length > 0) {
      const refIds = new Set(refs.map((r) => r.id))
      throw new ConflictError(
        'agent-in-use',
        `agent '${name}' is referenced by ${refs.length} workflow(s)`,
        discloseRefsSync(
          actor,
          wfRows.filter((r) => refIds.has(r.id)),
          wfGranted,
        ),
      )
    }
    // RFC-022 reverse-dep guard: refuse to delete an agent any other agent's
    // dependsOn closure mentions. Forces the caller to deref upstream first so
    // runtime never spawns with a dangling reference (which would surface as
    // a node failure with `agent-dependency-not-found`).
    const depRows = tx
      .select({
        id: agents.id,
        name: agents.name,
        dependsOn: agents.dependsOn,
        ownerUserId: agents.ownerUserId,
        visibility: agents.visibility,
      })
      .from(agents)
      // RFC-223 (PR-1): dependsOn stores agent IDS now — match this agent's id.
      .where(like(agents.dependsOn, `%"${existing.id}"%`))
      .all()
    const dependents = agentsDependingOnIn(depRows, existing.id)
    if (dependents.length > 0) {
      throw new ConflictError(
        'agent-dependency-still-referenced',
        `agent '${name}' is referenced by ${dependents.length} other agent(s)' dependsOn`,
        discloseRefsSync(actor, dependents, agGranted),
      )
    }
    // RFC-165 §4: a NON-terminal single-agent task still runs (or will run)
    // against this agent — deleting now would strand it mid-flight. 409 until
    // those tasks finish/cancel. Terminal tasks are the accepted limitation:
    // their retry/resume later fails with agent-not-found (same soft-reference
    // philosophy as RFC-164 workgroup members).
    //
    // RFC-223 (PR-3a, R3-3): match by the CANONICAL `source_agent_id` (frozen at
    // launch), NOT by name. After PR-8 lifts global name uniqueness a by-name
    // guard would let a DIFFERENT owner's same-named task block this delete (and
    // leak that task's id via the error). A pre-0091 legacy task has NULL
    // source_agent_id and is already R4-1-quarantined (un-resumable), so not
    // blocking on it is correct.
    const live = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.sourceAgentId, existing.id),
          notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        ),
      )
      .all()
    if (live.length > 0) {
      throw new ConflictError(
        'agent-tasks-active',
        `agent '${name}' has ${live.length} non-terminal single-agent task(s); cancel or wait before deleting`,
        { taskIds: live.map((t) => t.id) },
      )
    }
    const schedRows = tx
      .select({
        id: scheduledTasks.id,
        name: scheduledTasks.name,
        launchKind: scheduledTasks.launchKind,
        launchPayload: scheduledTasks.launchPayload,
        ownerUserId: scheduledTasks.ownerUserId,
      })
      .from(scheduledTasks)
      .all()
    const schedRefs = scheduledRowsReferencingAgent(schedRows, { id: existing.id })
    if (schedRefs.length > 0) {
      const schedIds = new Set(schedRefs)
      throw new ConflictError(
        'agent-scheduled-referenced',
        `agent '${name}' is the target of ${schedRefs.length} scheduled task(s); delete or repoint them first`,
        discloseScheduleRefs(
          actor,
          schedRows.filter((r) => schedIds.has(r.id)),
        ),
      )
    }
    tx.delete(agents).where(eq(agents.id, id)).run()
  })
}

export async function renameAgent(
  db: DbClient,
  id: string,
  input: RenameAgent,
  opts?: {
    actor: Actor
    expectedUpdatedAt: number
    expectedAclRevision: number
  },
): Promise<Agent> {
  const existing = await getAgentById(db, id)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', 'agent not found')
  }
  if (input.newName === existing.name) {
    if (opts !== undefined) {
      dbTxSync(db, (tx) => {
        requireAgentMutationRevision(tx, id, opts.actor, opts)
      })
    }
    return existing
  }

  // Every live/frozen reference is id-canonical, so rename changes display
  // metadata only. It must not be blocked by references that continue to point
  // at this exact row.
  try {
    dbTxSync(db, (tx) => {
      // Canonical-id fence: the row selected by the URL cannot be retargeted by
      // a concurrent rename.
      const current =
        opts === undefined
          ? tx.select().from(agents).where(eq(agents.id, id)).get()
          : requireAgentMutationRevision(tx, id, opts.actor, opts)
      if (current === undefined) throw new NotFoundError('agent-not-found', 'agent not found')

      const collision = tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          ownerScopedNameWhere(
            agents.ownerUserId,
            agents.name,
            current.ownerUserId,
            input.newName,
            { column: agents.id, id },
          ),
        )
        .get()
      if (collision !== undefined) {
        throw new ConflictError('agent-name-in-use', `agent '${input.newName}' already exists`)
      }

      const result = tx
        .update(agents)
        .set({ name: input.newName, updatedAt: Math.max(Date.now(), current.updatedAt + 1) })
        .where(
          opts === undefined
            ? eq(agents.id, id)
            : and(
                eq(agents.id, id),
                eq(agents.updatedAt, opts.expectedUpdatedAt),
                eq(agents.aclRevision, opts.expectedAclRevision),
              ),
        )
        .run()
      if (changesOf(result) !== 1) throw staleAgentError(id)
    })
  } catch (error) {
    if (isOwnerNameUniqueViolation(error, 'agents', 'agents_owner_name_unique')) {
      throw new ConflictError('agent-name-in-use', `agent '${input.newName}' already exists`)
    }
    throw error
  }

  const renamed = await getAgentById(db, id)
  if (renamed === null) throw new Error('agent disappeared after rename')
  return renamed
}

/**
 * Find every workflow whose definition.nodes[].agentId matches.
 * Stable identity for the "referenced by" delete guard.
 */
/**
 * RFC-223: scheduled agent targets are canonical ids. Delete refuses while an
 * id-targeted row remains; rename is safe because the id does not change.
 */
function scheduledRowsReferencingAgent(
  rows: ReadonlyArray<{ id: string; launchKind: string; launchPayload: string }>,
  target: { id: string },
): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (row.launchKind !== 'agent') continue
    try {
      const p = JSON.parse(row.launchPayload) as { agentId?: unknown }
      if (p.agentId === target.id) out.push(row.id)
    } catch {
      /* degraded rows are repaired/deleted via their own flow */
    }
  }
  return out
}

function requireAgentMutationRevision(
  tx: DbTxSync,
  id: string,
  actor: Actor,
  expected: { expectedUpdatedAt: number; expectedAclRevision: number },
): AgentRow {
  const current = tx.select().from(agents).where(eq(agents.id, id)).get()
  if (current === undefined) {
    throw new NotFoundError('agent-not-found', 'agent not found')
  }

  const isAdmin = isResourceAdminActor(actor)
  const isOwner = current.ownerUserId !== null && current.ownerUserId === actor.user.id
  let visible = isAdmin || isOwner || current.visibility === 'public'
  if (!visible) {
    visible =
      tx
        .select({ resourceId: resourceGrants.resourceId })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.resourceType, 'agent'),
            eq(resourceGrants.resourceId, current.id),
            eq(resourceGrants.userId, actor.user.id),
          ),
        )
        .get() !== undefined
  }
  if (!visible) throw new NotFoundError('agent-not-found', 'agent not found')
  if (!isAdmin && !isOwner) {
    throw new ForbiddenError('forbidden', 'only the agent owner or a resource admin can modify it')
  }
  if (
    current.updatedAt !== expected.expectedUpdatedAt ||
    current.aclRevision !== expected.expectedAclRevision
  ) {
    throw staleAgentError(id)
  }
  return current
}

function changesOf(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}

function staleAgentError(id: string): ConflictError {
  return new ConflictError('resource-operation-stale', `agent '${id}' changed; reload and retry`)
}

/** Pure core of the workflow-reference check — RFC-165 (F17-r3): the
 *  rename/delete guards run it on rows read INSIDE their dbTxSync
 *  transaction (the old async shell around it died with them). */
function workflowsUsingAgentIn(
  rows: ReadonlyArray<{ id: string; name: string; definition: string }>,
  agentId: string,
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = []
  for (const row of rows) {
    try {
      const def = JSON.parse(row.definition) as {
        nodes?: Array<{ agentId?: string }>
      }
      const used = def.nodes?.some((n) => n.agentId === agentId) ?? false
      if (used) out.push({ id: row.id, name: row.name })
    } catch {
      // Skip malformed JSON; workflow validator catches it on save in P-2-01.
    }
  }
  return out
}

/**
 * RFC-022: tolerate legacy rows whose depends_on column is missing or holds a
 * non-array JSON value (e.g. from manual SQL edits). Parse failure or
 * non-array → []. Filter to strings so downstream code never panics on `null`
 * entries.
 */
function parseDependsOnColumn(value: string | null | undefined): string[] {
  return parseStringArrayColumn(value)
}

/**
 * RFC-028: assert every MCP name in the agent's `mcp[]` array maps to an
 * existing mcps row. Empty input is a no-op. Throws `mcp-not-found` (422)
 * with the list of missing names so the UI can surface them inline.
 */
/**
 * RFC-111 (Codex audit F6): assert a pinned runtime NAME maps to an existing
 * runtimes row. null/undefined = "inherit config.defaultRuntime", a no-op. Throws
 * `runtime-not-found` (422) — without it an unknown/typo name saves as a pin but
 * silently falls back to built-in opencode at dispatch (resolveAgentRuntime), a
 * hard-to-detect runtime + generation-profile drift (the F6 import widened the
 * exposure: agent.md authors can now pin arbitrary names).
 */
async function validateRuntimeReference(
  db: DbClient,
  name: string | null | undefined,
  previous?: string | null,
): Promise<void> {
  if (name === null || name === undefined) return
  const row = await getRuntime(db, name)
  if (row === null) {
    throw new ValidationError('runtime-not-found', `agent references unknown runtime: ${name}`, {
      notFound: [name],
    })
  }
  // RFC-118: a runtime can be disabled (kept in the list but hidden from pickers).
  // A NEW pin (changed from `previous`) must target an ENABLED runtime; KEEPING an
  // already-pinned, now-disabled runtime is allowed so editing the agent's OTHER
  // fields isn't blocked (D6 — mirrors RFC-099 "only validate NEW refs").
  if (!row.enabled && name !== (previous ?? undefined)) {
    throw new ValidationError(
      'runtime-disabled',
      `agent references disabled runtime: ${name}; enable it or pick another`,
      { disabled: [name] },
    )
  }
}

// RFC-223 (PR-1): references are stored + validated BY ID. Callers resolve
// id-or-name → id (services/agentRefs.ts) before this guard; an entry that is
// still a name here never matched a row and is reported as missing.
async function validateMcpReferences(db: DbClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const unique = Array.from(new Set(ids))
  const rows = await db.select({ id: mcps.id }).from(mcps).where(inArray(mcps.id, unique))
  const known = new Set(rows.map((r) => r.id))
  const missing = unique.filter((n) => !known.has(n))
  if (missing.length > 0) {
    throw new ValidationError(
      'mcp-not-found',
      `agent references unknown mcp(s): ${missing.join(', ')}`,
      { notFound: missing },
    )
  }
}

/**
 * RFC-031: assert every plugin name in the agent's `plugins[]` array maps
 * to an existing + enabled plugins row. Empty input is a no-op. Throws
 * `plugin-not-found` (422) with the missing names, or `plugin-disabled` (422)
 * when a referenced plugin exists but has `enabled=false`.
 */
async function validatePluginReferences(db: DbClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const unique = Array.from(new Set(ids))
  const rows = await db
    .select({ id: plugins.id, enabled: plugins.enabled })
    .from(plugins)
    .where(inArray(plugins.id, unique))
  const enabledSet = new Set<string>()
  const disabledSet = new Set<string>()
  for (const r of rows) {
    if (r.enabled) enabledSet.add(r.id)
    else disabledSet.add(r.id)
  }
  const missing = unique.filter((n) => !enabledSet.has(n) && !disabledSet.has(n))
  if (missing.length > 0) {
    throw new ValidationError(
      'plugin-not-found',
      `agent references unknown plugin(s): ${missing.join(', ')}`,
      { notFound: missing },
    )
  }
  const disabled = unique.filter((n) => disabledSet.has(n))
  if (disabled.length > 0) {
    throw new ValidationError(
      'plugin-disabled',
      `agent references disabled plugin(s): ${disabled.join(', ')}`,
      { disabled },
    )
  }
}

/**
 * RFC-223 (PR-1): parse the `agents.skills` typed-ref column into
 * `AgentSkillRef[]`, dropping any entry that does not match the discriminated
 * union (same lenient stance as the other columns — a hand-edited / legacy row
 * never crashes downstream). Post-migration every entry is a managed{skillId} or
 * project{name} object; pre-migration rows are migrated by 0111.
 */
function parseSkillRefsColumn(value: string | null | undefined): AgentSkillRef[] {
  if (value === null || value === undefined || value === '') return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    const out: AgentSkillRef[] = []
    for (const entry of parsed) {
      const ref = AgentSkillRefSchema.safeParse(entry)
      if (ref.success) out.push(ref.data)
    }
    return out
  } catch {
    return []
  }
}

/** RFC-223 (PR-1): canonical JSON for the `agents.skills` typed-ref column. */
function serializeSkillRefs(refs: readonly AgentSkillRef[]): string {
  return JSON.stringify(refs)
}

/**
 * RFC-028: same lenient parser pattern as dependsOn — used for the `mcp`
 * column. Any non-string entries or parse errors collapse to `[]` so a row
 * with a hand-edited corrupt column never crashes downstream code.
 */
function parseStringArrayColumn(value: string | null | undefined): string[] {
  if (value === null || value === undefined || value === '') return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/** RFC-166 — parse the agents.inputs JSON column, dropping malformed rows. */
function parseInputsColumn(value: string | null | undefined): AgentInputPort[] {
  if (value === null || value === undefined || value === '') return []
  try {
    const parsed = AgentInputPortSchema.array().safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** RFC-166 — canonicalize declared input ports for the agents.inputs column:
 *  apply the `kind` default, strip unknown keys, and REJECT duplicate port
 *  names (persistence guard mirroring the DTO — port name is an identity key),
 *  so the stored JSON is identical whether or not the caller pre-parsed through
 *  CreateAgentSchema. Throws a ZodError on a dupe from a service-layer caller
 *  that bypassed the route's CreateAgentSchema validation. */
function serializeInputs(inputs: AgentInputPort[] | undefined): string {
  return JSON.stringify(AgentInputPortsSchema.parse(inputs ?? []))
}

function rowToAgent(row: AgentRow): Agent {
  const fmExtra = JSON.parse(row.frontmatterExtra) as Record<string, unknown>
  // RFC-005: lift outputKinds back out of frontmatter_extra into a top-level
  // property on the Agent DTO so consumers (review validator, scheduler,
  // frontend AgentForm) see it without poking into nested JSON.
  //
  // RFC-060 PR-B: outputKinds value can now be any string that passes the
  // shared kind grammar (path<md>, list<string>, signal, …). The PR-A
  // grammar accepts the legacy 'string' / 'markdown' / 'markdown_file'
  // literals so round-trip is byte-identical for pre-RFC-060 agents.
  // PR-D will swap downstream consumers over to parseKind; this filter
  // is intentionally permissive — anything passing the grammar lands
  // back on the Agent DTO and the downstream validator surfaces any
  // unregistered base names.
  let outputKinds: Agent['outputKinds'] | undefined
  if (
    fmExtra.outputKinds !== undefined &&
    fmExtra.outputKinds !== null &&
    typeof fmExtra.outputKinds === 'object'
  ) {
    outputKinds = {} as Agent['outputKinds']
    for (const [port, kind] of Object.entries(fmExtra.outputKinds as Record<string, unknown>)) {
      if (typeof kind === 'string' && kind.length > 0) {
        ;(outputKinds as Record<string, string>)[port] = kind
      }
    }
  }

  // RFC-060 PR-B: lift role + outputWrapperPortNames out of frontmatter_extra
  // following the same pattern. `role` is optional on the Agent DTO; we only
  // set it when it's not the default 'normal' so callers that don't care
  // about RFC-060 see byte-identical Agent objects pre-vs-post-RFC-060.
  let role: Agent['role'] | undefined
  if (fmExtra.role === 'aggregator') {
    role = 'aggregator'
  }
  let outputWrapperPortNames: Agent['outputWrapperPortNames'] | undefined
  if (
    fmExtra.outputWrapperPortNames !== undefined &&
    fmExtra.outputWrapperPortNames !== null &&
    typeof fmExtra.outputWrapperPortNames === 'object'
  ) {
    outputWrapperPortNames = {} as Agent['outputWrapperPortNames']
    for (const [port, wrapperName] of Object.entries(
      fmExtra.outputWrapperPortNames as Record<string, unknown>,
    )) {
      if (typeof wrapperName === 'string' && wrapperName.length > 0) {
        ;(outputWrapperPortNames as Record<string, string>)[port] = wrapperName
      }
    }
  }

  const exposedFm = { ...fmExtra }
  delete (exposedFm as Record<string, unknown>).outputKinds
  delete (exposedFm as Record<string, unknown>).role
  delete (exposedFm as Record<string, unknown>).outputWrapperPortNames

  const agent: Agent = {
    id: row.id,
    name: row.name,
    description: row.description,
    outputs: JSON.parse(row.outputs) as string[],
    inputs: parseInputsColumn(row.inputs), // RFC-166
    syncOutputsOnIterate: row.syncOutputsOnIterate,
    permission: JSON.parse(row.permission) as Record<string, unknown>,
    skills: parseSkillRefsColumn(row.skills), // RFC-223 (PR-1): typed refs
    dependsOn: parseDependsOnColumn(row.dependsOn),
    mcp: parseStringArrayColumn(row.mcp),
    plugins: parseStringArrayColumn(row.plugins),
    frontmatterExtra: exposedFm,
    bodyMd: row.bodyMd,
    // RFC-099 ACL projection — routes filter on these.
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    aclRevision: row.aclRevision,
    // RFC-104 built-in marker (read-only response field).
    builtin: row.builtin,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (outputKinds !== undefined) agent.outputKinds = outputKinds
  if (role !== undefined) agent.role = role
  if (outputWrapperPortNames !== undefined) {
    agent.outputWrapperPortNames = outputWrapperPortNames
  }
  // RFC-111 / RFC-112: map the runtime column — now any registered runtime NAME
  // (built-ins 'opencode'/'claude-code' + custom). Empty/NULL stays absent (→
  // inherit config.defaultRuntime). An unknown name fail-safes at dispatch.
  if (typeof row.runtime === 'string' && row.runtime.length > 0) agent.runtime = row.runtime
  return agent
}
