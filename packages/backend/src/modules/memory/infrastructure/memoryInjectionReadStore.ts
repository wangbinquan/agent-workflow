// RFC-359 W4-B4 —— 记忆注入读存储：一份实现，两个 provider 共用。

import { createTaskKnowledgeQueries } from '@/modules/task-execution/public/queries'
import { existingRepositoryIds } from '@/modules/source-control/public/queries'
import { createNodeRunQueries } from '@/modules/task-execution/public/queries'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, desc, eq, inArray } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
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
function injectionColumns(db: object) {
  const { memories } = tablesOf(db)
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
  constructor(private readonly db: PersistenceDb) {}

  async findTaskContext(taskId: string) {
    return createTaskKnowledgeQueries(this.db).injectionContext(taskId)
  }

  async listTaskRepositoryIds(taskId: string): Promise<readonly string[]> {
    return createTaskKnowledgeQueries(this.db).repositoryIds(taskId)
  }

  async filterExistingRepositoryIds(repositoryIds: readonly string[]): Promise<readonly string[]> {
    return existingRepositoryIds(this.db, repositoryIds)
  }

  async listApprovedMemories(
    input: Parameters<MemoryInjectionReadStore['listApprovedMemories']>[0],
  ): Promise<readonly MemoryInjectionRecord[]> {
    const ids = input.scopeIds
    if (ids !== null && ids.length === 0) return []
    const { memories } = tablesOf(this.db)
    const scopeCondition =
      ids === null
        ? eq(memories.scopeType, input.scopeType)
        : and(eq(memories.scopeType, input.scopeType), inArray(memories.scopeId, [...ids]))!
    return (
      await this.db
        .select(injectionColumns(this.db))
        .from(memories)
        .where(and(scopeCondition, eq(memories.status, 'approved')))
        .orderBy(desc(memories.createdAt))
    ).map(recordOf)
  }

  async listRunRecords(input: Parameters<MemoryInjectionReadStore['listRunRecords']>[0]) {
    return createNodeRunQueries(this.db).listFields(
      {
        taskId: input.taskId,
        nodeId: input.nodeId,
        iteration: input.iteration,
        shardKey: input.shardKey,
        reviewIteration: input.reviewIteration,
        parentNodeRunId: null,
      },
      ['id', 'seq', 'status', 'injectedMemoriesJson'],
    )
  }
}
