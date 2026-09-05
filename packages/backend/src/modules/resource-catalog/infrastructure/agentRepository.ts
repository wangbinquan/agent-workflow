import type { Agent, CreateAgent, UpdateAgent } from '@agent-workflow/shared'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import { agents } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import type { AgentRepository } from '../application/agents/ports'
import type { AgentOperationContext } from '../public/participants'
import type { AgentReferenceLabels, AgentReferenceLabelsInput } from '../public/types'
import {
  agentFromPersistenceRow,
  createAgentPersistenceValues,
  updateAgentPersistenceValues,
} from './agentPersistence'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

/** Owner-native semantics injected into the Agent repository（一份合同，两个 provider 共用）。 */
export interface AgentPersistenceSemantics {
  canonicalizeCreate(
    authority: AgentOperationContext,
    input: CreateAgent,
    id: string,
  ): Promise<CreateAgent>
  canonicalizeUpdate(
    authority: AgentOperationContext,
    current: Agent,
    patch: UpdateAgent,
  ): Promise<UpdateAgent>
  assertCreateInTransaction(
    transaction: ResourceCatalogTransaction,
    authority: AgentOperationContext,
    candidate: Agent,
  ): Promise<void>
  assertUpdateInTransaction(
    transaction: ResourceCatalogTransaction,
    authority: AgentOperationContext,
    current: Agent,
    candidate: Agent,
  ): Promise<void>
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

function ownerScopedNameWhere(ownerUserId: string | null, name: string, excludeId?: string) {
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
 */
export function createAgentRepository(input: {
  readonly db: ProviderNeutralDatabase
  readonly semantics: AgentPersistenceSemantics
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

  async function get(id: string): Promise<Agent | null> {
    const row = (await input.db.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
    return row === undefined ? null : agentFromPersistenceRow(row)
  }

  const repository: AgentRepository = {
    async list(): Promise<readonly Agent[]> {
      return (await input.db.select().from(agents)).map(agentFromPersistenceRow)
    },
    get,
    async create(authority, submitted): Promise<Agent> {
      const id = mintId()
      const canonical = await input.semantics.canonicalizeCreate(authority, submitted, id)
      const values = createAgentPersistenceValues({
        id,
        agent: canonical,
        ownerUserId: authority.user.id,
        now: now(),
      })
      const candidate = agentFromPersistenceRow(values)
      try {
        return await runResourceCatalogTransaction(input.db, async (transaction) => {
          await input.semantics.assertCreateInTransaction(transaction, authority, candidate)
          const created = await transaction.insert(agents).values(values).returning().all()
          if (created.length !== 1) throw new Error('agent insert did not return one row')
          return agentFromPersistenceRow(created[0]!)
        })
      } catch (error) {
        if (isOwnerNameConflict(error)) {
          throw nameConflict(candidate.name)
        }
        throw error
      }
    },
    async update(authority, id, submitted, fence): Promise<Agent> {
      const current = await get(id)
      if (current === null) throw new NotFoundError('agent-not-found', 'agent not found')
      const patch = await input.semantics.canonicalizeUpdate(authority, current, submitted)
      const updatedAt = monotonicNow(current.updatedAt)
      const set = updateAgentPersistenceValues(current, patch, updatedAt)
      const { runtime: _currentRuntime, ...currentWithoutRuntime } = current
      const { runtime: submittedRuntime, ...patchWithoutRuntime } = patch
      const runtime = submittedRuntime === null ? undefined : (submittedRuntime ?? current.runtime)
      const candidate: Agent = {
        ...currentWithoutRuntime,
        ...patchWithoutRuntime,
        ...(runtime === undefined ? {} : { runtime }),
        updatedAt,
      }
      return runResourceCatalogTransaction(input.db, async (transaction) => {
        const row = (await transaction.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
        if (row === undefined) throw new NotFoundError('agent-not-found', 'agent not found')
        const fresh = agentFromPersistenceRow(row)
        if (
          fresh.updatedAt !== fence.expectedUpdatedAt ||
          (fresh.aclRevision ?? 0) !== fence.expectedAclRevision
        ) {
          throw stale(id)
        }
        await input.semantics.assertUpdateInTransaction(transaction, authority, fresh, candidate)
        const changed = await transaction
          .update(agents)
          .set(set)
          .where(
            and(
              eq(agents.id, id),
              eq(agents.updatedAt, fence.expectedUpdatedAt),
              eq(agents.aclRevision, fence.expectedAclRevision),
            ),
          )
          .returning()
        if (changed.length !== 1) throw stale(id)
        return agentFromPersistenceRow(changed[0]!)
      })
    },
    async delete(authority, id, fence): Promise<void> {
      await runResourceCatalogTransaction(input.db, async (transaction) => {
        const row = (await transaction.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
        if (row === undefined) throw new NotFoundError('agent-not-found', 'agent not found')
        const current = agentFromPersistenceRow(row)
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
          const row = (await transaction.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
          if (row === undefined) throw new NotFoundError('agent-not-found', 'agent not found')
          const current = agentFromPersistenceRow(row)
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
              .where(ownerScopedNameWhere(current.ownerUserId ?? null, rename.newName, id))
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
          return agentFromPersistenceRow(changed[0]!)
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
