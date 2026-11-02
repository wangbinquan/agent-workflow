import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type { Agent } from '@agent-workflow/shared'

import { and, eq, ne } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import type {
  DigitalEmployeeAgentTemplateFence,
  DigitalEmployeeAgentTemplateRepository,
} from '../application/agents/digitalEmployeeAgentTemplateCatalog'
import { loadAgentPersistenceRow } from './agentPersistence'
import { createAgentMutationParticipant } from './agentMutationParticipant'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

type AgentRow = PersistenceTables['agents']['$inferSelect']

function occupied(id: string): ConflictError {
  return new ConflictError(
    'builtin-agent-id-collision',
    `stable digital employee Agent id '${id}' is occupied`,
  )
}

function nameConflict(name: string): ConflictError {
  return new ConflictError('agent-name-in-use', `agent '${name}' already exists`)
}

function stale(id: string): ConflictError {
  return staleConflictError('agent', `agent '${id}' changed; reload and retry`)
}

const SYSTEM_OWNER = Object.freeze({ kind: 'system' as const, userId: SYSTEM_USER_ID })

async function requireSystemBuiltin(
  transaction: ResourceCatalogTransaction,
  id: string,
  row: AgentRow | undefined,
  fence?: DigitalEmployeeAgentTemplateFence,
): Promise<Agent> {
  if (row === undefined) throw new NotFoundError('agent-not-found', 'agent not found')
  if (row.ownerUserId !== SYSTEM_USER_ID || row.builtin !== true) throw occupied(id)
  if (
    fence !== undefined &&
    (row.updatedAt !== fence.expectedUpdatedAt || row.aclRevision !== fence.expectedAclRevision)
  ) {
    throw stale(id)
  }
  return loadAgentPersistenceRow(transaction, row)
}

/** Native PostgreSQL writer for system-owned Digital Employee Agent templates. */
export function createDigitalEmployeeAgentTemplateRepository(
  db: PersistenceDb,
): DigitalEmployeeAgentTemplateRepository {
  // 驱动错误的形状是唯一容身 provider 差异的地方，经能力矩阵映射回本模块的闭合错误合同：
  // PG 给约束名（`agents_owner_name_unique` / `agents_pkey`），SQLite 给 `UNIQUE constraint failed:`
  // 之后的列清单（`agents.owner_user_id, agents.name` / `agents.id`）。
  const engine = databaseSessionFor(db).engine
  const isOwnerNameConflict = (error: unknown): boolean => {
    const target = engine.uniqueViolationTarget(error)
    return target !== undefined && /agents[._](?:owner|name)/i.test(target)
  }
  const isPrimaryKeyConflict = (error: unknown): boolean => {
    const target = engine.uniqueViolationTarget(error)
    return target !== undefined && /agents[._](?:pkey|id)\b/i.test(target)
  }
  async function get(id: string): Promise<Agent | null> {
    return loadAgentPersistenceRow(db, async (tx) => {
      const { agents } = tablesOf(tx)
      return first(tx.select().from(agents).where(eq(agents.id, id)))
    })
  }

  return Object.freeze({
    get,

    async createBuiltin(
      input: Parameters<DigitalEmployeeAgentTemplateRepository['createBuiltin']>[0],
    ): Promise<void> {
      try {
        await runResourceCatalogTransaction(db, async (transaction) => {
          const { agents } = tablesOf(transaction)
          const existing = await first(
            transaction.select({ id: agents.id }).from(agents).where(eq(agents.id, input.id)),
          )
          if (existing !== undefined) throw occupied(input.id)
          // RFC-401 A1：校验与写入经唯一的 agent 写入参与者（系统内建写入：系统用户所有、public、builtin）。
          await createAgentMutationParticipant(transaction).create(SYSTEM_OWNER, {
            id: input.id,
            agent: input.definition,
          })
        })
      } catch (error) {
        if (isPrimaryKeyConflict(error)) throw occupied(input.id)
        throw error
      }
    },

    async renameBuiltin(
      input: Parameters<DigitalEmployeeAgentTemplateRepository['renameBuiltin']>[0],
    ): Promise<void> {
      try {
        await runResourceCatalogTransaction(db, async (transaction) => {
          const { agents } = tablesOf(transaction)
          const row = await first(transaction.select().from(agents).where(eq(agents.id, input.id)))
          const current = await requireSystemBuiltin(transaction, input.id, row, input)
          if (current.name === input.newName) return
          const collision = await first(
            transaction
              .select({ id: agents.id })
              .from(agents)
              .where(
                and(
                  eq(agents.ownerUserId, SYSTEM_USER_ID),
                  eq(agents.name, input.newName),
                  ne(agents.id, input.id),
                ),
              ),
          )
          if (collision !== undefined) throw nameConflict(input.newName)
          const changed = await first(
            transaction
              .update(agents)
              .set({ name: input.newName, updatedAt: monotonicNow(current.updatedAt) })
              .where(
                and(
                  eq(agents.id, input.id),
                  eq(agents.ownerUserId, SYSTEM_USER_ID),
                  eq(agents.builtin, true),
                  eq(agents.updatedAt, input.expectedUpdatedAt),
                  eq(agents.aclRevision, input.expectedAclRevision),
                ),
              )
              .returning({ id: agents.id }),
          )
          if (changed === undefined) throw stale(input.id)
        })
      } catch (error) {
        if (isOwnerNameConflict(error)) {
          throw nameConflict(input.newName)
        }
        throw error
      }
    },

    async updateBuiltin(
      input: Parameters<DigitalEmployeeAgentTemplateRepository['updateBuiltin']>[0],
    ): Promise<void> {
      await runResourceCatalogTransaction(db, async (transaction) => {
        await createAgentMutationParticipant(transaction).update(SYSTEM_OWNER, {
          id: input.id,
          fence: {
            expectedUpdatedAt: input.expectedUpdatedAt,
            expectedAclRevision: input.expectedAclRevision,
          },
          guard(current) {
            if (current.ownerUserId !== SYSTEM_USER_ID || current.builtin !== true) {
              throw occupied(input.id)
            }
          },
          patch: () => input.patch,
        })
      })
    },
  })
}
