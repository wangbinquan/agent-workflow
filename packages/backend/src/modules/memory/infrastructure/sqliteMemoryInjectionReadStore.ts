import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { cachedRepos, memories, nodeRuns, tasks, taskRepos } from '@/db/schema'
import type {
  MemoryInjectionReadStore,
  MemoryInjectionRecord,
} from '../application/ports/injectionReadStore'

const INJECTION_COLUMNS = {
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

export class SqliteMemoryInjectionReadStore implements MemoryInjectionReadStore {
  constructor(private readonly db: DbClient) {}

  async findTaskContext(taskId: string) {
    const row = this.db
      .select({
        workflowId: tasks.workflowId,
        cachedRepoId: tasks.cachedRepoId,
        repoGroupId: tasks.repoGroupId,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
      .get()
    return row === undefined
      ? null
      : {
          workflowId: row.workflowId,
          cachedRepoId: row.cachedRepoId,
          repoGroupId: row.repoGroupId,
        }
  }

  async listTaskRepositoryIds(taskId: string): Promise<readonly string[]> {
    return this.db
      .select({ cachedRepoId: taskRepos.cachedRepoId })
      .from(taskRepos)
      .where(eq(taskRepos.taskId, taskId))
      .all()
      .flatMap((row) => (row.cachedRepoId === null ? [] : [row.cachedRepoId]))
  }

  async filterExistingRepositoryIds(repositoryIds: readonly string[]): Promise<readonly string[]> {
    if (repositoryIds.length === 0) return []
    return this.db
      .select({ id: cachedRepos.id })
      .from(cachedRepos)
      .where(inArray(cachedRepos.id, [...repositoryIds]))
      .all()
      .map((row) => row.id)
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
    return this.db
      .select(INJECTION_COLUMNS)
      .from(memories)
      .where(and(scopeCondition, eq(memories.status, 'approved')))
      .orderBy(desc(memories.createdAt))
      .all()
      .map(recordOf)
  }

  async listRunRecords(input: Parameters<MemoryInjectionReadStore['listRunRecords']>[0]) {
    return this.db
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
      .all()
  }
}
