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
import { agents, mcps, plugins, scheduledTasks, skills, tasks, workflows } from '@/db/schema'
import { scheduledRowsReferencing } from './scheduledTaskRefs'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
import { agentsDependingOnIn, validateDependsOn } from './agentDeps'
import { agentRefFenceGroups, resolveAgentRefsUsable } from './agentRefs'
import {
  filterVisibleRows,
  assertInitialResourceOwner,
  discloseRefsSync,
  discloseScheduleRefs,
  initialBuiltinResourceAcl,
  initialPrivateResourceAcl,
  canEditAccess,
  canGovernAccess,
  canViewAccess,
  hasResourceAclBypass,
  listGrantedResourceIds,
  resolveResourceAccessForInTx,
} from './resourceAcl'
import type { Actor } from '@/auth/actor'
import { getRuntime } from './runtimeRegistry'
import { isAgentLaunching } from './agentLaunchReservation'
import { isOwnerNameUniqueViolation, ownerScopedNameWhere } from './ownerScopedName'
import { assertRefsUsableInTx } from './resourceRefs'
import { assertAgentResourceIntegrity } from './agentResourceIntegrity'
import { PLUGIN_DISABLED_ERROR_CODE } from './execution/resourcePolicy'
import { monotonicNow } from '@/util/time'
import {
  reconcileCreatedAgentExecutionContractPorts,
  reconcileUpdatedAgentExecutionContractPorts,
} from '@/modules/execution-contract/public/commands'

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
 * Read-only bootstrap/catalog projection for synchronous compositions. Runtime
 * execution continues to use the async resolver above; both share rowToAgent.
 */
export function getAgentByIdSync(db: DbClient, id: string): Agent | null {
  const row = db.select().from(agents).where(eq(agents.id, id)).get()
  return row === undefined ? null : rowToAgent(row)
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

/**
 * RFC-234 (T6) — prepare/commit split of the agent create path. `prepare` runs
 * every pre-transaction validation/resolution (byte-identical to the former
 * createAgent body); `commitAgentCreateInTx` is the former dbTxSync body. The
 * public createAgent composes them, so standalone behavior is unchanged, while
 * the intent apply pipeline can run MANY commits inside ONE transaction
 * (bundle-internal refs pass assertRefsUsableInTx via same-connection
 * uncommitted visibility).
 */
export interface PreparedAgentCreate {
  id: string
  input: CreateAgent
  actor: Actor | null
  builtin: boolean
  initialAcl:
    | ReturnType<typeof initialPrivateResourceAcl>
    | ReturnType<typeof initialBuiltinResourceAcl>
  fmExtra: Record<string, unknown>
  mcpIds: string[]
  pluginIds: string[]
  dependsOnIds: string[]
  skillRefs: AgentSkillRef[]
  matchedManagedSkillIds: ReadonlySet<string>
  now: number
}

export async function prepareAgentCreate(
  db: DbClient,
  input: CreateAgent,
  opts?: {
    ownerUserId?: string
    builtin?: boolean
    actor?: Actor | null
    id?: string
    /** Deterministic race-test seam after preflight, before the final dbTxSync. */
    beforeWriteTransaction?: () => void | Promise<void>
    /**
     * RFC-234 (T6): ids being CREATED in the same intent bundle. They have no
     * rows yet, so the async existence validators skip them (their type
     * correctness is guaranteed by the changeset's typed-ref validation and
     * their EXISTENCE is enforced exactly at commit time —
     * assertRefsUsableInTx sees them in-tx because the bundle transaction
     * creates them earlier in topo order). When any pending ref is present the
     * RFC-228 closure-integrity preflight is skipped for this candidate: the
     * bundle constructs the closure itself and the in-tx fence stays exact.
     */
    pendingBundleIds?: ReadonlySet<string>
  },
): Promise<PreparedAgentCreate> {
  input = reconcileCreatedAgentExecutionContractPorts(input)
  const ownerUserId = opts?.ownerUserId ?? null
  assertInitialResourceOwner(opts?.actor, ownerUserId)
  const initialAcl =
    opts?.builtin === true
      ? initialBuiltinResourceAcl(ownerUserId)
      : initialPrivateResourceAcl(ownerUserId)
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
  // ACL gate. P1-1 preserves an unresolved managed token as managed (never
  // project); RFC-228's complete-candidate check below then rejects it.
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
  const pending = opts?.pendingBundleIds ?? new Set<string>()
  const persistedOnly = (ids: readonly string[]): string[] => ids.filter((x) => !pending.has(x))
  await validateDependsOn(db, id, persistedOnly(dependsOnIds))

  // RFC-028 save-time guard: every `mcp[]` entry must resolve to an existing
  // mcps row. Without this, agents save successfully but fail at runtime when
  // the scheduler tries to load the row (or worse, succeeds with a partial
  // closure that silently drops the missing reference).
  await validateMcpReferences(db, persistedOnly(mcpIds))

  // RFC-031: every entry in input.plugins must point at an existing + enabled
  // plugins row. Failure here surfaces as 422 plugin-not-found / -disabled.
  await validatePluginReferences(db, persistedOnly(pluginIds))

  // RFC-111 (Codex audit F6): a pinned runtime NAME must resolve to an existing
  // runtimes row. Without this, an agent.md import / API call can pin an unknown
  // or typo'd runtime (e.g. `claude_code`) that saves fine but silently falls back
  // to built-in opencode at dispatch — a hard-to-detect runtime/profile drift.
  await validateRuntimeReference(db, input.runtime)
  assertBranchPortsDeclared(input.outputs, input.branchPorts)

  // RFC-228: validate the complete candidate closure, not only the resource
  // fields with legacy per-kind guards. This is the missing managed-Skill gate
  // and also rejects an Agent whose dependent Agent already has a broken
  // Skill/MCP/Plugin/dependency reference.
  const candidate: Agent = {
    ...input,
    id,
    ownerUserId: initialAcl.ownerUserId,
    visibility: initialAcl.visibility,
    ...(opts?.builtin !== undefined ? { builtin: opts.builtin } : {}),
    inputs: input.inputs ?? [],
    skills: skillRefs,
    dependsOn: dependsOnIds,
    mcp: mcpIds,
    plugins: pluginIds,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
  if (pending.size === 0) {
    await assertAgentResourceIntegrity(db, [id], { overrides: [candidate] })
  }

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
  // RFC-306: branch ports ride the same sidecar. Absent stays absent — an agent
  // with no branch ports must keep its fmExtra byte-identical to pre-RFC-306
  // (the `role: 'normal'` precedent above).
  if (input.branchPorts !== undefined) fmExtra.branchPorts = input.branchPorts
  return {
    id,
    input,
    actor: opts?.actor ?? null,
    builtin: opts?.builtin ?? false,
    initialAcl,
    fmExtra,
    mcpIds,
    pluginIds,
    dependsOnIds,
    skillRefs,
    matchedManagedSkillIds: resolved.matchedManagedSkillIds,
    now,
  }
}

/** The former createAgent dbTxSync body, verbatim modulo destructuring. */
export function commitAgentCreateInTx(tx: DbTxSync, p: PreparedAgentCreate): void {
  const { id, input, initialAcl, fmExtra, now, mcpIds, pluginIds, dependsOnIds, skillRefs } = p
  // Every create ref is new. This is the authorization/existence
  // linearization point; async validators in prepare remain preflight only.
  assertRefsUsableInTx(
    tx,
    p.actor,
    agentRefFenceGroups(
      {
        mcp: mcpIds,
        plugins: pluginIds,
        dependsOn: dependsOnIds,
        skills: skillRefs,
      },
      undefined,
      p.matchedManagedSkillIds,
    ),
  )
  tx.insert(agents)
    .values({
      id,
      name: input.name,
      description: input.description,
      outputs: JSON.stringify(input.outputs),
      // RFC-166: declarative input ports (own column, symmetrical to outputs).
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
      // RFC-231: user resources are private; framework built-ins stay public.
      ...initialAcl,
      // RFC-104: built-in marker — only platform-owned seeders pass builtin:true;
      // never set via any HTTP path (CreateAgentSchema omits it).
      builtin: p.builtin,
      createdAt: now,
      updatedAt: now,
    })
    .run()
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
  const prepared = await prepareAgentCreate(db, input, opts)
  await opts?.beforeWriteTransaction?.()
  try {
    dbTxSync(db, (tx) => {
      commitAgentCreateInTx(tx, prepared)
    })
  } catch (error) {
    if (isOwnerNameUniqueViolation(error, 'agents', 'agents_owner_name_unique')) {
      throw new ConflictError('agent-name-in-use', `agent '${input.name}' already exists`)
    }
    throw error
  }
  const created = await getAgentById(db, prepared.id)
  if (created === null) throw new Error('agent disappeared right after insert')
  return created
}

export interface PreparedAgentUpdate {
  id: string
  actor: Actor | null | undefined
  fence: { expectedUpdatedAt: number; expectedAclRevision: number } | undefined
  set: Partial<typeof agents.$inferInsert>
  mcpIds: string[] | undefined
  pluginIds: string[] | undefined
  dependsOnIds: string[] | undefined
  skillRefs: AgentSkillRef[] | undefined
  matchedManagedSkillIds: ReadonlySet<string>
}

export async function prepareAgentUpdate(
  db: DbClient,
  id: string,
  patch: UpdateAgent,
  actor?: Actor | null,
  fence?: { expectedUpdatedAt: number; expectedAclRevision: number },
  hooks?: {
    /** Deterministic race-test seam after preflight, before the final dbTxSync. */
    beforeWriteTransaction?: () => void | Promise<void>
    /** RFC-234 (T6): same-bundle pending ids — see prepareAgentCreate. */
    pendingBundleIds?: ReadonlySet<string>
  },
): Promise<PreparedAgentUpdate> {
  const existing = await getAgentById(db, id)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', 'agent not found')
  }
  patch = reconcileUpdatedAgentExecutionContractPorts(existing, patch)

  // RFC-223 (PR-1, Codex impl-gate P1-2): resolve patched id-or-name refs →
  // canonical ids AND enforce ACL in ONE pass, then store the SAME resolved
  // arrays. Only NEWLY-added references are ACL-checked (D15) — the diff compares
  // RESOLVED IDS against the already-stored ids, so a grandfathered ref
  // re-submitted by name is not mis-flagged as new. undefined patch fields are
  // left untouched. Skill resolution preserves managed identity; RFC-228's
  // merged-candidate check below owns missing-resource rejection.
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
  const pending = hooks?.pendingBundleIds ?? new Set<string>()
  const persistedOnly = (ids: readonly string[]): string[] => ids.filter((x) => !pending.has(x))
  if (dependsOnIds !== undefined) {
    await validateDependsOn(db, existing.id, persistedOnly(dependsOnIds))
  }

  // RFC-028 save-time guard — only when caller patched mcp.
  if (mcpIds !== undefined) {
    await validateMcpReferences(db, persistedOnly(mcpIds))
  }

  // RFC-031 save-time guard — only when caller patched plugins.
  if (pluginIds !== undefined) {
    await validatePluginReferences(db, persistedOnly(pluginIds))
  }

  // RFC-111 (Codex audit F6): same guard for a patched runtime pin — a NAME must
  // resolve to an existing runtimes row (null = clear to inherit, skips the check).
  // RFC-118: pass the existing pin so re-saving an already-pinned (now-disabled)
  // runtime is allowed (D6); only a CHANGED pin must target an enabled runtime.
  if (patch.runtime !== undefined) {
    await validateRuntimeReference(db, patch.runtime, existing.runtime)
  }
  // RFC-306: validate the MERGED pair, not just the patched half. Patching only
  // `outputs` (dropping a port that `branchPorts` still names) leaves exactly the
  // dangling sidecar this guard exists to prevent, and a patch that touches
  // neither must stay valid.
  if (patch.outputs !== undefined || patch.branchPorts !== undefined) {
    assertBranchPortsDeclared(
      patch.outputs ?? existing.outputs,
      patch.branchPorts ?? existing.branchPorts,
    )
  }

  // RFC-228: sparse PATCHes cannot leave a historically dangling closure
  // hidden behind "the resource field was not touched". Validate the merged
  // final Agent; removing/replacing the bad ref makes this pass. Runtime is
  // removed from the spread because null means "clear the pin", not a DTO value.
  const { runtime: _runtimePatch, ...patchWithoutRuntime } = patch
  const candidate: Agent = {
    ...existing,
    ...patchWithoutRuntime,
    skills: skillRefs ?? existing.skills,
    dependsOn: dependsOnIds ?? existing.dependsOn,
    mcp: mcpIds ?? existing.mcp,
    plugins: pluginIds ?? existing.plugins,
  }
  if (patch.runtime === null) delete candidate.runtime
  else if (patch.runtime !== undefined) candidate.runtime = patch.runtime
  if (pending.size === 0) {
    await assertAgentResourceIntegrity(db, [candidate.id], { overrides: [candidate] })
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
    patch.outputWrapperPortNames !== undefined ||
    // RFC-306: branchPorts joins the sidecar family — a patch touching only it
    // must still trigger the merge, or the write silently drops.
    patch.branchPorts !== undefined
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
        if (fresh.branchPorts !== undefined && patch.branchPorts === undefined) {
          ;(baseFm as Record<string, unknown>).branchPorts = fresh.branchPorts
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
    if (patch.branchPorts !== undefined) {
      // Empty array = "this agent has no branch ports": drop the key entirely so
      // the row goes back to the pre-RFC-306 shape instead of carrying `[]`.
      if (patch.branchPorts.length === 0) {
        delete (baseFm as Record<string, unknown>).branchPorts
      } else {
        ;(baseFm as Record<string, unknown>).branchPorts = patch.branchPorts
      }
    }
    set.frontmatterExtra = JSON.stringify(baseFm)
  }
  if (patch.bodyMd !== undefined) set.bodyMd = patch.bodyMd

  return {
    id,
    actor,
    fence,
    set,
    mcpIds,
    pluginIds,
    dependsOnIds,
    skillRefs,
    matchedManagedSkillIds: resolvedRefs.matchedManagedSkillIds,
  }
}

/** The former updateAgent dbTxSync body, verbatim modulo destructuring. */
export function commitAgentUpdateInTx(tx: DbTxSync, p: PreparedAgentUpdate): void {
  const { id, actor, fence, set, mcpIds, pluginIds, dependsOnIds, skillRefs } = p
  const resolvedRefs = { matchedManagedSkillIds: p.matchedManagedSkillIds }
  const revisionFenced = fence !== undefined && actor !== undefined && actor !== null
  const currentRow = revisionFenced
    ? requireAgentMutationRevision(tx, id, actor, fence, 'edit')
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

  set.updatedAt = monotonicNow(currentRow.updatedAt)
  const where = revisionFenced
    ? and(
        eq(agents.id, id),
        eq(agents.updatedAt, fence.expectedUpdatedAt),
        eq(agents.aclRevision, fence.expectedAclRevision),
      )
    : eq(agents.id, id)
  const result = tx.update(agents).set(set).where(where).run()
  if (revisionFenced && changesOf(result) !== 1) throw staleAgentError(id)
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
  const prepared = await prepareAgentUpdate(db, id, patch, actor, fence, hooks)
  await hooks?.beforeWriteTransaction?.()
  dbTxSync(db, (tx) => {
    commitAgentUpdateInTx(tx, prepared)
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
  const wfGranted = hasResourceAclBypass(actor)
    ? new Set<string>()
    : await listGrantedResourceIds(db, actor, 'workflow')
  const agGranted = hasResourceAclBypass(actor)
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
      requireAgentMutationRevision(tx, id, actor, fence, 'govern')
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
    // RFC-285 B2 档位说明：agent 对**任务**引用零检查即是统一中档——任务快照
    // 冻结（workflowSnapshot/agent 定义随任务落盘），删除 agent 不影响在跑或
    // 历史任务，展示层容忍悬空 agent 名。此处的 agent-in-use 挡的是 **workflow
    // 定义**引用（活的编辑面），与任务引用中档是两回事。
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
    // RFC-284 T9（§2.2）：本地副本收编 scheduledTasks.scheduledRowsReferencing。
    const schedRefRows = scheduledRowsReferencing(schedRows, {
      launchKind: 'agent',
      payloadKey: 'agentId',
      id: existing.id,
    })
    if (schedRefRows.length > 0) {
      throw new ConflictError(
        'agent-scheduled-referenced',
        `agent '${name}' is the target of ${schedRefRows.length} scheduled task(s); delete or repoint them first`,
        discloseScheduleRefs(actor, schedRefRows),
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
        requireAgentMutationRevision(tx, id, opts.actor, opts, 'govern')
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
          : requireAgentMutationRevision(tx, id, opts.actor, opts, 'govern')
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
        .set({ name: input.newName, updatedAt: monotonicNow(current.updatedAt) })
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
function requireAgentMutationRevision(
  tx: DbTxSync,
  id: string,
  actor: Actor,
  expected: { expectedUpdatedAt: number; expectedAclRevision: number },
  // RFC-324 —— 这道 in-tx 门服务三个调用方，而它们不再同档：内容更新是 `edit`，
  // 删除与改名是 `govern`。参数是必填的：加默认值等于给未来的第四个调用方一个
  // 「不想就不填」的选项，而这里恰恰是最不该猜的地方。
  need: 'edit' | 'govern',
): AgentRow {
  const current = tx.select().from(agents).where(eq(agents.id, id)).get()
  if (current === undefined) {
    throw new NotFoundError('agent-not-found', 'agent not found')
  }

  // RFC-282/RFC-305/RFC-324 — 可见性与档位来自同一次判定；错误顺序
  // （404 先于 403 先于 stale）是路由契约的一部分。
  const access = resolveResourceAccessForInTx(tx, actor, 'agent', current)
  if (!canViewAccess(access)) {
    throw new NotFoundError('agent-not-found', 'agent not found')
  }
  if (need === 'edit' ? !canEditAccess(access) : !canGovernAccess(access)) {
    throw need === 'edit'
      ? new ForbiddenError(
          'resource-read-only',
          'you have read-only access to this agent; ask its owner for an edit grant or make your own copy',
        )
      : new ForbiddenError(
          'resource-govern-owner-only',
          'deleting, renaming, transferring or re-granting an agent is reserved for its owner',
        )
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
  // RFC-285 B5：家族先行站点收编 staleConflictError（补 resource 字段）。
  return staleConflictError('agent', `agent '${id}' changed; reload and retry`)
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
/**
 * RFC-306 (design-gate P2#14) — `branchPorts` must name real `outputs`.
 *
 * The sidecar is a second list of port names, so it can drift from the real
 * declaration set. A stray entry (`branchPorts: ['need_fixx']`) is invisible in
 * the editor and produces no error until run time, when the agent marks the
 * REAL port inactive and gets a `branch-port-not-declared` rejection that names
 * a port the author is certain they declared. Failing at save time keeps the two
 * lists honest — the same rule the script node gets for free by carrying
 * `branch` on the port object itself.
 */
function assertBranchPortsDeclared(
  outputs: readonly string[] | undefined,
  branchPorts: readonly string[] | undefined,
): void {
  if (branchPorts === undefined || branchPorts.length === 0) return
  const declared = new Set(outputs ?? [])
  const unknown = branchPorts.filter((p) => !declared.has(p))
  if (unknown.length > 0) {
    throw new ValidationError(
      'branch-port-not-declared',
      `agent branchPorts reference undeclared output port(s): ${unknown.join(', ')}`,
      { notFound: unknown },
    )
  }
}

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
      PLUGIN_DISABLED_ERROR_CODE,
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

export function rowToAgent(row: AgentRow): Agent {
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

  // RFC-306: branch ports lift out the same way. Only well-formed non-empty
  // string entries survive; an empty / malformed list leaves the field absent so
  // downstream reads (`agent.branchPorts ?? []`) see "no branch ports" rather
  // than a half-parsed one — a bogus entry must never widen what may be closed.
  let branchPorts: Agent['branchPorts'] | undefined
  if (Array.isArray(fmExtra.branchPorts)) {
    const names = (fmExtra.branchPorts as unknown[]).filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    )
    if (names.length > 0) branchPorts = names
  }

  const exposedFm = { ...fmExtra }
  delete (exposedFm as Record<string, unknown>).outputKinds
  delete (exposedFm as Record<string, unknown>).role
  delete (exposedFm as Record<string, unknown>).outputWrapperPortNames
  delete (exposedFm as Record<string, unknown>).branchPorts

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
  if (branchPorts !== undefined) agent.branchPorts = branchPorts
  // RFC-111 / RFC-112: map the runtime column — now any registered runtime NAME
  // (built-ins 'opencode'/'claude-code' + custom). Empty/NULL stays absent (→
  // inherit config.defaultRuntime). An unknown name fail-safes at dispatch.
  if (typeof row.runtime === 'string' && row.runtime.length > 0) agent.runtime = row.runtime
  return agent
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC-284 T25（§4，审计 N10）——闭包引用名投影自 routes/agents.ts 下沉：
// 纯读模型（ids → 可见行 display name 映射），路由只剩装配。原文迁入：
// ─────────────────────────────────────────────────────────────────────────────

export interface ClosureRefNameMaps {
  skill: Map<string, string>
  mcp: Map<string, string>
  plugin: Map<string, string>
}

/**
 * RFC-223 (PR-1, Codex impl-gate P2-1): load display NAMES for the managed
 * skill / mcp / plugin IDS referenced anywhere in the closure, so the wire
 * projection shows names, not raw ULIDs. Unresolvable ids (deleted out-of-band)
 * fall back to the id (best-effort, never silently dropped).
 */
export async function loadClosureRefNames(
  db: DbClient,
  actor: Actor,
  closure: Agent[],
  visibleAgentIds: ReadonlySet<string>,
): Promise<ClosureRefNameMaps> {
  const skillIds = new Set<string>()
  const mcpIds = new Set<string>()
  const pluginIds = new Set<string>()
  for (const a of closure) {
    if (!visibleAgentIds.has(a.id)) continue
    for (const ref of a.skills) if (ref.kind === 'managed') skillIds.add(ref.skillId)
    for (const id of a.mcp ?? []) mcpIds.add(id)
    for (const id of a.plugins ?? []) pluginIds.add(id)
  }
  const [skillRows, mcpRows, pluginRows] = await Promise.all([
    skillIds.size > 0
      ? db
          .select({
            id: skills.id,
            name: skills.name,
            ownerUserId: skills.ownerUserId,
            visibility: skills.visibility,
          })
          .from(skills)
          .where(inArray(skills.id, [...skillIds]))
      : Promise.resolve([]),
    mcpIds.size > 0
      ? db
          .select({
            id: mcps.id,
            name: mcps.name,
            ownerUserId: mcps.ownerUserId,
            visibility: mcps.visibility,
          })
          .from(mcps)
          .where(inArray(mcps.id, [...mcpIds]))
      : Promise.resolve([]),
    pluginIds.size > 0
      ? db
          .select({
            id: plugins.id,
            name: plugins.name,
            ownerUserId: plugins.ownerUserId,
            visibility: plugins.visibility,
          })
          .from(plugins)
          .where(inArray(plugins.id, [...pluginIds]))
      : Promise.resolve([]),
  ])
  const [visibleSkills, visibleMcps, visiblePlugins] = await Promise.all([
    filterVisibleRows(db, actor, 'skill', skillRows),
    filterVisibleRows(db, actor, 'mcp', mcpRows),
    filterVisibleRows(db, actor, 'plugin', pluginRows),
  ])
  return {
    skill: new Map(visibleSkills.map((r) => [r.id, r.name])),
    mcp: new Map(visibleMcps.map((r) => [r.id, r.name])),
    plugin: new Map(visiblePlugins.map((r) => [r.id, r.name])),
  }
}
