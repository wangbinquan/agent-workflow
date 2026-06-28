// Agent service — CRUD on the agents table.
// JSON fields (outputs / skills / permission / frontmatterExtra) are stored as
// strings in the DB and (un)marshaled at this boundary. Routes upstream see
// pure JS objects.

import type { Agent, CreateAgent, RenameAgent, UpdateAgent } from '@agent-workflow/shared'
import { eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, mcps, plugins, workflows } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { findAgentsDependingOn, validateDependsOn } from './agentDeps'
import { getRuntime } from './runtimeRegistry'

type AgentRow = typeof agents.$inferSelect

export async function listAgents(db: DbClient): Promise<Agent[]> {
  const rows = await db.select().from(agents)
  return rows.map(rowToAgent)
}

export async function getAgent(db: DbClient, name: string): Promise<Agent | null> {
  const rows = await db.select().from(agents).where(eq(agents.name, name)).limit(1)
  const row = rows[0]
  return row ? rowToAgent(row) : null
}

export async function createAgent(
  db: DbClient,
  input: CreateAgent,
  opts?: { ownerUserId?: string; builtin?: boolean },
): Promise<Agent> {
  const existing = await getAgent(db, input.name)
  if (existing !== null) {
    throw new ConflictError('agent-name-in-use', `agent '${input.name}' already exists`)
  }

  // RFC-022 save-time guard: not-found / self-ref / cycle all throw a 400
  // DomainError with the corresponding code. Runs *before* the insert so
  // partially-validated rows never land in the DB.
  await validateDependsOn(db, input.name, input.dependsOn)

  // RFC-028 save-time guard: every `mcp[]` entry must resolve to an existing
  // mcps row. Without this, agents save successfully but fail at runtime when
  // the scheduler tries to load the row (or worse, succeeds with a partial
  // closure that silently drops the missing reference).
  await validateMcpReferences(db, input.mcp)

  // RFC-031: every entry in input.plugins must point at an existing + enabled
  // plugins row. Failure here surfaces as 422 plugin-not-found / -disabled.
  await validatePluginReferences(db, input.plugins ?? [])

  // RFC-111 (Codex audit F6): a pinned runtime NAME must resolve to an existing
  // runtimes row. Without this, an agent.md import / API call can pin an unknown
  // or typo'd runtime (e.g. `claude_code`) that saves fine but silently falls back
  // to built-in opencode at dispatch — a hard-to-detect runtime/profile drift.
  await validateRuntimeReference(db, input.runtime)

  const id = ulid()
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
  await db.insert(agents).values({
    id,
    name: input.name,
    description: input.description,
    outputs: JSON.stringify(input.outputs),
    readonly: input.readonly,
    syncOutputsOnIterate: input.syncOutputsOnIterate,
    runtime: input.runtime ?? null, // RFC-111
    permission: JSON.stringify(input.permission),
    skills: JSON.stringify(input.skills),
    dependsOn: JSON.stringify(dedupePreservingOrder(input.dependsOn)),
    mcp: JSON.stringify(dedupePreservingOrder(input.mcp)),
    // RFC-031: plugin name array; T6 enforces existence + enabled at save
    // time, T7 unions across the dependsOn closure at runner injection time.
    plugins: JSON.stringify(dedupePreservingOrder(input.plugins ?? [])),
    frontmatterExtra: JSON.stringify(fmExtra),
    bodyMd: input.bodyMd,
    // RFC-099: creator becomes owner; new resources default to 'public' (D18).
    ownerUserId: opts?.ownerUserId ?? null,
    visibility: 'public',
    // RFC-104: built-in marker — only seedFusionResources passes builtin:true;
    // never set via any HTTP path (CreateAgentSchema omits it).
    builtin: opts?.builtin ?? false,
    createdAt: now,
    updatedAt: now,
  })

  const created = await getAgent(db, input.name)
  if (created === null) throw new Error('agent disappeared right after insert')
  return created
}

export async function updateAgent(db: DbClient, name: string, patch: UpdateAgent): Promise<Agent> {
  const existing = await getAgent(db, name)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', `agent '${name}' not found`)
  }

  // RFC-022 save-time guard — only when the caller actually patched dependsOn.
  // PATCH that doesn't touch the field keeps the existing closure validity.
  if (patch.dependsOn !== undefined) {
    await validateDependsOn(db, name, patch.dependsOn)
  }

  // RFC-028 save-time guard — only when caller patched mcp.
  if (patch.mcp !== undefined) {
    await validateMcpReferences(db, patch.mcp)
  }

  // RFC-031 save-time guard — only when caller patched plugins.
  if (patch.plugins !== undefined) {
    await validatePluginReferences(db, patch.plugins)
  }

  // RFC-111 (Codex audit F6): same guard for a patched runtime pin — a NAME must
  // resolve to an existing runtimes row (null = clear to inherit, skips the check).
  // RFC-118: pass the existing pin so re-saving an already-pinned (now-disabled)
  // runtime is allowed (D6); only a CHANGED pin must target an enabled runtime.
  if (patch.runtime !== undefined) {
    await validateRuntimeReference(db, patch.runtime, existing.runtime)
  }

  const set: Partial<typeof agents.$inferInsert> = { updatedAt: Date.now() }
  if (patch.description !== undefined) set.description = patch.description
  if (patch.outputs !== undefined) set.outputs = JSON.stringify(patch.outputs)
  if (patch.readonly !== undefined) set.readonly = patch.readonly
  if (patch.syncOutputsOnIterate !== undefined)
    set.syncOutputsOnIterate = patch.syncOutputsOnIterate
  if (patch.permission !== undefined) set.permission = JSON.stringify(patch.permission)
  // RFC-115 round-trip fix: actually persist the runtime column. A registry NAME
  // pins; null clears back to inherit (config.defaultRuntime); undefined leaves it
  // untouched (sparse-patch). Before this branch the set-builder skipped runtime
  // entirely, so the edit form could neither repoint nor un-pin an agent.
  if (patch.runtime !== undefined) set.runtime = patch.runtime
  if (patch.skills !== undefined) set.skills = JSON.stringify(patch.skills)
  if (patch.dependsOn !== undefined)
    set.dependsOn = JSON.stringify(dedupePreservingOrder(patch.dependsOn))
  if (patch.mcp !== undefined) set.mcp = JSON.stringify(dedupePreservingOrder(patch.mcp))
  if (patch.plugins !== undefined)
    set.plugins = JSON.stringify(dedupePreservingOrder(patch.plugins))
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
      const fresh = await getAgent(db, name)
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

  await db.update(agents).set(set).where(eq(agents.name, name))
  const updated = await getAgent(db, name)
  if (updated === null) throw new Error('agent disappeared after update')
  return updated
}

export async function deleteAgent(db: DbClient, name: string): Promise<void> {
  const existing = await getAgent(db, name)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', `agent '${name}' not found`)
  }
  const refs = await findWorkflowsUsingAgent(db, name)
  if (refs.length > 0) {
    throw new ConflictError('agent-in-use', `agent '${name}' is referenced by workflows`, {
      workflows: refs,
    })
  }
  // RFC-022 reverse-dep guard: refuse to delete an agent any other agent's
  // dependsOn closure mentions. Forces the caller to deref upstream first so
  // runtime never spawns with a dangling reference (which would surface as
  // a node failure with `agent-dependency-not-found`).
  const dependents = await findAgentsDependingOn(db, name)
  if (dependents.length > 0) {
    throw new ConflictError(
      'agent-dependency-still-referenced',
      `agent '${name}' is referenced by other agents' dependsOn`,
      { referencedBy: dependents },
    )
  }
  await db.delete(agents).where(eq(agents.name, name))
}

export async function renameAgent(
  db: DbClient,
  oldName: string,
  input: RenameAgent,
): Promise<Agent> {
  const existing = await getAgent(db, oldName)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', `agent '${oldName}' not found`)
  }
  if (input.newName === oldName) return existing

  const refs = await findWorkflowsUsingAgent(db, oldName)
  if (refs.length > 0) {
    throw new ConflictError(
      'agent-in-use',
      `agent '${oldName}' is referenced by workflows; cannot rename`,
      { workflows: refs },
    )
  }

  // RFC-022 reverse-dep guard (mirror of deleteAgent). Don't silently rename
  // out from under other agents' dependsOn — the caller must deref first.
  const dependents = await findAgentsDependingOn(db, oldName)
  if (dependents.length > 0) {
    throw new ConflictError(
      'agent-dependency-still-referenced',
      `agent '${oldName}' is referenced by other agents' dependsOn; cannot rename`,
      { referencedBy: dependents },
    )
  }

  const collision = await getAgent(db, input.newName)
  if (collision !== null) {
    throw new ConflictError('agent-name-in-use', `agent '${input.newName}' already exists`)
  }

  await db
    .update(agents)
    .set({ name: input.newName, updatedAt: Date.now() })
    .where(eq(agents.name, oldName))

  const renamed = await getAgent(db, input.newName)
  if (renamed === null) throw new Error('agent disappeared after rename')
  return renamed
}

/**
 * Find every workflow whose definition.nodes[].agentName matches.
 * Stable identity for the "referenced by" check in delete/rename.
 */
async function findWorkflowsUsingAgent(
  db: DbClient,
  agentName: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: workflows.id, name: workflows.name, definition: workflows.definition })
    .from(workflows)

  const out: Array<{ id: string; name: string }> = []
  for (const row of rows) {
    try {
      const def = JSON.parse(row.definition) as {
        nodes?: Array<{ agentName?: string }>
      }
      const used = def.nodes?.some((n) => n.agentName === agentName) ?? false
      if (used) out.push({ id: row.id, name: row.name })
    } catch {
      // Skip malformed JSON; workflow validator catches it on save in P-2-01.
    }
  }
  return out
}

/**
 * RFC-022: de-dup the dependsOn list while preserving the author's listed
 * order. Callers should still rely on zod's max(64) for hard caps; this just
 * stops accidental duplicates from bloating the JSON column.
 */
function dedupePreservingOrder(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
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

async function validateMcpReferences(db: DbClient, names: readonly string[]): Promise<void> {
  if (names.length === 0) return
  const unique = Array.from(new Set(names))
  const rows = await db.select({ name: mcps.name }).from(mcps).where(inArray(mcps.name, unique))
  const known = new Set(rows.map((r) => r.name))
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
async function validatePluginReferences(db: DbClient, names: readonly string[]): Promise<void> {
  if (names.length === 0) return
  const unique = Array.from(new Set(names))
  const rows = await db
    .select({ name: plugins.name, enabled: plugins.enabled })
    .from(plugins)
    .where(inArray(plugins.name, unique))
  const enabledSet = new Set<string>()
  const disabledSet = new Set<string>()
  for (const r of rows) {
    if (r.enabled) enabledSet.add(r.name)
    else disabledSet.add(r.name)
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
    readonly: row.readonly,
    syncOutputsOnIterate: row.syncOutputsOnIterate,
    permission: JSON.parse(row.permission) as Record<string, unknown>,
    skills: JSON.parse(row.skills) as string[],
    dependsOn: parseDependsOnColumn(row.dependsOn),
    mcp: parseStringArrayColumn(row.mcp),
    plugins: parseStringArrayColumn(row.plugins),
    frontmatterExtra: exposedFm,
    bodyMd: row.bodyMd,
    // RFC-099 ACL projection — routes filter on these.
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
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
