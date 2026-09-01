import type { Mcp } from '@agent-workflow/shared'
import { and, eq, isNull, like, ne, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { DbClient } from '@/db/client'
import { agents, mcps } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { ConflictError, NotFoundError, staleConflictError } from '@/util/errors'
import type { McpAgentReference, McpProjection, McpRepository } from '../application/mcps/ports'
import {
  collectMcpAgentReferences,
  mcpConfigHash,
  mcpFromPersistenceRow,
  mcpProjection,
} from './mcpPersistence'

export interface SqliteMcpRepositoryBundle {
  readonly repository: McpRepository
  readonly projection: McpProjection
}

export interface McpTransactionLifecycle {
  transitionMutation(
    tx: DbTxSync,
    input: {
      readonly mcpId: string
      readonly reason: 'mcp-config-changed' | 'mcp-disabled'
      readonly now: number
    },
  ): void
  deletePrepared(tx: DbTxSync, mcpId: string): void
}

function ownerScopedNameWhere(
  ownerColumn: AnySQLiteColumn,
  nameColumn: AnySQLiteColumn,
  ownerUserId: string | null,
  name: string,
  excludeId?: { readonly column: AnySQLiteColumn; readonly id: string },
): SQL {
  const owner = ownerUserId === null ? isNull(ownerColumn) : eq(ownerColumn, ownerUserId)
  const identity = and(owner, eq(nameColumn, name))
  return excludeId === undefined ? identity! : and(identity, ne(excludeId.column, excludeId.id))!
}

function isOwnerNameUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|constraint failed/i.test(message)) {
    return false
  }
  return message.includes('mcps_owner_name_unique') || message.includes('mcps.name')
}

const referenceSelect = {
  id: agents.id,
  name: agents.name,
  raw: agents.mcp,
  ownerUserId: agents.ownerUserId,
  visibility: agents.visibility,
}

function findAgentReferencesInTx(tx: DbTxSync, mcpId: string): McpAgentReference[] {
  return collectMcpAgentReferences(
    tx
      .select(referenceSelect)
      .from(agents)
      .where(like(agents.mcp, '%"' + mcpId + '"%'))
      .all(),
    mcpId,
  )
}

export function createSqliteMcpRepository(input: {
  readonly db: DbClient
  readonly lifecycle: McpTransactionLifecycle
}): SqliteMcpRepositoryBundle {
  const db = input.db

  async function get(id: string): Promise<Mcp | null> {
    const row = (await db.select().from(mcps).where(eq(mcps.id, id)).limit(1))[0]
    return row === undefined ? null : mcpFromPersistenceRow(row)
  }

  async function requireAfterWrite(id: string, action: string): Promise<Mcp> {
    const row = await get(id)
    if (row === null) throw new Error('mcp disappeared ' + action)
    return row
  }

  const repository: McpRepository = {
    async list(): Promise<Mcp[]> {
      return (await db.select().from(mcps)).map(mcpFromPersistenceRow)
    },
    get,
    async create(record): Promise<Mcp> {
      try {
        dbTxSync(db, (tx) => {
          tx.insert(mcps)
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
            .run()
        })
      } catch (error) {
        if (isOwnerNameUniqueViolation(error)) {
          throw new ConflictError(
            'mcp-name-in-use',
            "mcp '" + record.input.name + "' already exists",
          )
        }
        throw error
      }
      return requireAfterWrite(record.id, 'right after insert')
    },
    async update(mutation): Promise<Mcp> {
      dbTxSync(db, (tx) => {
        const row = tx.select().from(mcps).where(eq(mcps.id, mutation.id)).get()
        if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
        const current = mcpFromPersistenceRow(row)
        const currentConfigHash = mcpConfigHash(current)
        if (currentConfigHash !== mutation.expectedConfigHash) {
          throw staleConflictError('mcp', 'the MCP changed; reload before saving', {
            expectedConfigHash: mutation.expectedConfigHash,
            currentConfigHash,
          })
        }
        const set: Partial<typeof mcps.$inferInsert> = { updatedAt: mutation.set.updatedAt }
        if (mutation.set.description !== undefined) set.description = mutation.set.description
        if (mutation.set.enabled !== undefined) set.enabled = mutation.set.enabled
        if (mutation.set.config !== undefined) set.config = JSON.stringify(mutation.set.config)
        tx.update(mcps).set(set).where(eq(mcps.id, mutation.id)).run()
        input.lifecycle.transitionMutation(tx, {
          mcpId: mutation.id,
          reason:
            (mutation.set.enabled ?? current.enabled) === true
              ? 'mcp-config-changed'
              : 'mcp-disabled',
          now: mutation.set.updatedAt,
        })
      })
      return requireAfterWrite(mutation.id, 'after update')
    },
    async rename(mutation): Promise<Mcp> {
      try {
        dbTxSync(db, (tx) => {
          const row = tx.select().from(mcps).where(eq(mcps.id, mutation.id)).get()
          if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
          const current = mcpFromPersistenceRow(row)
          const currentConfigHash = mcpConfigHash(current)
          if (currentConfigHash !== mutation.expectedConfigHash) {
            throw staleConflictError('mcp', 'the MCP changed; reload before modifying it', {
              expectedConfigHash: mutation.expectedConfigHash,
              currentConfigHash,
            })
          }
          const collision = tx
            .select({ id: mcps.id })
            .from(mcps)
            .where(
              ownerScopedNameWhere(
                mcps.ownerUserId,
                mcps.name,
                current.ownerUserId ?? null,
                mutation.newName,
                { column: mcps.id, id: mutation.id },
              ),
            )
            .get()
          if (collision !== undefined) {
            throw new ConflictError(
              'mcp-name-in-use',
              "mcp '" + mutation.newName + "' already exists; pick a different name",
            )
          }
          tx.update(mcps)
            .set({ name: mutation.newName, updatedAt: mutation.updatedAt })
            .where(eq(mcps.id, mutation.id))
            .run()
          input.lifecycle.transitionMutation(tx, {
            mcpId: mutation.id,
            reason: 'mcp-config-changed',
            now: mutation.updatedAt,
          })
        })
      } catch (error) {
        if (isOwnerNameUniqueViolation(error)) {
          throw new ConflictError(
            'mcp-name-in-use',
            "mcp '" + mutation.newName + "' already exists; pick a different name",
          )
        }
        throw error
      }
      return requireAfterWrite(mutation.id, 'after rename')
    },
    async findAgentReferences(id): Promise<readonly McpAgentReference[]> {
      return collectMcpAgentReferences(
        await db
          .select(referenceSelect)
          .from(agents)
          .where(like(agents.mcp, '%"' + id + '"%')),
        id,
      )
    },
    async delete(mutation): Promise<readonly McpAgentReference[]> {
      return dbTxSync(db, (tx) => {
        const row = tx.select().from(mcps).where(eq(mcps.id, mutation.id)).get()
        if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
        const currentConfigHash = mcpConfigHash(mcpFromPersistenceRow(row))
        if (currentConfigHash !== mutation.expectedConfigHash) {
          throw staleConflictError('mcp', 'the MCP changed; reload before deleting', {
            expectedConfigHash: mutation.expectedConfigHash,
            currentConfigHash,
          })
        }
        const references = findAgentReferencesInTx(tx, mutation.id)
        if (references.length > 0) return references
        input.lifecycle.deletePrepared(tx, mutation.id)
        tx.delete(mcps).where(eq(mcps.id, mutation.id)).run()
        return [] as McpAgentReference[]
      })
    },
  }
  Object.freeze(repository)

  return Object.freeze({
    repository,
    projection: mcpProjection,
  })
}
