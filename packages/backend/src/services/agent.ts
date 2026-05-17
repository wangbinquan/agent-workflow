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

export async function createAgent(db: DbClient, input: CreateAgent): Promise<Agent> {
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

  const id = ulid()
  const now = Date.now()
  // RFC-005: outputKinds is a sidecar map ported through `frontmatter_extra`
  // (under reserved key `outputKinds`) until a dedicated column is needed.
  // services/review.ts:loadUpstreamPortKind reads from the same place.
  const fmExtra = { ...input.frontmatterExtra } as Record<string, unknown>
  if (input.outputKinds !== undefined) fmExtra.outputKinds = input.outputKinds
  await db.insert(agents).values({
    id,
    name: input.name,
    description: input.description,
    outputs: JSON.stringify(input.outputs),
    readonly: input.readonly,
    syncOutputsOnIterate: input.syncOutputsOnIterate,
    model: input.model ?? null,
    variant: input.variant ?? null,
    temperature: input.temperature ?? null,
    permission: JSON.stringify(input.permission),
    steps: input.steps ?? null,
    maxSteps: input.maxSteps ?? null,
    skills: JSON.stringify(input.skills),
    dependsOn: JSON.stringify(dedupePreservingOrder(input.dependsOn)),
    mcp: JSON.stringify(dedupePreservingOrder(input.mcp)),
    // RFC-031: plugin name array; T6 enforces existence + enabled at save
    // time, T7 unions across the dependsOn closure at runner injection time.
    plugins: JSON.stringify(dedupePreservingOrder(input.plugins ?? [])),
    frontmatterExtra: JSON.stringify(fmExtra),
    bodyMd: input.bodyMd,
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

  const set: Partial<typeof agents.$inferInsert> = { updatedAt: Date.now() }
  if (patch.description !== undefined) set.description = patch.description
  if (patch.outputs !== undefined) set.outputs = JSON.stringify(patch.outputs)
  if (patch.readonly !== undefined) set.readonly = patch.readonly
  if (patch.syncOutputsOnIterate !== undefined)
    set.syncOutputsOnIterate = patch.syncOutputsOnIterate
  if (patch.model !== undefined) set.model = patch.model
  if (patch.variant !== undefined) set.variant = patch.variant
  if (patch.temperature !== undefined) set.temperature = patch.temperature
  if (patch.permission !== undefined) set.permission = JSON.stringify(patch.permission)
  if (patch.steps !== undefined) set.steps = patch.steps
  if (patch.maxSteps !== undefined) set.maxSteps = patch.maxSteps
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
  if (patch.frontmatterExtra !== undefined || patch.outputKinds !== undefined) {
    const baseFm =
      patch.frontmatterExtra !== undefined
        ? { ...patch.frontmatterExtra }
        : ((JSON.parse(existing.frontmatterExtra !== undefined ? '{}' : '{}') as Record<
            string,
            unknown
          >) ?? {})
    if (patch.frontmatterExtra === undefined) {
      // Caller patched only outputKinds — start from current row state.
      const fresh = await getAgent(db, name)
      if (fresh !== null) Object.assign(baseFm, fresh.frontmatterExtra)
    }
    if (patch.outputKinds !== undefined) {
      ;(baseFm as Record<string, unknown>).outputKinds = patch.outputKinds
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
  let outputKinds: Agent['outputKinds'] | undefined
  if (
    fmExtra.outputKinds !== undefined &&
    fmExtra.outputKinds !== null &&
    typeof fmExtra.outputKinds === 'object'
  ) {
    outputKinds = {} as Agent['outputKinds']
    for (const [port, kind] of Object.entries(fmExtra.outputKinds as Record<string, unknown>)) {
      if (kind === 'string' || kind === 'markdown' || kind === 'markdown_file') {
        ;(outputKinds as Record<string, typeof kind>)[port] = kind
      }
    }
  }
  const exposedFm = { ...fmExtra }
  delete (exposedFm as Record<string, unknown>).outputKinds

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
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (outputKinds !== undefined) agent.outputKinds = outputKinds
  if (row.model !== null) agent.model = row.model
  if (row.variant !== null) agent.variant = row.variant
  if (row.temperature !== null) agent.temperature = row.temperature
  if (row.steps !== null) agent.steps = row.steps
  if (row.maxSteps !== null) agent.maxSteps = row.maxSteps
  return agent
}
