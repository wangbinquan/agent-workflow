// MCP service — CRUD on the mcps table (RFC-028).
//
// Mirrors services/agent.ts / services/skill.ts shape: DB is source of truth,
// JSON config is (un)marshaled at this boundary, name unique constraint
// enforced both by the column index and by an explicit pre-insert lookup so
// we can return a friendly ConflictError instead of a SQL exception.
//
// Reference check: `findAgentsReferencingMcp` powers the still-referenced
// guard on delete so the platform never silently breaks an agent's `mcp: [...]`
// list. Rename is display-only because references store the canonical id.

import type { CreateMcp, Mcp, RenameMcp, UpdateMcp } from '@agent-workflow/shared'
import {
  canonicalJson,
  McpLocalConfigSchema,
  McpRemoteConfigSchema,
  McpSchema,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { discloseRefs } from './resourceAcl'
import type { Actor } from '@/auth/actor'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { agents, mcps } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

type McpRow = typeof mcps.$inferSelect

export async function listMcps(db: DbClient): Promise<Mcp[]> {
  const rows = await db.select().from(mcps)
  return rows.map(rowToMcp)
}

export async function getMcp(db: DbClient, name: string): Promise<Mcp | null> {
  const rows = await db.select().from(mcps).where(eq(mcps.name, name)).limit(1)
  const row = rows[0]
  return row ? rowToMcp(row) : null
}

/** Stable-id load used after entering the RFC-201 keyed coordinator. */
export async function getMcpById(db: DbClient, id: string): Promise<Mcp | null> {
  const rows = await db.select().from(mcps).where(eq(mcps.id, id)).limit(1)
  const row = rows[0]
  return row ? rowToMcp(row) : null
}

export async function createMcp(
  db: DbClient,
  input: CreateMcp,
  aclOpts?: { ownerUserId?: string },
): Promise<Mcp> {
  if ((await getMcp(db, input.name)) !== null) {
    throw new ConflictError('mcp-name-in-use', `mcp '${input.name}' already exists`)
  }

  // Defensive re-validation of the type-specific config payload. CreateMcpSchema
  // already validated it at the route boundary; we do it again here in case a
  // service caller bypasses the route and passes a hand-built object.
  validateConfigForType(input.type, input.config)

  const id = ulid()
  const now = Date.now()
  await db.insert(mcps).values({
    id,
    name: input.name,
    description: input.description,
    type: input.type,
    config: JSON.stringify(input.config),
    enabled: input.enabled,
    // RFC-099: creator becomes owner; new resources default to 'public' (D18).
    ownerUserId: aclOpts?.ownerUserId ?? null,
    visibility: 'public',
    createdAt: now,
    updatedAt: now,
  })
  const created = await getMcpById(db, id)
  if (created === null) throw new Error('mcp disappeared right after insert')
  return created
}

export async function updateMcp(
  db: DbClient,
  id: string,
  patch: UpdateMcp,
  opts: { existing?: Mcp; updatedAt?: number } = {},
): Promise<Mcp> {
  const existing = opts.existing ?? (await getMcpById(db, id))
  if (existing === null || existing.id !== id) {
    throw new NotFoundError('mcp-not-found', 'mcp not found')
  }

  // `type` cannot change in-place — it's the discriminator, and changing it
  // would invalidate stored config. Callers that want to swap transport must
  // delete + recreate.
  if (patch.type !== undefined && patch.type !== existing.type) {
    throw new ValidationError('mcp-type-immutable', `mcp '${existing.name}' type cannot change`, {
      currentType: existing.type,
      requestedType: patch.type,
    })
  }

  if (patch.config !== undefined) {
    validateConfigForType(existing.type, patch.config)
  }

  const nextDescription = patch.description ?? existing.description
  const nextEnabled = patch.enabled ?? existing.enabled
  const nextConfig = patch.config ?? existing.config
  const changed =
    nextDescription !== existing.description ||
    nextEnabled !== existing.enabled ||
    canonicalJson(nextConfig) !== canonicalJson(existing.config)
  if (!changed) return existing

  const set: Partial<typeof mcps.$inferInsert> = {
    updatedAt: opts.updatedAt ?? Math.max(Date.now(), existing.updatedAt + 1),
  }
  if (nextDescription !== existing.description) set.description = nextDescription
  if (nextEnabled !== existing.enabled) set.enabled = nextEnabled
  if (canonicalJson(nextConfig) !== canonicalJson(existing.config))
    set.config = JSON.stringify(nextConfig)

  await db.update(mcps).set(set).where(eq(mcps.id, existing.id))
  const updated = await getMcpById(db, existing.id)
  if (updated === null) throw new Error('mcp disappeared after update')
  return updated
}

export async function deleteMcp(
  db: DbClient,
  id: string,
  actor: Actor,
  opts: { existing?: Mcp } = {},
): Promise<void> {
  const existing = opts.existing ?? (await getMcpById(db, id))
  if (existing === null || existing.id !== id) {
    throw new NotFoundError('mcp-not-found', 'mcp not found')
  }
  // RFC-223 (PR-1): agents.mcp stores ids — match by this mcp's id.
  const dependents = await findAgentsReferencingMcp(db, existing.id)
  if (dependents.length > 0) {
    // RFC-203 T6: principal-aware disclosure (deleteWorkflow precedent) —
    // names only for agents the actor may see, the rest an aggregate count.
    throw new ConflictError(
      'mcp-still-referenced',
      `mcp '${existing.name}' is referenced by ${dependents.length} agent(s)`,
      await discloseRefs(db, actor, 'agent', dependents),
    )
  }
  await db.delete(mcps).where(eq(mcps.id, existing.id))
}

export async function renameMcp(
  db: DbClient,
  id: string,
  input: RenameMcp,
  opts: { existing?: Mcp; updatedAt?: number } = {},
): Promise<Mcp> {
  const existing = opts.existing ?? (await getMcpById(db, id))
  if (existing === null || existing.id !== id) {
    throw new NotFoundError('mcp-not-found', 'mcp not found')
  }
  if (input.newName === existing.name) return existing

  if ((await getMcp(db, input.newName)) !== null) {
    throw new ConflictError(
      'mcp-name-in-use',
      `mcp '${input.newName}' already exists; pick a different name`,
    )
  }

  // RFC-223 (PR-1 / D7): agents.mcp stores the mcp ID, which is stable across a
  // rename — so there is NO cascade to perform. Just rename the row. (This
  // removes the old `agents.mcp` name-rewrite loop that RFC-093 hardened.)
  dbTxSync(db, (tx) => {
    tx.update(mcps)
      .set({
        name: input.newName,
        updatedAt: opts.updatedAt ?? Math.max(Date.now(), existing.updatedAt + 1),
      })
      .where(eq(mcps.id, existing.id))
      .run()
  })

  const renamed = await getMcpById(db, id)
  if (renamed === null) throw new Error('mcp disappeared after rename')
  return renamed
}

/**
 * Returns the agents (id + name) whose `mcp` JSON column references `mcpId`.
 * RFC-223 (PR-1): agents.mcp stores ids, so the lookup key is the mcp id.
 *
 * Two-stage matching: SQL `LIKE` pre-filter is coarse (substring match) so we
 * re-parse and exact-match with Array.includes to reject any coincidental JSON
 * substring hit.
 */
export interface ReferencingAgentRow {
  id: string
  name: string
  ownerUserId: string | null
  visibility: 'public' | 'private'
}

export async function findAgentsReferencingMcp(
  db: DbClient,
  mcpId: string,
): Promise<ReferencingAgentRow[]> {
  const { like } = await import('drizzle-orm')
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      mcp: agents.mcp,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(like(agents.mcp, `%"${mcpId}"%`))

  const out: ReferencingAgentRow[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.mcp) as unknown
      if (Array.isArray(parsed) && parsed.includes(mcpId)) {
        out.push({
          id: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })
      }
    } catch {
      // malformed column — agent.ts parser treats it as [] anyway
    }
  }
  return out
}

// --- internals ---

function validateConfigForType(type: 'local' | 'remote', config: unknown): void {
  const schema = type === 'local' ? McpLocalConfigSchema : McpRemoteConfigSchema
  const r = schema.safeParse(config)
  if (!r.success) {
    throw new ValidationError('mcp-config-invalid', `mcp ${type} config is invalid`, {
      issues: r.error.issues,
    })
  }
}

function rowToMcp(row: McpRow): Mcp {
  let config: unknown
  try {
    config = JSON.parse(row.config)
  } catch {
    config = {}
  }
  // Use the public schema to coerce + validate so any malformed DB row is
  // rejected here (rather than silently flowing into the runner with a
  // half-baked shape that opencode would reject at spawn time).
  const parsed = McpSchema.safeParse({
    id: row.id,
    name: row.name,
    description: row.description,
    // RFC-099 ACL projection — routes filter on these.
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    aclRevision: row.aclRevision,
    type: row.type,
    config,
    enabled: row.enabled,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
  if (!parsed.success) {
    throw new ValidationError(
      'mcp-row-corrupt',
      `mcp row '${row.name}' (id=${row.id}) failed schema validation`,
      { issues: parsed.error.issues },
    )
  }
  return parsed.data
}
