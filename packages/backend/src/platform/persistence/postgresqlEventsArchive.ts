// RFC-349 — PostgreSQL owner adapter for RFC-338 node-event archival. The
// mixed filesystem journal is provider-neutral; every database read/write is
// issued through the live-generation PostgreSQL client.

import type { Config } from '@agent-workflow/shared'
import { and, asc, count, eq, gt, inArray, lte, sql } from 'drizzle-orm'

import { maintenanceState, nodeRunEvents, nodeRuns } from '@/db/schema'
import type {
  EventsArchiveRow,
  EventsArchiveStore,
} from '@/platform/background/eventsArchiveStorePort'
import {
  archiveEventsWithStore,
  type ArchiveRunResult,
} from '@/platform/persistence/sqlite/systemEventsArchive'
import type { PostgresqlDatabaseClient } from './postgresqlDatabaseClient'

const EVENT_ARCHIVE_SLICE_ROWS = 1_000
const EVENT_ARCHIVE_COUNT_WINDOW_IDS = 250_000
const RESUME_AFTER_MS = 25

interface EventArchiveCountCursorV1 {
  readonly version: 1
  readonly phase: 'count'
  readonly maxId: number
  readonly scanFrom: number
  readonly totalRows: number
}

interface EventArchiveRunCursorV1 {
  readonly version: 1
  readonly phase: 'archive'
  readonly remainingRows: number
}

export type PostgresqlEventArchiveCursorV1 = EventArchiveCountCursorV1 | EventArchiveRunCursorV1

export interface PostgresqlEventArchiveSliceResult {
  readonly counters: Readonly<Record<string, number>>
  readonly continuation?: {
    readonly cursor: PostgresqlEventArchiveCursorV1
    readonly resumeAfterMs: number
  }
}

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

export function createPostgresqlEventsArchiveStore(
  db: PostgresqlDatabaseClient,
): EventsArchiveStore {
  const store: EventsArchiveStore = {
    async readState(key) {
      const rows = await db
        .select({ value: maintenanceState.value })
        .from(maintenanceState)
        .where(eq(maintenanceState.key, key))
        .limit(1)
      return rows[0]?.value ?? null
    },
    async writeState(key, value, now = Date.now()) {
      await db
        .insert(maintenanceState)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: maintenanceState.key,
          set: { value, updatedAt: now },
        })
    },
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

function cursor(value: unknown): PostgresqlEventArchiveCursorV1 | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') throw new Error('maintenance-events-archive-cursor-invalid')
  const candidate = value as Partial<PostgresqlEventArchiveCursorV1>
  if (candidate.version === 1 && candidate.phase === undefined) return null
  if (
    candidate.version !== 1 ||
    (candidate.phase !== 'count' && candidate.phase !== 'archive') ||
    (candidate.phase === 'count' &&
      (!Number.isSafeInteger(candidate.maxId) ||
        candidate.maxId! < 0 ||
        !Number.isSafeInteger(candidate.scanFrom) ||
        candidate.scanFrom! < 0 ||
        candidate.scanFrom! > candidate.maxId! ||
        !Number.isSafeInteger(candidate.totalRows) ||
        candidate.totalRows! < 0)) ||
    (candidate.phase === 'archive' &&
      (!Number.isSafeInteger(candidate.remainingRows) || candidate.remainingRows! < 0))
  ) {
    throw new Error('maintenance-events-archive-cursor-invalid')
  }
  return candidate as PostgresqlEventArchiveCursorV1
}

function archiveResult(
  result: ArchiveRunResult,
  sliceRows: number,
): PostgresqlEventArchiveSliceResult {
  const archived = result.perGroupArchived + result.globalArchived
  return {
    counters: {
      perGroupArchived: result.perGroupArchived,
      globalArchived: result.globalArchived,
      files: result.files.length,
    },
    ...(archived < sliceRows
      ? {}
      : {
          continuation: {
            cursor: {
              version: 1,
              phase: 'archive',
              remainingRows: result.remainingRows,
            },
            resumeAfterMs: RESUME_AFTER_MS,
          },
        }),
  }
}

/** One RFC-338 bounded count/archive slice. PostgreSQL keeps exactly the same
 * durable cursor and JSONL receipt semantics as SQLite. */
export async function runPostgresqlEventsArchiveSlice(input: {
  readonly store: EventsArchiveStore
  readonly config: Pick<Config, 'eventsArchiveThresholds'>
  readonly logsDir: string
  readonly cursor?: unknown
  readonly sliceRows?: number
}): Promise<PostgresqlEventArchiveSliceResult> {
  const sliceRows = input.sliceRows ?? EVENT_ARCHIVE_SLICE_ROWS
  const current = cursor(input.cursor)
  let knownGlobalRows: number
  if (current?.phase === 'archive') {
    knownGlobalRows = current.remainingRows
  } else {
    const maxId = current?.maxId ?? (await input.store.maxEventId())
    const scanFrom = current?.scanFrom ?? 0
    const priorRows = current?.totalRows ?? 0
    if (scanFrom >= maxId) {
      knownGlobalRows = priorRows
    } else {
      const scanTo = Math.min(maxId, scanFrom + EVENT_ARCHIVE_COUNT_WINDOW_IDS)
      const countedRows = await input.store.countEventIds({ afterId: scanFrom, throughId: scanTo })
      const totalRows = priorRows + countedRows
      if (scanTo < maxId) {
        return {
          counters: { countedRows },
          continuation: {
            cursor: { version: 1, phase: 'count', maxId, scanFrom: scanTo, totalRows },
            resumeAfterMs: RESUME_AFTER_MS,
          },
        }
      }
      knownGlobalRows = totalRows
    }
  }

  return archiveResult(
    await archiveEventsWithStore(input.store, input.config, input.logsDir, {
      rowBudgetRows: sliceRows,
      knownGlobalRows,
    }),
    sliceRows,
  )
}
