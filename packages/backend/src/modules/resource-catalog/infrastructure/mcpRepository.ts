import type { Mcp } from '@agent-workflow/shared'
import { and, eq, isNull, like, ne } from 'drizzle-orm'
import { agents, mcps } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError, staleConflictError } from '@/util/errors'
import type { McpAgentReference, McpProjection, McpRepository } from '../application/mcps/ports'
import {
  collectMcpAgentReferences,
  mcpConfigHash,
  mcpFromPersistenceRow,
  mcpProjection,
} from './mcpPersistence'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

export interface McpRepositoryBundle {
  readonly repository: McpRepository
  readonly projection: McpProjection
}

/** 事务内的运行时测试生命周期（一份合同，两个 provider 共用）。 */
export interface McpTransactionLifecycle {
  transitionMutation(
    transaction: ResourceCatalogTransaction,
    input: {
      readonly mcpId: string
      readonly reason: 'mcp-config-changed' | 'mcp-disabled'
      readonly now: number
    },
  ): Promise<void>
  deletePrepared(transaction: ResourceCatalogTransaction, mcpId: string): Promise<void>
}

const referenceSelect = {
  id: agents.id,
  name: agents.name,
  raw: agents.mcp,
  ownerUserId: agents.ownerUserId,
  visibility: agents.visibility,
}

function ownerScopedNameWhere(ownerUserId: string | null, name: string, excludeId?: string) {
  const owner = ownerUserId === null ? isNull(mcps.ownerUserId) : eq(mcps.ownerUserId, ownerUserId)
  const identity = and(owner, eq(mcps.name, name))
  return excludeId === undefined ? identity : and(identity, ne(mcps.id, excludeId))
}

function nameConflict(name: string, rename = false): ConflictError {
  return new ConflictError(
    'mcp-name-in-use',
    rename ? `mcp '${name}' already exists; pick a different name` : `mcp '${name}' already exists`,
  )
}

async function findAgentReferencesInTransaction(
  transaction: ResourceCatalogTransaction,
  mcpId: string,
): Promise<McpAgentReference[]> {
  return collectMcpAgentReferences(
    await transaction
      .select(referenceSelect)
      .from(agents)
      .where(like(agents.mcp, `%"${mcpId}"%`)),
    mcpId,
  )
}

function assertExpectedHash(mcp: Mcp, expectedConfigHash: string, action: string): void {
  const currentConfigHash = mcpConfigHash(mcp)
  if (currentConfigHash === expectedConfigHash) return
  throw staleConflictError('mcp', `the MCP changed before ${action}; reload and retry`, {
    expectedConfigHash,
    currentConfigHash,
  })
}

/**
 * RFC-359 W4-D16 —— MCP 仓库：一份实现，两个 provider 共用。写路径全在统一 serializable 事务里，运行时测试会话的
 * 失效意图在同一笔事务里写下；owner + name 唯一冲突经能力矩阵 `uniqueViolationTarget` 映射回 `mcp-name-in-use`。
 */
export function createMcpRepository(input: {
  readonly db: ProviderNeutralDatabase
  readonly lifecycle: McpTransactionLifecycle
}): McpRepositoryBundle {
  const engine = databaseSessionFor(input.db).engine
  const isOwnerNameConflict = (error: unknown): boolean => {
    const target = engine.uniqueViolationTarget(error)
    return target !== undefined && /mcps[._](?:owner|name)/i.test(target)
  }
  async function get(id: string): Promise<Mcp | null> {
    const row = (await input.db.select().from(mcps).where(eq(mcps.id, id)).limit(1))[0]
    return row === undefined ? null : mcpFromPersistenceRow(row)
  }

  const repository: McpRepository = {
    async list(): Promise<Mcp[]> {
      return (await input.db.select().from(mcps)).map(mcpFromPersistenceRow)
    },
    get,
    async create(record): Promise<Mcp> {
      try {
        return await runResourceCatalogTransaction(input.db, async (transaction) => {
          const created = await transaction
            .insert(mcps)
            .values({
              id: record.id,
              name: record.input.name,
              description: record.input.description,
              type: record.input.type,
              config: JSON.stringify(record.input.config),
              enabled: record.input.enabled,
              ownerUserId: record.ownerUserId,
              visibility: record.visibility,
              aclRevision: record.aclRevision,
              createdAt: record.now,
              updatedAt: record.now,
            })
            .returning()
          if (created.length !== 1) throw new Error('mcp insert did not return one row')
          return mcpFromPersistenceRow(created[0]!)
        })
      } catch (error) {
        if (isOwnerNameConflict(error)) {
          throw nameConflict(record.input.name)
        }
        throw error
      }
    },
    async update(mutation): Promise<Mcp> {
      return runResourceCatalogTransaction(input.db, async (transaction) => {
        const row = (
          await transaction.select().from(mcps).where(eq(mcps.id, mutation.id)).limit(1)
        )[0]
        if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
        const current = mcpFromPersistenceRow(row)
        assertExpectedHash(current, mutation.expectedConfigHash, 'saving')
        const set: Partial<typeof mcps.$inferInsert> = { updatedAt: mutation.set.updatedAt }
        if (mutation.set.description !== undefined) set.description = mutation.set.description
        if (mutation.set.enabled !== undefined) set.enabled = mutation.set.enabled
        if (mutation.set.config !== undefined) set.config = JSON.stringify(mutation.set.config)
        const updated = await transaction
          .update(mcps)
          .set(set)
          .where(eq(mcps.id, mutation.id))
          .returning()
        if (updated.length !== 1) {
          throw staleConflictError('mcp', 'the MCP changed while saving; reload and retry')
        }
        await input.lifecycle.transitionMutation(transaction, {
          mcpId: mutation.id,
          reason:
            (mutation.set.enabled ?? current.enabled) === true
              ? 'mcp-config-changed'
              : 'mcp-disabled',
          now: mutation.set.updatedAt,
        })
        return mcpFromPersistenceRow(updated[0]!)
      })
    },
    async rename(mutation): Promise<Mcp> {
      try {
        return await runResourceCatalogTransaction(input.db, async (transaction) => {
          const row = (
            await transaction.select().from(mcps).where(eq(mcps.id, mutation.id)).limit(1)
          )[0]
          if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
          const current = mcpFromPersistenceRow(row)
          assertExpectedHash(current, mutation.expectedConfigHash, 'modifying it')
          const collision = (
            await transaction
              .select({ id: mcps.id })
              .from(mcps)
              .where(
                ownerScopedNameWhere(current.ownerUserId ?? null, mutation.newName, mutation.id),
              )
              .limit(1)
          )[0]
          if (collision !== undefined) throw nameConflict(mutation.newName, true)
          const updated = await transaction
            .update(mcps)
            .set({ name: mutation.newName, updatedAt: mutation.updatedAt })
            .where(eq(mcps.id, mutation.id))
            .returning()
          if (updated.length !== 1) {
            throw staleConflictError('mcp', 'the MCP changed while renaming; reload and retry')
          }
          await input.lifecycle.transitionMutation(transaction, {
            mcpId: mutation.id,
            reason: 'mcp-config-changed',
            now: mutation.updatedAt,
          })
          return mcpFromPersistenceRow(updated[0]!)
        })
      } catch (error) {
        if (isOwnerNameConflict(error)) {
          throw nameConflict(mutation.newName, true)
        }
        throw error
      }
    },
    async findAgentReferences(id): Promise<readonly McpAgentReference[]> {
      return collectMcpAgentReferences(
        await input.db
          .select(referenceSelect)
          .from(agents)
          .where(like(agents.mcp, `%"${id}"%`)),
        id,
      )
    },
    async delete(mutation): Promise<readonly McpAgentReference[]> {
      return runResourceCatalogTransaction(input.db, async (transaction) => {
        const row = (
          await transaction.select().from(mcps).where(eq(mcps.id, mutation.id)).limit(1)
        )[0]
        if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
        assertExpectedHash(mcpFromPersistenceRow(row), mutation.expectedConfigHash, 'deleting')
        const references = await findAgentReferencesInTransaction(transaction, mutation.id)
        if (references.length > 0) return references
        await input.lifecycle.deletePrepared(transaction, mutation.id)
        await transaction.delete(mcps).where(eq(mcps.id, mutation.id))
        return []
      })
    },
  }

  return Object.freeze({ repository: Object.freeze(repository), projection: mcpProjection })
}
