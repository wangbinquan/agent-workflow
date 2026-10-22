// RFC-359 W4-B1 —— 运行时会话捕获持久化：一份实现，两个 provider 共用；写入走 ownedTaskExecution 的统一写事务 + 围栏。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryWrite } from '@/platform/persistence/queryHelpers'
import { and, eq, inArray, ne } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import { insertInBatches } from '@/platform/persistence/batchInsert'
import type { RuntimeSessionCapturePersistence } from '../application/ports/runtimeSessionCapturePersistence'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'

export function createRuntimeSessionCapturePersistence(
  db: PersistenceDb,
): RuntimeSessionCapturePersistence {
  return Object.freeze({
    async resolveTaskId(
      nodeRunId: Parameters<RuntimeSessionCapturePersistence['resolveTaskId']>[0],
    ) {
      const { nodeRuns } = tablesOf(db)
      const rows = await db
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
      return rows[0]?.taskId ?? null
    },
    async listSiblingCapturedSessionIds(
      input: Parameters<RuntimeSessionCapturePersistence['listSiblingCapturedSessionIds']>[0],
    ) {
      const { nodeRuns, nodeRunEvents } = tablesOf(db)
      const siblings = await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, input.taskId), ne(nodeRuns.id, input.nodeRunId)))
      if (siblings.length === 0) return new Set<string>()
      const rows = await db
        .selectDistinct({ sessionId: nodeRunEvents.sessionId })
        .from(nodeRunEvents)
        .where(
          inArray(
            nodeRunEvents.nodeRunId,
            siblings.map((row) => row.id),
          ),
        )
      return new Set(
        rows.flatMap((row) =>
          row.sessionId === null || row.sessionId.length === 0 ? [] : [row.sessionId],
        ),
      )
    },
    async appendEvents(input: Parameters<RuntimeSessionCapturePersistence['appendEvents']>[0]) {
      if (input.events.length === 0) return
      await withTaskExecutionWrite(db, async (tx) => {
        await fenceTaskWrite(tx, { taskId: input.taskId })
        const { nodeRunEvents } = tablesOf(tx)
        // RFC-359 W6-T25 —— 会话回捕的事件按批落库：一次 capture 的行数由子会话 transcript 决定，
        // 无界。切批在同一笔事务里，原子性不变；行数上限由能力矩阵给。
        await insertInBatches(
          tx,
          nodeRunEvents,
          input.events.map((event: (typeof input.events)[number]) => ({
            nodeRunId: input.nodeRunId,
            ts: event.ts,
            kind: event.kind,
            payload: event.payload,
            sessionId: event.sessionId,
            parentSessionId: event.parentSessionId,
          })),
          (batch) => {
            return queryWrite(tx.insert(nodeRunEvents).values([...batch]))
          },
        )
      })
    },
  })
}
