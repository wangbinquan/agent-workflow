// RFC-359 W4-B6 —— 仓库工作区存储：一份实现，两个 provider 共用。
// 仓库组的图版本核对 + 改写在统一事务里做，PG 侧原本的 `LOCK TABLE … SHARE ROW EXCLUSIVE` 改为引擎能力矩阵的
// 事务级 advisory lock（所有仓库组写入都经本存储，写者之间互斥即等价；SQLite 单写者下 no-op）；
// 聚合的索引提示与凭据擦除后的存储回收也走能力矩阵。

import { and, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  memories,
  repoGroupNodes,
  repoGroups,
  scheduledTasks,
  taskRepos,
  tasks,
} from '@/db/schema'
import {
  affectedRows,
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
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

function executor(db: ProviderNeutralDatabase): RepositoryWorkspaceSqlExecutor {
  const engine = engineOf(db)
  return {
    async all<T extends Record<string, unknown>>(query: SQLWrapper): Promise<readonly T[]> {
      return (await db.all(query)) as readonly T[]
    },
    async run(query): Promise<number> {
      return affectedRows(await db.run(query))
    },
    async cachedRepoFacets(input) {
      const rows = await db.all<{
        all_count: number
        referenced_count: number
        attention_count: number
      }>(sql`
        SELECT
          count(*) AS all_count,
          sum(case when ${input.referenced} then 1 else 0 end) AS referenced_count,
          sum(case when ${input.attention} then 1 else 0 end) AS attention_count
        FROM ${cachedRepos} ${engine.indexHint('idx_cached_repos_fetched_id')}
      `)
      return rows[0] ?? { all_count: 0, referenced_count: 0, attention_count: 0 }
    },
  }
}

async function insertGroupNodes(
  tx: DatabaseTransaction,
  nodes: readonly RepositoryGroupNodeRecord[],
): Promise<void> {
  for (const node of nodes) await tx.insert(repoGroupNodes).values(node)
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
  tx: DatabaseTransaction,
  mutation: RepositoryCredentialSealingMutation,
): Promise<void> {
  for (const update of mutation.cachedRepoUpdates) {
    await tx.update(cachedRepos).set(update.patch).where(eq(cachedRepos.id, update.id))
  }
  for (const update of mutation.taskRepoUpdates) {
    await tx
      .update(taskRepos)
      .set(update.patch)
      .where(and(eq(taskRepos.taskId, update.taskId), eq(taskRepos.repoIndex, update.repoIndex)))
  }
  for (const update of mutation.taskUpdates) {
    await tx.update(tasks).set(update.patch).where(eq(tasks.id, update.id))
  }
  for (const update of mutation.scheduleUpdates) {
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

  constructor(private readonly db: ProviderNeutralDatabase) {
    super(executor(db))
    this.runtimeIdentity = db as object
  }

  async deleteCachedRepoAndDetachGroups(id: string): Promise<void> {
    await databaseSessionFor(this.db).transaction(async (tx) => {
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
      const duplicates = await tx
        .select({ id: repoGroups.id })
        .from(repoGroups)
        .where(sql`lower(${repoGroups.name}) = lower(${group.name})`)
        .limit(1)
      if (duplicates.length > 0) return 'name-conflict'
      await tx.insert(repoGroups).values(group)
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
  db: ProviderNeutralDatabase,
): RepositoryWorkspaceStore {
  return new DrizzleRepositoryWorkspaceStore(db)
}
