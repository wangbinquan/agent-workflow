// RFC-359 W4-B4 —— 记忆注入读存储：一份实现，两个 provider 共用。

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { cachedRepos, memories, nodeRuns, tasks, taskRepos } from '@/db/schema'
import type {
  MemoryInjectionReadStore,
  MemoryInjectionRecord,
} from '../application/ports/injectionReadStore'

/**
 * 每次查询时再取列：`@/db/schema` 的表是按当前 provider 投影的代理，模块加载时捕获的列对象会
 * 固定在当时激活的 provider 上——PG 进程里若在切换投影前 import 了本文件，bigint 列的
 * number mapper 就会丢失，createdAt / version / approvedAt 以字符串回到调用方
 * （RFC-359 W4-B4a 双引擎用例实测；老的 PG 适配器同样以顶层常量捕获，同一缺陷）。
 */
function injectionColumns() {
  return {
    id: memories.id,
    scopeType: memories.scopeType,
    scopeId: memories.scopeId,
    title: memories.title,
    bodyMd: memories.bodyMd,
    createdAt: memories.createdAt,
    version: memories.version,
    tagsJson: memories.tags,
    sourceKind: memories.sourceKind,
    approvedAt: memories.approvedAt,
  }
}

function recordOf(row: MemoryInjectionRecord): MemoryInjectionRecord {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    bodyMd: row.bodyMd,
    createdAt: row.createdAt,
    version: row.version,
    tagsJson: row.tagsJson,
    sourceKind: row.sourceKind,
    approvedAt: row.approvedAt,
  }
}

export class DrizzleMemoryInjectionReadStore implements MemoryInjectionReadStore {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async findTaskContext(taskId: string) {
    const rows = await this.db
      .select({
        workflowId: tasks.workflowId,
        cachedRepoId: tasks.cachedRepoId,
        repoGroupId: tasks.repoGroupId,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    const row = rows[0]
    return row === undefined
      ? null
      : {
          workflowId: row.workflowId,
          cachedRepoId: row.cachedRepoId,
          repoGroupId: row.repoGroupId,
        }
  }

  async listTaskRepositoryIds(taskId: string): Promise<readonly string[]> {
    return (
      await this.db
        .select({ cachedRepoId: taskRepos.cachedRepoId })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, taskId))
    ).flatMap((row) => (row.cachedRepoId === null ? [] : [row.cachedRepoId]))
  }

  async filterExistingRepositoryIds(repositoryIds: readonly string[]): Promise<readonly string[]> {
    if (repositoryIds.length === 0) return []
    return (
      await this.db
        .select({ id: cachedRepos.id })
        .from(cachedRepos)
        .where(inArray(cachedRepos.id, [...repositoryIds]))
        .limit(repositoryIds.length)
    ).map((row) => row.id)
  }

  async listApprovedMemories(
    input: Parameters<MemoryInjectionReadStore['listApprovedMemories']>[0],
  ): Promise<readonly MemoryInjectionRecord[]> {
    const ids = input.scopeIds
    if (ids !== null && ids.length === 0) return []
    const scopeCondition =
      ids === null
        ? eq(memories.scopeType, input.scopeType)
        : and(eq(memories.scopeType, input.scopeType), inArray(memories.scopeId, [...ids]))!
    return (
      await this.db
        .select(injectionColumns())
        .from(memories)
        .where(and(scopeCondition, eq(memories.status, 'approved')))
        .orderBy(desc(memories.createdAt))
    ).map(recordOf)
  }

  async listRunRecords(input: Parameters<MemoryInjectionReadStore['listRunRecords']>[0]) {
    return await this.db
      .select({
        id: nodeRuns.id,
        status: nodeRuns.status,
        injectedMemoriesJson: nodeRuns.injectedMemoriesJson,
      })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, input.taskId),
          eq(nodeRuns.nodeId, input.nodeId),
          eq(nodeRuns.iteration, input.iteration),
          input.shardKey === null
            ? isNull(nodeRuns.shardKey)
            : eq(nodeRuns.shardKey, input.shardKey),
          eq(nodeRuns.reviewIteration, input.reviewIteration),
          isNull(nodeRuns.parentNodeRunId),
        ),
      )
  }
}
