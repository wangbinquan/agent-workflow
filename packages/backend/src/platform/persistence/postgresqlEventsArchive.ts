// RFC-349 — PostgreSQL owner adapter for RFC-338 node-event archival. The
// mixed filesystem journal is provider-neutral; every database read/write is
// issued through the live-generation PostgreSQL client.

import type { Config } from '@agent-workflow/shared'

import type { EventsArchiveStore } from '@/platform/background/eventsArchiveStorePort'
import {
  archiveEventsWithStore,
  type ArchiveRunResult,
} from '@/platform/persistence/sqlite/systemEventsArchive'
import type { PostgresqlDatabaseClient } from './postgresqlDatabaseClient'
import { createEventsArchiveStore } from './eventsArchiveStore'

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

export function createPostgresqlEventsArchiveStore(
  db: PostgresqlDatabaseClient,
): EventsArchiveStore {
  return createEventsArchiveStore(db)
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
