import { tablesOf } from '@/platform/persistence/sessionTables'
import type { Agent } from '@agent-workflow/shared'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import type { AgentRepository } from '../application/agents/ports'
import type { AgentOperationContext } from '../public/participants'
import type { AgentReferenceLabels, AgentReferenceLabelsInput } from '../public/types'
import { loadAgentPersistenceRow, loadAgentPersistenceRows } from './agentPersistence'
import {
  createAgentMutationParticipant,
  type AgentRuntimeProfileLookup,
} from './agentMutationParticipant'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

/**
 * Owner-native semantics injected into the Agent repository（一份合同，两个 provider 共用）。
 *
 * RFC-401 A1：创建 / 更新的规范化与校验在唯一的 agent 写入参与者里；这里只剩普通 CRUD 独有的删除闸与引用标签。
 */
export interface AgentPersistenceSemantics {
  assertDeleteInTransaction(
    transaction: ResourceCatalogTransaction,
    authority: AgentOperationContext,
    current: Agent,
  ): Promise<void>
  referenceLabels(
    authority: AgentOperationContext,
    input: AgentReferenceLabelsInput,
  ): Promise<AgentReferenceLabels>
}

function ownerScopedNameWhere(
  db: object,
  ownerUserId: string | null,
  name: string,
  excludeId?: string,
) {
  const { agents } = tablesOf(db)
  const owner =
    ownerUserId === null ? isNull(agents.ownerUserId) : eq(agents.ownerUserId, ownerUserId)
  const identity = and(owner, eq(agents.name, name))
  return excludeId === undefined ? identity : and(identity, ne(agents.id, excludeId))
}

function nameConflict(name: string, rename = false): ConflictError {
  return new ConflictError(
    'agent-name-in-use',
    rename
      ? `agent '${name}' already exists; pick a different name`
      : `agent '${name}' already exists`,
  )
}

function stale(id: string): ConflictError {
  return staleConflictError('agent', `agent '${id}' changed; reload and retry`)
}

/**
 * RFC-359 W4-D14 —— Agent 仓库：一份实现，两个 provider 共用。写路径全部在统一的 serializable 事务里
 * （PG 抬升隔离级别并按 40001 重试，SQLite 独占事务），owner + name 的唯一冲突经能力矩阵 `uniqueViolationTarget`
 * 映射回 `agent-name-in-use`（PG 给约束名 `agents_owner_name_unique`，SQLite 给列清单 `agents.owner_user_id, …`）。
 *
 * RFC-401 A1：create / update 经唯一的 agent 写入参与者（Intent、资源包、模板同用）；`runtimes` 是注入给参与者的
 * runtime registry 查询。
 */
export function createAgentRepository(input: {
  readonly db: PersistenceDb
  readonly semantics: AgentPersistenceSemantics
  readonly runtimes?: AgentRuntimeProfileLookup
  readonly id?: () => string
  readonly now?: () => number
}): AgentRepository {
  const mintId = input.id ?? ulid
  const now = input.now ?? Date.now
  const engine = databaseSessionFor(input.db).engine
  const isOwnerNameConflict = (error: unknown): boolean => {
    const target = engine.uniqueViolationTarget(error)
    return target !== undefined && /agents[._]owner/i.test(target)
  }

  const mutations = (transaction: ResourceCatalogTransaction) =>
    createAgentMutationParticipant(transaction, {
      ...(input.runtimes === undefined ? {} : { runtimes: input.runtimes }),
      now,
    })

  async function get(id: string): Promise<Agent | null> {
    return loadAgentPersistenceRow(input.db, async (tx) => {
      const { agents } = tablesOf(tx)
      return (await tx.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
    })
  }

  const repository: AgentRepository = {
    async list(): Promise<readonly Agent[]> {
      return loadAgentPersistenceRows(input.db, async (tx) => tx.select().from(tablesOf(tx).agents))
    },
    get,
    async create(authority, submitted): Promise<Agent> {
      const id = mintId()
      return runResourceCatalogTransaction(input.db, (transaction) =>
        mutations(transaction).create(
          { kind: 'actor', actor: authority },
          { id, agent: submitted },
        ),
      )
    },
    async update(authority, id, submitted, fence): Promise<Agent> {
      return runResourceCatalogTransaction(input.db, (transaction) =>
        mutations(transaction).update(
          { kind: 'actor', actor: authority },
          { id, fence, patch: () => submitted },
        ),
      )
    },
    async delete(authority, id, fence): Promise<void> {
      await runResourceCatalogTransaction(input.db, async (transaction) => {
        const { agents } = tablesOf(transaction)
        const row = (await transaction.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
        if (row === undefined) throw new NotFoundError('agent-not-found', 'agent not found')
        const current = await loadAgentPersistenceRow(transaction, row)
        if (
          current.updatedAt !== fence.expectedUpdatedAt ||
          (current.aclRevision ?? 0) !== fence.expectedAclRevision
        ) {
          throw stale(id)
        }
        await input.semantics.assertDeleteInTransaction(transaction, authority, current)
        const deleted = await transaction
          .delete(agents)
          .where(
            and(
              eq(agents.id, id),
              eq(agents.updatedAt, fence.expectedUpdatedAt),
              eq(agents.aclRevision, fence.expectedAclRevision),
            ),
          )
          .returning({ id: agents.id })
        if (deleted.length !== 1) throw stale(id)
      })
    },
    async rename(authority, id, rename, fence): Promise<Agent> {
      try {
        return await runResourceCatalogTransaction(input.db, async (transaction) => {
          const { agents } = tablesOf(transaction)
          const row = (await transaction.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
          if (row === undefined) throw new NotFoundError('agent-not-found', 'agent not found')
          const current = await loadAgentPersistenceRow(transaction, row)
          if (
            current.updatedAt !== fence.expectedUpdatedAt ||
            (current.aclRevision ?? 0) !== fence.expectedAclRevision
          ) {
            throw stale(id)
          }
          if (current.name === rename.newName) return current
          const collision = (
            await transaction
              .select({ id: agents.id })
              .from(agents)
              .where(
                ownerScopedNameWhere(transaction, current.ownerUserId ?? null, rename.newName, id),
              )
              .limit(1)
          )[0]
          if (collision !== undefined) throw nameConflict(rename.newName, true)
          const changed = await transaction
            .update(agents)
            .set({ name: rename.newName, updatedAt: monotonicNow(current.updatedAt) })
            .where(
              and(
                eq(agents.id, id),
                eq(agents.updatedAt, fence.expectedUpdatedAt),
                eq(agents.aclRevision, fence.expectedAclRevision),
              ),
            )
            .returning()
          if (changed.length !== 1) throw stale(id)
          return loadAgentPersistenceRow(transaction, changed[0]!)
        })
      } catch (error) {
        if (isOwnerNameConflict(error)) {
          throw nameConflict(rename.newName, true)
        }
        throw error
      }
    },
    referenceLabels: (authority, labelsInput) =>
      input.semantics.referenceLabels(authority, labelsInput),
  }
  return Object.freeze(repository)
}
