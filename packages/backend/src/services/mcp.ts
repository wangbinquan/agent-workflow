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
import { assertInitialResourceOwner, discloseRefs, initialPrivateResourceAcl } from './resourceAcl'
import {
  findAgentsReferencingIdInJsonColumn,
  findAgentsReferencingIdInJsonColumnInTx,
  type ReferencingAgentRow,
} from './resourceRefs'
import type { Actor } from '@/auth/actor'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { agents, mcps } from '@/db/schema'
import { mcpOperationConfigHashOf } from '@/services/mcpOperationRevision'
import { transitionMcpRuntimeTestsInTx } from '@/services/mcpRuntimeTestTransitions'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { isOwnerNameUniqueViolation, ownerScopedNameWhere } from './ownerScopedName'
import { monotonicNow } from '@/util/time'

type McpRow = typeof mcps.$inferSelect

export async function listMcps(db: DbClient): Promise<Mcp[]> {
  const rows = await db.select().from(mcps)
  return rows.map(rowToMcp)
}

/** Stable-id load used after entering the RFC-201 keyed coordinator. */
export async function getMcpById(db: DbClient, id: string): Promise<Mcp | null> {
  const rows = await db.select().from(mcps).where(eq(mcps.id, id)).limit(1)
  const row = rows[0]
  return row ? rowToMcp(row) : null
}

/** RFC-234 (T6) — prepare/commit split (agent.ts precedent): `prepare` = the
 *  former pre-insert validation, `commitMcpCreateInTx` = the former insert,
 *  createMcp composes them. The intent apply pipeline runs many commits inside
 *  ONE transaction. */
export interface PreparedMcpCreate {
  id: string
  input: CreateMcp
  initialAcl: ReturnType<typeof initialPrivateResourceAcl>
  now: number
}

export async function prepareMcpCreate(
  db: DbClient,
  input: CreateMcp,
  aclOpts?: { ownerUserId?: string; actor?: Actor | null },
): Promise<PreparedMcpCreate> {
  const ownerUserId = aclOpts?.ownerUserId ?? null
  assertInitialResourceOwner(aclOpts?.actor, ownerUserId)
  const initialAcl = initialPrivateResourceAcl(ownerUserId)
  const occupied = await db
    .select({ id: mcps.id })
    .from(mcps)
    .where(ownerScopedNameWhere(mcps.ownerUserId, mcps.name, ownerUserId, input.name))
    .limit(1)
  if (occupied.length > 0) {
    throw new ConflictError('mcp-name-in-use', `mcp '${input.name}' already exists`)
  }

  // Defensive re-validation of the type-specific config payload. CreateMcpSchema
  // already validated it at the route boundary; we do it again here in case a
  // service caller bypasses the route and passes a hand-built object.
  validateConfigForType(input.type, input.config)

  return { id: ulid(), input, initialAcl, now: Date.now() }
}

export function commitMcpCreateInTx(tx: DbTxSync, p: PreparedMcpCreate): void {
  tx.insert(mcps)
    .values({
      id: p.id,
      name: p.input.name,
      description: p.input.description,
      type: p.input.type,
      config: JSON.stringify(p.input.config),
      enabled: p.input.enabled,
      // RFC-231: every user-created resource starts private with ACL rev 0.
      ...p.initialAcl,
      createdAt: p.now,
      updatedAt: p.now,
    })
    .run()
}

export async function createMcp(
  db: DbClient,
  input: CreateMcp,
  aclOpts?: { ownerUserId?: string; actor?: Actor | null },
): Promise<Mcp> {
  const prepared = await prepareMcpCreate(db, input, aclOpts)
  try {
    dbTxSync(db, (tx) => {
      commitMcpCreateInTx(tx, prepared)
    })
  } catch (error) {
    if (isOwnerNameUniqueViolation(error, 'mcps', 'mcps_owner_name_unique')) {
      throw new ConflictError('mcp-name-in-use', `mcp '${input.name}' already exists`)
    }
    throw error
  }
  const created = await getMcpById(db, prepared.id)
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
    updatedAt: opts.updatedAt ?? monotonicNow(existing.updatedAt),
  }
  if (nextDescription !== existing.description) set.description = nextDescription
  if (nextEnabled !== existing.enabled) set.enabled = nextEnabled
  if (canonicalJson(nextConfig) !== canonicalJson(existing.config))
    set.config = JSON.stringify(nextConfig)

  dbTxSync(db, (tx) => {
    commitMcpUpdateInTx(tx, { id: existing.id, set })
  })
  const updated = await getMcpById(db, existing.id)
  if (updated === null) throw new Error('mcp disappeared after update')
  return updated
}

/** RFC-234 (T6) — the update write core. `expectedConfigHash` is the intent
 *  pipeline's manifest fence (design §7): when present, the row's CURRENT
 *  config hash is compared inside the transaction and a mismatch is the same
 *  `resource-operation-stale` conflict the delete path throws. updateMcp's
 *  standalone path passes no fence (its OCC lives at the route coordinator). */
export interface PreparedMcpUpdate {
  id: string
  set: Partial<typeof mcps.$inferInsert>
  expectedConfigHash?: string
  /**
   * RFC-271 T12 —— 提交事务内的 **owner 围栏**（与技能版本提交的
   * `expectedOwnerUserId` 同一形态，RFC-170 第四轮 review 的先例）。
   *
   * ⚠️ 在此之前这条原语**只校验 config hash、不校验 owner**：owner 门只在路由层。
   * 对经路由的编辑没问题，但任何**直接到达这条原语**的新写路径（intent apply、
   * 配置包导入）都绕过了它 —— 伪造「他人公开资源的 id + 正确的 hash」即可改写
   * 别人那一行的内容。hash 不是授权，它只证明「我读到的是这一版」。
   *
   * 传入调用方**授权时**看到的 owner。给了就在事务内复核：既拦下伪造，也顺带
   * 关掉「授权之后、提交之前发生 owner 转移」这个竞态。缺席 = 不设围栏（既有
   * 调用方逐字不变）。
   */
  expectedOwnerUserId?: string | null
}

export function commitMcpUpdateInTx(tx: DbTxSync, p: PreparedMcpUpdate): void {
  const row = tx.select().from(mcps).where(eq(mcps.id, p.id)).get()
  if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
  if (p.expectedOwnerUserId !== undefined && row.ownerUserId !== p.expectedOwnerUserId) {
    // 与「不存在」同形的错误码没有意义：调用方是持有 id 的写入方，这里要的是
    // 明确的拒绝而不是存在性隐藏（列表与详情面的隐藏在别处）。
    throw staleConflictError(
      'mcp',
      'the MCP is no longer owned by the authorizing user; reload before saving',
    )
  }
  if (p.expectedConfigHash !== undefined) {
    const currentConfigHash = mcpOperationConfigHashOf(rowToMcp(row))
    if (currentConfigHash !== p.expectedConfigHash) {
      throw staleConflictError('mcp', 'the MCP changed; reload before saving', {
        expectedConfigHash: p.expectedConfigHash,
        currentConfigHash,
      })
    }
  }
  tx.update(mcps).set(p.set).where(eq(mcps.id, p.id)).run()
  transitionMcpRuntimeTestsInTx(tx, {
    mcpId: p.id,
    reason: (p.set.enabled ?? row.enabled) ? 'mcp-config-changed' : 'mcp-disabled',
    now: typeof p.set.updatedAt === 'number' ? p.set.updatedAt : Date.now(),
  })
}

export async function deleteMcp(
  db: DbClient,
  id: string,
  actor: Actor,
  opts: {
    existing?: Mcp
    beforeDeleteTx?: () => Promise<void>
    beforeDeleteInTx?: (tx: DbTxSync) => void
  } = {},
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
  // Deterministic interleaving seam for the RFC-223 check→delete race tests.
  // Production callers leave it absent.
  await opts.beforeDeleteTx?.()

  // The preliminary check above gives the common refusal path its disclosure
  // without touching the target row. The authoritative reverse-reference
  // check and DELETE must share one synchronous SQLite transaction: if an
  // agent save wins the old await window, it is observed here and the target
  // survives; if this DELETE wins first, the save-side target fence fails.
  const finalDependents = dbTxSync(db, (tx) => {
    const target = tx.select().from(mcps).where(eq(mcps.id, existing.id)).get()
    if (target === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
    const current = rowToMcp(target)
    const expectedConfigHash = mcpOperationConfigHashOf(existing)
    const currentConfigHash = mcpOperationConfigHashOf(current)
    if (currentConfigHash !== expectedConfigHash) {
      throw staleConflictError('mcp', 'the MCP changed; reload before deleting', {
        expectedConfigHash,
        currentConfigHash,
      })
    }
    const refs = findAgentsReferencingMcpInTx(tx, existing.id)
    if (refs.length > 0) return refs
    opts.beforeDeleteInTx?.(tx)
    tx.delete(mcps).where(eq(mcps.id, existing.id)).run()
    return [] as ReferencingAgentRow[]
  })
  if (finalDependents.length > 0) {
    throw new ConflictError(
      'mcp-still-referenced',
      `mcp '${existing.name}' is referenced by ${finalDependents.length} agent(s)`,
      await discloseRefs(db, actor, 'agent', finalDependents),
    )
  }
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
  const updatedAt = opts.updatedAt ?? monotonicNow(existing.updatedAt)

  // RFC-223 (PR-1 / D7): agents.mcp stores the mcp ID, which is stable across a
  // rename — so there is NO cascade to perform. Just rename the row. (This
  // removes the old `agents.mcp` name-rewrite loop that RFC-093 hardened.)
  try {
    dbTxSync(db, (tx) => {
      const collision = tx
        .select({ id: mcps.id })
        .from(mcps)
        .where(
          ownerScopedNameWhere(
            mcps.ownerUserId,
            mcps.name,
            existing.ownerUserId ?? null,
            input.newName,
            { column: mcps.id, id: existing.id },
          ),
        )
        .get()
      if (collision !== undefined) {
        throw new ConflictError(
          'mcp-name-in-use',
          `mcp '${input.newName}' already exists; pick a different name`,
        )
      }
      tx.update(mcps)
        .set({
          name: input.newName,
          updatedAt,
        })
        .where(eq(mcps.id, existing.id))
        .run()
      transitionMcpRuntimeTestsInTx(tx, {
        mcpId: existing.id,
        reason: 'mcp-config-changed',
        now: updatedAt,
      })
    })
  } catch (error) {
    if (isOwnerNameUniqueViolation(error, 'mcps', 'mcps_owner_name_unique')) {
      throw new ConflictError(
        'mcp-name-in-use',
        `mcp '${input.newName}' already exists; pick a different name`,
      )
    }
    throw error
  }

  const renamed = await getMcpById(db, id)
  if (renamed === null) throw new Error('mcp disappeared after rename')
  return renamed
}

/**
 * Returns the agents whose `mcp` JSON column references `mcpId`. RFC-223
 * (PR-1): agents.mcp stores ids, so the lookup key is the mcp id.
 * RFC-284 T9：两段式扫描（LIKE 粗过滤 + parse 精确判定）收编
 * `resourceRefs.findAgentsReferencingIdInJsonColumn`——本域只留 matcher。
 */
export type { ReferencingAgentRow } from './resourceRefs'

const mcpRefArgs = (mcpId: string) => ({
  column: agents.mcp,
  id: mcpId,
  matches: (parsed: unknown, id: string) => Array.isArray(parsed) && parsed.includes(id),
})

export async function findAgentsReferencingMcp(
  db: DbClient,
  mcpId: string,
): Promise<ReferencingAgentRow[]> {
  return findAgentsReferencingIdInJsonColumn(db, mcpRefArgs(mcpId))
}

function findAgentsReferencingMcpInTx(tx: DbTxSync, mcpId: string): ReferencingAgentRow[] {
  return findAgentsReferencingIdInJsonColumnInTx(tx, mcpRefArgs(mcpId))
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

export function rowToMcp(row: McpRow): Mcp {
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
