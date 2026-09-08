// RFC-359 AC1: one database store for the shared node-event archive mechanism.
// The driver may return raw aggregate numbers as strings. Convert at this
// persistence edge; the archive cursor and JSONL always contain numbers.
import { and, asc, count, eq, gt, inArray, lte, sql } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRunEvents, nodeRuns } from '@/db/schema'
import { readMaintenanceValue, writeMaintenanceValue } from './maintenanceState'
import type {
  EventsArchiveRow,
  EventsArchiveStore,
} from '@/platform/background/eventsArchiveStorePort'

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function eventRow(row: {
  readonly id: unknown
  readonly ts: unknown
  readonly kind: string
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
}): EventsArchiveRow {
  return {
    id: numberValue(row.id),
    ts: numberValue(row.ts),
    kind: row.kind,
    payload: row.payload,
    sessionId: row.sessionId,
    parentSessionId: row.parentSessionId,
  }
}

export function createEventsArchiveStore(db: ProviderNeutralDatabase): EventsArchiveStore {
  const store: EventsArchiveStore = {
    readState: (key) => readMaintenanceValue(db, key),
    writeState: (key, value, now) => writeMaintenanceValue(db, key, value, now),
    async averageRecentPayloadBytes(limit) {
      const rows = await db.all<{ avg: unknown }>(sql`
        SELECT AVG(LENGTH(payload)) AS avg FROM (
          SELECT ${nodeRunEvents.payload} AS payload
          FROM ${nodeRunEvents}
          ORDER BY ${nodeRunEvents.id} DESC
          LIMIT ${limit}
        ) sampled
      `)
      const value = rows[0]?.avg
      return value === null || value === undefined ? null : numberValue(value)
    },
    async maxEventId() {
      const rows = await db
        .select({ value: sql<unknown>`max(${nodeRunEvents.id})` })
        .from(nodeRunEvents)
      return numberValue(rows[0]?.value)
    },
    async countEventIds(input) {
      const conditions = [
        gt(nodeRunEvents.id, input.afterId),
        lte(nodeRunEvents.id, input.throughId),
      ]
      if (input.nodeRunId !== undefined) {
        conditions.push(eq(nodeRunEvents.nodeRunId, input.nodeRunId))
      }
      const rows = await db
        .select({ value: count(nodeRunEvents.id) })
        .from(nodeRunEvents)
        .where(and(...conditions))
      return numberValue(rows[0]?.value)
    },
    async listDistinctNodeRunIds(input) {
      const rows = await db
        .selectDistinct({ nodeRunId: nodeRunEvents.nodeRunId })
        .from(nodeRunEvents)
        .where(and(gt(nodeRunEvents.id, input.afterId), lte(nodeRunEvents.id, input.throughId)))
      return rows.map((row) => row.nodeRunId)
    },
    async countEventsByNodeRunIds(nodeRunIds) {
      const rows = await db
        .select({ nodeRunId: nodeRunEvents.nodeRunId, value: count(nodeRunEvents.id) })
        .from(nodeRunEvents)
        .where(inArray(nodeRunEvents.nodeRunId, nodeRunIds))
        .groupBy(nodeRunEvents.nodeRunId)
      return rows.map((row) => ({ nodeRunId: row.nodeRunId, count: numberValue(row.value) }))
    },
    async countAllEvents() {
      const rows = await db.select({ value: count(nodeRunEvents.id) }).from(nodeRunEvents)
      return numberValue(rows[0]?.value)
    },
    async oldestEvent() {
      const rows = await db
        .select({ id: nodeRunEvents.id, nodeRunId: nodeRunEvents.nodeRunId })
        .from(nodeRunEvents)
        .orderBy(asc(nodeRunEvents.id))
        .limit(1)
      const row = rows[0]
      return row === undefined ? null : { id: numberValue(row.id), nodeRunId: row.nodeRunId }
    },
    async countEventsForNodeRun(nodeRunId) {
      const rows = await db
        .select({ value: count(nodeRunEvents.id) })
        .from(nodeRunEvents)
        .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      return numberValue(rows[0]?.value)
    },
    async findTaskIdForNodeRun(nodeRunId) {
      const rows = await db
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
      return rows[0]?.taskId ?? null
    },
    async listOldestEvents(nodeRunId, limit) {
      const rows = await db
        .select({
          id: nodeRunEvents.id,
          ts: nodeRunEvents.ts,
          kind: nodeRunEvents.kind,
          payload: nodeRunEvents.payload,
          sessionId: nodeRunEvents.sessionId,
          parentSessionId: nodeRunEvents.parentSessionId,
        })
        .from(nodeRunEvents)
        .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
        .orderBy(asc(nodeRunEvents.id))
        .limit(limit)
      return rows.map(eventRow)
    },
    async deleteNodeRunEventsThrough(nodeRunId, lastId) {
      await db
        .delete(nodeRunEvents)
        .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), lte(nodeRunEvents.id, lastId)))
    },
    async deleteNodeRunEventsRange(input) {
      await db
        .delete(nodeRunEvents)
        .where(
          and(
            eq(nodeRunEvents.nodeRunId, input.nodeRunId),
            gt(nodeRunEvents.id, input.afterId),
            lte(nodeRunEvents.id, input.throughId),
          ),
        )
    },
  }
  return Object.freeze(store)
}
