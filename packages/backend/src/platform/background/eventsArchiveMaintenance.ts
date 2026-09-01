// RFC-338/RFC-349 — provider-neutral bounded event-archive orchestration.
// Provider adapters own the row store; this mechanism owns the durable cursor
// and mixed database/filesystem archive journal shared by SQLite/PostgreSQL.

import type { EventsArchiveStore } from './eventsArchiveStorePort'
import type { MaintenanceJobExecutionResult } from './maintenanceJobRunner'
import { archiveEventsWithStore } from '@/platform/persistence/sqlite/systemEventsArchive'

// Keep the mixed FS/database body inside the RFC-338 wall budget on the
// 4.5GB / 100-client tier. The smaller slice preserves exact progress and
// yields to the durable queue between batches.
const EVENT_ARCHIVE_SLICE_ROWS = 1_000
/** One short primary-key range COUNT per Worker slice at large event scale. */
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

type EventArchiveCursorV1 = EventArchiveCountCursorV1 | EventArchiveRunCursorV1

function cursor(value: unknown): EventArchiveCursorV1 | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') throw new Error('maintenance-events-archive-cursor-invalid')
  const candidate = value as Partial<EventArchiveCursorV1>
  // A pre-RFC-338 continuation was only `{ version: 1 }`. Restarting the
  // bounded count is safe and lets an in-flight deployment upgrade in place.
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
  return candidate as EventArchiveCursorV1
}

export function createEventsArchiveMaintenanceCommand(input: {
  readonly store: EventsArchiveStore
  readonly logsDir: string
}): {
  runSlice(request: {
    readonly thresholds: {
      readonly perNodeRunRows: number
      readonly globalRows: number
      readonly perNodeRunBytes: number
      readonly globalBytes: number
    }
    readonly cursor?: unknown
  }): Promise<MaintenanceJobExecutionResult>
} {
  return Object.freeze({
    async runSlice(request): Promise<MaintenanceJobExecutionResult> {
      const current = cursor(request.cursor)
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
          const countedRows = await input.store.countEventIds({
            afterId: scanFrom,
            throughId: scanTo,
          })
          const totalRows = priorRows + countedRows
          if (scanTo < maxId) {
            return {
              counters: { countedRows },
              delta: { kind: 'none' },
              continuation: {
                cursor: { version: 1, phase: 'count', maxId, scanFrom: scanTo, totalRows },
                resumeAfterMs: RESUME_AFTER_MS,
              },
            }
          }
          knownGlobalRows = totalRows
        }
      }

      const result = await archiveEventsWithStore(
        input.store,
        { eventsArchiveThresholds: request.thresholds },
        input.logsDir,
        { rowBudgetRows: EVENT_ARCHIVE_SLICE_ROWS, knownGlobalRows },
      )
      const archived = result.perGroupArchived + result.globalArchived
      return {
        counters: {
          perGroupArchived: result.perGroupArchived,
          globalArchived: result.globalArchived,
          files: result.files.length,
        },
        delta: { kind: 'none' },
        ...(archived < EVENT_ARCHIVE_SLICE_ROWS
          ? {}
          : {
              continuation: {
                cursor: {
                  version: 1,
                  phase: 'archive' as const,
                  remainingRows: result.remainingRows,
                },
                resumeAfterMs: RESUME_AFTER_MS,
              },
            }),
      }
    },
  })
}
