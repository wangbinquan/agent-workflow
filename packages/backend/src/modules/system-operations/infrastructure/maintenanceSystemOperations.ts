// RFC-389 — one system-maintenance graph for both database providers.
import type { RetentionSweepPhase } from '@/platform/background/retentionSweepPhase'
import { runRetentionSweepSlice } from '@/platform/persistence/sqlite/systemMaintenanceRetention'
import { createEventsArchiveMaintenanceCommand } from '@/platform/background/eventsArchiveMaintenance'
import type { MaintenanceSystemOperations } from '../application/ports/maintenanceSystemOperations'

const MAINTENANCE_RETENTION_SLICE_ROWS = 1_000
const CLEANUP_COOLDOWN_MS = 25

export function composeMaintenanceSystemOperations(input: {
  readonly retentionPhases: readonly RetentionSweepPhase[]
  readonly eventsArchiveStore: Parameters<typeof createEventsArchiveMaintenanceCommand>[0]['store']
  readonly eventsArchiveContent?: Parameters<
    typeof createEventsArchiveMaintenanceCommand
  >[0]['content']
  readonly storage: MaintenanceSystemOperations['storage']
  readonly databaseBackups?: MaintenanceSystemOperations['databaseBackups']
  readonly objectPublications?: MaintenanceSystemOperations['objectPublications']
  readonly logsDir: string
}): MaintenanceSystemOperations {
  return Object.freeze({
    databaseBackups: input.databaseBackups,
    objectPublications: input.objectPublications,
    eventsArchive: createEventsArchiveMaintenanceCommand({
      content: input.eventsArchiveContent,
      store: input.eventsArchiveStore,
      logsDir: input.logsDir,
    }),
    retention: Object.freeze({
      async runSlice(request: Parameters<MaintenanceSystemOperations['retention']['runSlice']>[0]) {
        // RFC-359 W57: both providers use the same cursor, phases and counters.
        const result = await runRetentionSweepSlice(
          input.retentionPhases,
          request,
          request.cursor,
          Date.now(),
          MAINTENANCE_RETENTION_SLICE_ROWS,
        )
        return {
          counters: { ...result.counters },
          delta: { kind: 'none' as const },
          ...(result.done
            ? {}
            : { continuation: { cursor: result.cursor, resumeAfterMs: CLEANUP_COOLDOWN_MS } }),
        }
      },
    }),
    storage: input.storage,
  })
}
