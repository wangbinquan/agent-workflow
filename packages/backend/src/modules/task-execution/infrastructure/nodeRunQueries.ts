import type { NodeRunStatus } from '@agent-workflow/shared'
import { and, eq, inArray, isNull, isNotNull, desc, exists, sql, type AnyColumn } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import type {
  NodeRunQueries,
  NodeRunFactsQuery,
  NodeRunFactSnapshot,
} from '../application/ports/nodeRunQueries'
import { humanGateNodeProjectionMember } from './humanGateProjection'
import {
  decodeTaskRollbackCheckpoints,
  decodeTaskCheckpoints,
  decodeTaskCheckpointInheritance,
  taskCheckpointColumns,
} from './taskCheckpointCodec'
import { engineOf } from '@/platform/persistence/databaseTransaction'

function dispatchRunColumns(db: object) {
  const { nodeRuns } = tablesOf(db)
  return {
    id: nodeRuns.id,
    seq: nodeRuns.seq,
    taskId: nodeRuns.taskId,
    nodeId: nodeRuns.nodeId,
    status: nodeRuns.status,
    iteration: nodeRuns.iteration,
    retryIndex: nodeRuns.retryIndex,
    parentNodeRunId: nodeRuns.parentNodeRunId,
    childTaskId: nodeRuns.childTaskId,
    shardKey: nodeRuns.shardKey,
    wgRound: nodeRuns.wgRound,
    reviewIteration: nodeRuns.reviewIteration,
    mergeState: nodeRuns.mergeState,
    forceActivated: nodeRuns.forceActivated,
    startedAt: nodeRuns.startedAt,
    finishedAt: nodeRuns.finishedAt,
    pid: nodeRuns.pid,
    exitCode: nodeRuns.exitCode,
    errorMessage: nodeRuns.errorMessage,
    failureCode: nodeRuns.failureCode,
    opencodeSessionId: nodeRuns.opencodeSessionId,
    rerunCause: nodeRuns.rerunCause,
    supersededByReview: nodeRuns.supersededByReview,
    rolledBack: nodeRuns.rolledBack,
  } as const
}

/** 不在事实查询里排序或挑选；保留调用方原有集合和数据库返回顺序。 */
export function createNodeRunQueries(db: PersistenceDb): NodeRunQueries {
  function selectRows<K extends keyof NodeRunFactSnapshot>(
    input: NodeRunFactsQuery,
    fields?: readonly K[],
  ) {
    const { nodeRuns } = tablesOf(db)
    const selection =
      fields === undefined
        ? undefined
        : Object.fromEntries(fields.map((field) => [field, nodeRuns[field]]))
    const query = (selection === undefined ? db.select() : db.select(selection))
      .from(nodeRuns)
      .where(
        and(
          input.taskIds === undefined ? undefined : inArray(nodeRuns.taskId, [...input.taskIds]),
          input.taskId === undefined ? undefined : eq(nodeRuns.taskId, input.taskId),
          input.nodeId === undefined ? undefined : eq(nodeRuns.nodeId, input.nodeId),
          input.nodeIds === undefined ? undefined : inArray(nodeRuns.nodeId, [...input.nodeIds]),
          input.iteration === undefined ? undefined : eq(nodeRuns.iteration, input.iteration),
          input.runIds === undefined ? undefined : inArray(nodeRuns.id, [...input.runIds]),
          input.shardKey === undefined
            ? undefined
            : input.shardKey === null
              ? isNull(nodeRuns.shardKey)
              : eq(nodeRuns.shardKey, input.shardKey),
          input.parentNodeRunId === undefined
            ? undefined
            : input.parentNodeRunId === null
              ? isNull(nodeRuns.parentNodeRunId)
              : eq(nodeRuns.parentNodeRunId, input.parentNodeRunId),
          input.reviewIteration === undefined
            ? undefined
            : eq(nodeRuns.reviewIteration, input.reviewIteration),
          input.status === undefined ? undefined : eq(nodeRuns.status, input.status),
        ),
      )
    const ordered =
      input.order === undefined
        ? query
        : query.orderBy(
            ...(input.order === 'retry-desc' ? [desc(nodeRuns.retryIndex)] : []),
            engineOf(db).descNullsLast(nodeRuns.seq),
            desc(nodeRuns.id),
          )
    return input.limit === undefined ? ordered : ordered.limit(input.limit)
  }
  const empty = (input: NodeRunFactsQuery) =>
    input.taskIds?.length === 0 || input.runIds?.length === 0 || input.nodeIds?.length === 0
  function factsOf(row: object): NodeRunFactSnapshot {
    const facts = { ...row }
    for (const [, scalar, map] of taskCheckpointColumns) {
      Reflect.deleteProperty(facts, scalar)
      Reflect.deleteProperty(facts, map)
    }
    return facts as NodeRunFactSnapshot
  }
  const queries: NodeRunQueries = {
    async heldSession(runId) {
      const { runtimeSessionLeases } = tablesOf(db)
      return (
        await db
          .select({ sessionId: runtimeSessionLeases.sessionId })
          .from(runtimeSessionLeases)
          .where(eq(runtimeSessionLeases.leaseNodeRunId, runId))
          .limit(1)
      )[0]
    },
    async heldSessionRunIds(taskId) {
      const { runtimeSessionLeases } = tablesOf(db)
      const rows = await db
        .select({ nodeRunId: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.taskId, taskId),
            isNotNull(runtimeSessionLeases.leaseNodeRunId),
          ),
        )
      return [...new Set(rows.flatMap((row) => (row.nodeRunId === null ? [] : [row.nodeRunId])))]
    },
    async listResumeRuns(taskId, mountPaths) {
      const rows = (await selectRows({
        taskId,
      })) as unknown as PersistenceTables['nodeRuns']['$inferSelect'][]
      return rows.map((row) => ({
        ...factsOf(row),
        checkpoints: decodeTaskCheckpoints(row, mountPaths),
        checkpointInheritance: decodeTaskCheckpointInheritance(row),
        rollback: decodeTaskRollbackCheckpoints(row, mountPaths),
      }))
    },
    async humanGateProjection(runIds) {
      if (runIds.length === 0) return []
      const { nodeRuns } = tablesOf(db)
      const rows = await db
        .select()
        .from(nodeRuns)
        .where(inArray(nodeRuns.id, [...runIds]))
      return rows.map(humanGateNodeProjectionMember)
    },
    async listDispatchFacts(input) {
      if (input.runIds?.length === 0) return []
      const { nodeRuns } = tablesOf(db)
      return db
        .select(dispatchRunColumns(db))
        .from(nodeRuns)
        .where(
          and(
            input.taskId === undefined ? undefined : eq(nodeRuns.taskId, input.taskId),
            input.runIds === undefined ? undefined : inArray(nodeRuns.id, [...input.runIds]),
          ),
        )
    },
    async latestPerNode(taskIds) {
      const rows = await queries.listFields({ taskIds, order: 'seq-desc' }, [
        'taskId',
        'nodeId',
        'status',
        'retryIndex',
        'finishedAt',
        'id',
      ])
      const seen = new Set<string>()
      return rows
        .filter((row) => {
          const key = `${row.taskId}\u0000${row.nodeId}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .reverse()
    },
    async read(runId) {
      return (await queries.list({ runIds: [runId], limit: 1 }))[0] ?? null
    },
    async list(input) {
      if (empty(input)) return []
      return (await selectRows(input)).map(factsOf)
    },
    async readFields(runId, fields) {
      return (await queries.listFields({ runIds: [runId], limit: 1 }, fields))[0] ?? null
    },
    async listFields<K extends keyof NodeRunFactSnapshot>(
      input: NodeRunFactsQuery,
      fields: readonly K[],
    ) {
      if (empty(input)) return []
      return (await selectRows(input, fields)) as unknown as Pick<NodeRunFactSnapshot, K>[]
    },
    async readWithCheckpoints(runId) {
      return (await queries.listWithCheckpoints({ runIds: [runId], limit: 1 }))[0] ?? null
    },
    async listWithCheckpoints(input) {
      if (empty(input)) return []
      const { taskRepos } = tablesOf(db)
      const rows = (await selectRows(
        input,
      )) as unknown as PersistenceTables['nodeRuns']['$inferSelect'][]
      if (rows.length === 0) return []
      const repos = await db
        .select({ taskId: taskRepos.taskId, mountPath: taskRepos.mountPath })
        .from(taskRepos)
        .where(inArray(taskRepos.taskId, [...new Set(rows.map((row) => row.taskId))]))
        .orderBy(taskRepos.repoIndex)
      const mounts = new Map<string, string[]>()
      for (const repo of repos) {
        const paths = mounts.get(repo.taskId) ?? []
        paths.push(repo.mountPath)
        mounts.set(repo.taskId, paths)
      }
      return rows.map((row) => ({
        ...factsOf(row),
        checkpoints: decodeTaskCheckpoints(row, mounts.get(row.taskId) ?? ['']),
        checkpointInheritance: decodeTaskCheckpointInheritance(row),
        rollback: decodeTaskRollbackCheckpoints(row, mounts.get(row.taskId) ?? ['']),
      }))
    },
  }
  return queries
}

/** 同语句的跨上下文事实谓词，保留待评审计数原有 JOIN 的存在性语义。 */
export function nodeRunStatusCondition(db: PersistenceDb, runId: AnyColumn, status: NodeRunStatus) {
  const { nodeRuns } = tablesOf(db)
  return exists(
    db
      .select({ one: sql`1` })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.id, runId), eq(nodeRuns.status, status))),
  )
}
