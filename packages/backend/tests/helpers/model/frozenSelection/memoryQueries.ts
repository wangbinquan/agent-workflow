import { nodeRunFixtureColumns } from '../nodeRun'
// Frozen predicates/order from 67ab6b9aed08d97dcd6d3d9dfb57b8885a11f8e6; target columns supply the same scalar facts.
// Sources: packages/backend/src/modules/memory/infrastructure/memoryInjectionReadStore.ts, packages/backend/src/modules/memory/infrastructure/memoryDistillWorkStore.ts.
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { MemoryInjectionReadStore } from '@/modules/memory/application/ports/injectionReadStore'
export class FrozenMemoryInjectionQueries {
  constructor(private readonly db: PersistenceDb) {}
  async listRunRecords(input: Parameters<MemoryInjectionReadStore['listRunRecords']>[0]) {
    const { nodeRuns } = tablesOf(this.db)
    const facts = nodeRunFixtureColumns(this.db)
    return await this.db
      .select({
        id: nodeRuns.id,
        seq: nodeRuns.seq,
        status: nodeRuns.status,
        injectedMemoriesJson: facts.injectedMemoriesJson,
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
          isNull(nodeRuns.historicalParentId),
        ),
      )
  }
}
export class FrozenMemoryDistillQueries {
  constructor(private readonly db: PersistenceDb) {}
  async listAgentRunSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    const { nodeRuns } = tablesOf(this.db)
    const facts = nodeRunFixtureColumns(this.db)
    return await this.db
      .select({
        id: nodeRuns.id,
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        startedAt: nodeRuns.startedAt,
        finishedAt: nodeRuns.finishedAt,
        errorMessage: nodeRuns.errorMessage,
        failureCode: nodeRuns.failureCode,
        promptText: facts.promptText,
        promptPath: facts.promptPath,
        opencodeSessionId: facts.opencodeSessionId,
        injectedMemoriesJson: facts.injectedMemoriesJson,
      })
      .from(nodeRuns)
      .where(inArray(nodeRuns.id, [...ids]))
  }
  async listTaskNodeStatuses(taskIds: readonly string[]) {
    if (taskIds.length === 0) return []
    const { nodeRuns } = tablesOf(this.db)
    const facts = nodeRunFixtureColumns(this.db)
    const rows = await this.db
      .select({
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        retryIndex: facts.retryIndex,
        finishedAt: nodeRuns.finishedAt,
        id: nodeRuns.id,
      })
      .from(nodeRuns)
      .where(inArray(nodeRuns.taskId, [...taskIds]))
      .orderBy(engineOf(this.db).descNullsLast(nodeRuns.seq), desc(nodeRuns.id))
    const seen = new Set<string>()
    const latest: {
      taskId: string
      nodeId: string
      nodeRunId: string
      status: string
      retryIndex: number
      finishedAt: number | null
    }[] = []
    for (const row of rows) {
      const key = `${row.taskId}\u0000${row.nodeId}`
      if (seen.has(key)) continue
      seen.add(key)
      latest.push({
        taskId: row.taskId,
        nodeId: row.nodeId,
        nodeRunId: row.id,
        status: row.status,
        retryIndex: row.retryIndex ?? 0,
        finishedAt: row.finishedAt,
      })
    }
    return latest.reverse()
  }
  async listNodeRuns(ids: readonly string[]) {
    if (ids.length === 0) return []
    const { nodeRuns } = tablesOf(this.db)
    const facts = nodeRunFixtureColumns(this.db)
    return await this.db
      .select({
        id: nodeRuns.id,
        promptText: facts.promptText,
        promptPath: facts.promptPath,
        startedAt: nodeRuns.startedAt,
        opencodeSessionId: facts.opencodeSessionId,
      })
      .from(nodeRuns)
      .where(inArray(nodeRuns.id, [...ids]))
  }
}
