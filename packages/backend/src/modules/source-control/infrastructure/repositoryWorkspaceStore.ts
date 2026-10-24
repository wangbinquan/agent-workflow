import type {
  RepositoryWorkspaceTaskPorts,
  TaskRepositorySourceSealingParticipant,
} from '../composition/required-ports'
// RFC-359 W4-B6 —— 仓库工作区存储：一份实现，两个 provider 共用。
// 仓库组的图版本核对 + 改写在统一事务里做，PG 侧原本的 `LOCK TABLE … SHARE ROW EXCLUSIVE` 改为引擎能力矩阵的
// 事务级 advisory lock（所有仓库组写入都经本存储，写者之间互斥即等价；SQLite 单写者下 no-op）；
// 凭据擦除后的存储回收也走能力矩阵。
//
// RFC-395 II-b O1：任务引用与 URL sealing 经消费方端口交给 task-execution；
// source-control 只查询自身的仓库 / schedule 事实，分页与 5 秒 facet 缓存保持原边界。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { rawRows, rawExec, type RawRowCodecs } from '@/platform/persistence/queryHelpers'
import { and, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm'

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import {
  affectedRows,
  databaseSessionFor,
  engineOf,
} from '@/platform/persistence/databaseTransaction'
import type {
  RepositoryCredentialSealingMutation,
  RepositoryGroupDeleteResult,
  RepositoryGroupNodeRecord,
  RepositoryGroupRecord,
  RepositoryGroupWriteResult,
  RepositoryWorkspaceStore,
} from '../ports/repositoryWorkspaceStore'
import {
  RepositoryWorkspaceSqlStore,
  type RepositoryWorkspaceSqlExecutor,
} from './repositoryWorkspaceSqlStore'

const REPOSITORY_GROUP_GRAPH_LOCK = 'source-control:repository-groups'

function executor(db: PersistenceDb): RepositoryWorkspaceSqlExecutor {
  return {
    db,
    async all<T extends Record<string, unknown>>(
      query: SQLWrapper,
      codecs?: RawRowCodecs<T>,
    ): Promise<readonly T[]> {
      return await rawRows<T>(db, query, codecs)
    },
    async run(query): Promise<number> {
      return affectedRows(await rawExec(db, query))
    },
  }
}

async function insertGroupNodes(
  tx: PersistenceTx,
  nodes: readonly RepositoryGroupNodeRecord[],
): Promise<void> {
  const { repoGroupNodes } = tablesOf(tx)
  for (const node of nodes) await insertOne(tx, repoGroupNodes, node)
}

function graphVersionsMatch(
  actual: readonly { readonly id: string; readonly version: number }[],
  expected: readonly { readonly id: string; readonly version: number }[],
): boolean {
  if (actual.length !== expected.length) return false
  const expectedById = new Map(expected.map((row) => [row.id, row.version]))
  return actual.every((row) => expectedById.get(row.id) === row.version)
}

async function applySealingMutation(
  tx: PersistenceTx,
  mutation: RepositoryCredentialSealingMutation,
  participant: TaskRepositorySourceSealingParticipant,
): Promise<void> {
  for (const update of mutation.cachedRepoUpdates) {
    const { cachedRepos } = tablesOf(tx)
    await tx.update(cachedRepos).set(update.patch).where(eq(cachedRepos.id, update.id))
  }
  for (const update of mutation.taskRepoUpdates) {
    await participant.updateMount(update.taskId, update.ordinal, update.patch)
  }
  for (const update of mutation.taskUpdates) {
    await participant.updateRequestedSource(update.id, update.patch)
  }
  for (const update of mutation.scheduleUpdates) {
    const { scheduledTasks } = tablesOf(tx)
    await tx
      .update(scheduledTasks)
      .set({ launchPayload: update.launchPayload })
      .where(eq(scheduledTasks.id, update.id))
  }
}

export class DrizzleRepositoryWorkspaceStore
  extends RepositoryWorkspaceSqlStore
  implements RepositoryWorkspaceStore
{
  readonly runtimeIdentity: object

  constructor(
    private readonly db: PersistenceDb,
    taskPorts: RepositoryWorkspaceTaskPorts,
  ) {
    super(executor(db), engineOf(db), taskPorts)
    this.runtimeIdentity = db as object
  }

  async deleteCachedRepoAndDetachGroups(id: string): Promise<void> {
    await databaseSessionFor(this.db).transaction(async (tx) => {
      const { repoGroupNodes, cachedRepos } = tablesOf(tx)
      await tx
        .update(repoGroupNodes)
        .set({
          attachmentKind: null,
          cachedRepoId: null,
          childGroupId: null,
          ref: '',
          subdir: '',
          readonly: false,
        })
        .where(eq(repoGroupNodes.cachedRepoId, id))
      await tx.delete(cachedRepos).where(eq(cachedRepos.id, id))
    })
    this.invalidateCachedRepoFacets()
  }

  async applyCredentialSealingMutation(
    mutation: RepositoryCredentialSealingMutation,
  ): Promise<void> {
    await databaseSessionFor(this.db).transaction(
      async (tx) =>
        await applySealingMutation(tx, mutation, this.taskPorts.sourceSealing.participant(tx)),
    )
  }

  async compactAfterCredentialScrub(): Promise<void> {
    await engineOf(this.db).reclaimScrubbedStorage(this.db)
  }

  async createRepositoryGroup(
    group: RepositoryGroupRecord,
    nodes: readonly RepositoryGroupNodeRecord[],
  ): Promise<'created' | 'name-conflict'> {
    return await databaseSessionFor(this.db).transaction(async (tx) => {
      await engineOf(tx).advisoryLock(tx, REPOSITORY_GROUP_GRAPH_LOCK)
      const { repoGroups } = tablesOf(tx)
      const duplicates = await tx
        .select({ id: repoGroups.id })
        .from(repoGroups)
        .where(sql`lower(${repoGroups.name}) = lower(${group.name})`)
        .limit(1)
      if (duplicates.length > 0) return 'name-conflict'
      await insertOne(tx, repoGroups, group)
      await insertGroupNodes(tx, nodes)
      return 'created'
    })
  }

  async updateRepositoryGroup(input: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly expectedVersion?: number
    readonly expectedGraphVersions: readonly {
      readonly id: string
      readonly version: number
    }[]
    readonly updatedAt: number
    readonly nodes: readonly RepositoryGroupNodeRecord[]
  }): Promise<RepositoryGroupWriteResult> {
    return await databaseSessionFor(this.db).transaction(async (tx) => {
      await engineOf(tx).advisoryLock(tx, REPOSITORY_GROUP_GRAPH_LOCK)
      const { repoGroups, repoGroupNodes } = tablesOf(tx)
      const graphVersions = await tx
        .select({ id: repoGroups.id, version: repoGroups.version })
        .from(repoGroups)
      if (!graphVersionsMatch(graphVersions, input.expectedGraphVersions)) {
        return { status: 'graph-stale' }
      }
      const current = (
        await tx
          .select({ version: repoGroups.version })
          .from(repoGroups)
          .where(eq(repoGroups.id, input.id))
          .limit(1)
      )[0]
      if (current === undefined) return { status: 'missing' }
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        return { status: 'stale', actualVersion: current.version }
      }
      const duplicates = await tx
        .select({ id: repoGroups.id })
        .from(repoGroups)
        .where(sql`lower(${repoGroups.name}) = lower(${input.name})`)
      if (duplicates.some((row) => row.id !== input.id)) {
        return { status: 'name-conflict' }
      }
      await tx.delete(repoGroupNodes).where(eq(repoGroupNodes.groupId, input.id))
      await insertGroupNodes(tx, input.nodes)
      const version = current.version + 1
      await tx
        .update(repoGroups)
        .set({
          name: input.name,
          description: input.description,
          version,
          updatedAt: input.updatedAt,
          schemaVersion: 2,
        })
        .where(eq(repoGroups.id, input.id))
      return { status: 'ok', version }
    })
  }

  async deleteRepositoryGroup(input: {
    readonly id: string
    readonly scheduleIds: readonly string[]
    readonly expectedGraphVersions: readonly {
      readonly id: string
      readonly version: number
    }[]
  }): Promise<RepositoryGroupDeleteResult> {
    return await databaseSessionFor(this.db).transaction(async (tx) => {
      await engineOf(tx).advisoryLock(tx, REPOSITORY_GROUP_GRAPH_LOCK)
      const { repoGroups, memories, repoGroupNodes, scheduledTasks } = tablesOf(tx)
      const graphVersions = await tx
        .select({ id: repoGroups.id, version: repoGroups.version })
        .from(repoGroups)
      if (!graphVersionsMatch(graphVersions, input.expectedGraphVersions)) {
        return { status: 'graph-stale' }
      }
      const memoryRows = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.scopeType, 'repo_group'),
            eq(memories.scopeId, input.id),
            inArray(memories.status, ['candidate', 'approved', 'superseded', 'rejected']),
          ),
        )
      if (memoryRows.length > 0) {
        await tx
          .update(memories)
          .set({ status: 'archived' })
          .where(
            inArray(
              memories.id,
              memoryRows.map((row) => row.id),
            ),
          )
      }
      const references = await tx
        .select({ groupId: repoGroupNodes.groupId })
        .from(repoGroupNodes)
        .where(eq(repoGroupNodes.childGroupId, input.id))
      if (references.length > 0) {
        await tx
          .update(repoGroupNodes)
          .set({
            attachmentKind: null,
            cachedRepoId: null,
            childGroupId: null,
            ref: '',
            subdir: '',
            readonly: false,
          })
          .where(eq(repoGroupNodes.childGroupId, input.id))
      }
      if (input.scheduleIds.length > 0) {
        await tx
          .update(scheduledTasks)
          .set({
            enabled: false,
            nextRunAt: null,
            lastError: `repo group ${input.id} was deleted; re-point this schedule before re-enabling`,
          })
          .where(inArray(scheduledTasks.id, [...input.scheduleIds]))
      }
      await tx.delete(repoGroups).where(eq(repoGroups.id, input.id))
      return {
        status: 'ok',
        archivedMemories: memoryRows.length,
        detachedReferences: references.length,
        disabledSchedules: input.scheduleIds.length,
      }
    })
  }
}

export function composeRepositoryWorkspaceStore(
  db: PersistenceDb,
  taskPorts: RepositoryWorkspaceTaskPorts,
): RepositoryWorkspaceStore {
  return new DrizzleRepositoryWorkspaceStore(db, taskPorts)
}
