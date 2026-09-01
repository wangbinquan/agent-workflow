import type { Mcp } from '@agent-workflow/shared'
import { and, eq, isNull, like, ne } from 'drizzle-orm'
import { agents, mcps } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError, staleConflictError } from '@/util/errors'
import type { McpAgentReference, McpProjection, McpRepository } from '../application/mcps/ports'
import {
  collectMcpAgentReferences,
  mcpConfigHash,
  mcpFromPersistenceRow,
  mcpProjection,
} from './mcpPersistence'
import {
  isPostgresqlUniqueViolation,
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

export interface PostgresqlMcpRepositoryBundle {
  readonly repository: McpRepository
  readonly projection: McpProjection
}

export interface PostgresqlMcpTransactionLifecycle {
  transitionMutation(
    transaction: PostgresqlResourceCatalogTransaction,
    input: {
      readonly mcpId: string
      readonly reason: 'mcp-config-changed' | 'mcp-disabled'
      readonly now: number
    },
  ): Promise<void>
  deletePrepared(transaction: PostgresqlResourceCatalogTransaction, mcpId: string): Promise<void>
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
  transaction: PostgresqlResourceCatalogTransaction,
  mcpId: string,
): Promise<McpAgentReference[]> {
  return collectMcpAgentReferences(
    await transaction
      .select(referenceSelect)
      .from(agents)
      .where(like(agents.mcp, `%"${mcpId}"%`))
      .all(),
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

export function createPostgresqlMcpRepository(input: {
  readonly db: PostgresqlDatabaseClient
  readonly lifecycle: PostgresqlMcpTransactionLifecycle
}): PostgresqlMcpRepositoryBundle {
  async function get(id: string): Promise<Mcp | null> {
    const row = await input.db.select().from(mcps).where(eq(mcps.id, id)).limit(1).get()
    return row === undefined ? null : mcpFromPersistenceRow(row)
  }

  const repository: McpRepository = {
    async list(): Promise<Mcp[]> {
      return (await input.db.select().from(mcps).all()).map(mcpFromPersistenceRow)
    },
    get,
    async create(record): Promise<Mcp> {
      try {
        return await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
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
            .all()
          if (created.length !== 1) throw new Error('mcp insert did not return one row')
          return mcpFromPersistenceRow(created[0]!)
        })
      } catch (error) {
        if (isPostgresqlUniqueViolation(error, ['mcps_owner_name_unique'])) {
          throw nameConflict(record.input.name)
        }
        throw error
      }
    },
    async update(mutation): Promise<Mcp> {
      return runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
        const row = await transaction.select().from(mcps).where(eq(mcps.id, mutation.id)).get()
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
          .all()
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
        return await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
          const row = await transaction.select().from(mcps).where(eq(mcps.id, mutation.id)).get()
          if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
          const current = mcpFromPersistenceRow(row)
          assertExpectedHash(current, mutation.expectedConfigHash, 'modifying it')
          const collision = await transaction
            .select({ id: mcps.id })
            .from(mcps)
            .where(ownerScopedNameWhere(current.ownerUserId ?? null, mutation.newName, mutation.id))
            .get()
          if (collision !== undefined) throw nameConflict(mutation.newName, true)
          const updated = await transaction
            .update(mcps)
            .set({ name: mutation.newName, updatedAt: mutation.updatedAt })
            .where(eq(mcps.id, mutation.id))
            .returning()
            .all()
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
        if (isPostgresqlUniqueViolation(error, ['mcps_owner_name_unique'])) {
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
          .where(like(agents.mcp, `%"${id}"%`))
          .all(),
        id,
      )
    },
    async delete(mutation): Promise<readonly McpAgentReference[]> {
      return runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
        const row = await transaction.select().from(mcps).where(eq(mcps.id, mutation.id)).get()
        if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
        assertExpectedHash(mcpFromPersistenceRow(row), mutation.expectedConfigHash, 'deleting')
        const references = await findAgentReferencesInTransaction(transaction, mutation.id)
        if (references.length > 0) return references
        await input.lifecycle.deletePrepared(transaction, mutation.id)
        await transaction.delete(mcps).where(eq(mcps.id, mutation.id)).run()
        return []
      })
    },
  }

  return Object.freeze({ repository: Object.freeze(repository), projection: mcpProjection })
}
