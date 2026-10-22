// RFC-359 W4-B6 —— 仓库工作区存储：一份实现，两个 provider 共用。
// 仓库组的图版本核对 + 改写在统一事务里做，PG 侧原本的 `LOCK TABLE … SHARE ROW EXCLUSIVE` 改为引擎能力矩阵的
// 事务级 advisory lock（所有仓库组写入都经本存储，写者之间互斥即等价；SQLite 单写者下 no-op）；
// 凭据擦除后的存储回收也走能力矩阵。
//
// RFC-359 W8-T26：facets 聚合原本靠 `engine.indexHint()` 在 SQLite 侧渲染 `INDEXED BY` 压住
// 一个逐行相关子查询，PostgreSQL 无对应语法只能硬吃。改成「每格一条标量子查询、`exists` 回到
// WHERE 里」（形状与实测见 `repositoryWorkspaceSqlStore.referencedFacetCounts`）之后两个引擎
// 各自都能上提成 semi/anti join，索引提示随之退场——两个引擎都自选到了覆盖索引。

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
    async cachedRepoFacets(input) {
      const { cachedRepos } = tablesOf(db)
      // 每格一条标量子查询：`exists` 回到 WHERE 子句里，两个 planner 都会把它上提成
      // semi/anti join；外层是一行常量，所以每格只求值一次。为什么不是一次聚合扫描、
      // 也不是预聚合 + LEFT JOIN，见 `repositoryWorkspaceSqlStore.referencedFacetCounts`。
      const rows = await rawRows<{
        all_count: number
        explicit_count: number
        legacy_count: number
        scheduled_count: number
        attention_count: number
      }>(
        db,
        sql`
        SELECT
          (SELECT count(*) FROM ${cachedRepos}) AS all_count,
          (SELECT count(*) FROM ${cachedRepos} WHERE ${input.explicit}) AS explicit_count,
          (SELECT count(*) FROM ${cachedRepos} WHERE ${input.legacyOnly}) AS legacy_count,
          (SELECT count(*) FROM ${cachedRepos} WHERE ${input.scheduledOnly}) AS scheduled_count,
          (SELECT count(*) FROM ${cachedRepos} WHERE ${input.attention}) AS attention_count
      `,
        {
          all_count: 'int',
          explicit_count: 'int',
          legacy_count: 'int',
          scheduled_count: 'int',
          attention_count: 'int',
        },
      )
      return (
        rows[0] ?? {
          all_count: 0,
          explicit_count: 0,
          legacy_count: 0,
          scheduled_count: 0,
          attention_count: 0,
        }
      )
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
): Promise<void> {
  for (const update of mutation.cachedRepoUpdates) {
    const { cachedRepos } = tablesOf(tx)
    await tx.update(cachedRepos).set(update.patch).where(eq(cachedRepos.id, update.id))
  }
  for (const update of mutation.taskRepoUpdates) {
    const { taskRepos } = tablesOf(tx)
    await tx
      .update(taskRepos)
      .set(update.patch)
      .where(and(eq(taskRepos.taskId, update.taskId), eq(taskRepos.repoIndex, update.repoIndex)))
  }
  for (const update of mutation.taskUpdates) {
    const { tasks } = tablesOf(tx)
    await tx.update(tasks).set(update.patch).where(eq(tasks.id, update.id))
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

  constructor(private readonly db: PersistenceDb) {
    super(executor(db), engineOf(db))
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
      async (tx) => await applySealingMutation(tx, mutation),
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

export function composeRepositoryWorkspaceStore(db: PersistenceDb): RepositoryWorkspaceStore {
  return new DrizzleRepositoryWorkspaceStore(db)
}
