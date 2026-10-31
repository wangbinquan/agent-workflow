// RFC-399 B1: owner-owned maintenance bodies; slicing and result projection are unchanged.
import type {
  LocalBackupMaintenance,
  MaintenanceSystemOperations,
} from './ports/maintenanceSystemOperations'
import type { MaintenanceJobHandlers } from '@/platform/contracts/maintenanceJob'
import type { MaintenanceWorkerDelta } from '@/platform/background/maintenanceProtocol'
import { parseMaintenanceJobPayload } from '@/platform/background/maintenanceJobPayload'

const NONE: MaintenanceWorkerDelta = { kind: 'none' }

export function createSystemOperationsMaintenanceJobHandlers(
  system: MaintenanceSystemOperations,
  localBackups: LocalBackupMaintenance,
): Pick<
  MaintenanceJobHandlers,
  'eventsArchive' | 'retentionSweep' | 'backupPrune' | 'walCheckpoint' | 'hostedObjectRecovery'
> {
  return {
    async eventsArchive(input) {
      const payload = parseMaintenanceJobPayload('eventsArchive', input.payload)
      return await system.eventsArchive.runSlice({
        thresholds: payload.eventsArchiveThresholds,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })
    },
    async retentionSweep(input) {
      const payload = parseMaintenanceJobPayload('retentionSweep', input.payload)
      return await system.retention.runSlice({
        eventStreamRetentionDays: payload.eventStreamRetentionDays,
        webhookTriggerFiresRetentionDays: payload.webhookTriggerFiresRetentionDays,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })
    },
    async backupPrune(input) {
      const { appHome } = input
      const payload = parseMaintenanceJobPayload('backupPrune', input.payload)
      if (system.databaseBackups) {
        const result = await system.databaseBackups.prune(payload)
        return { counters: result, delta: NONE }
      }
      const result = localBackups.prune({
        appHome,
        retentionCount: payload.retentionCount,
        retentionDays: payload.retentionDays,
        maxTotalBytes: payload.maxTotalBytes,
        protectedKeepCount: payload.protectedKeepCount,
      })
      return {
        counters: { deleted: result.deleted, kept: result.kept },
        delta: NONE,
      }
    },
    async walCheckpoint(input) {
      parseMaintenanceJobPayload('walCheckpoint', input.payload)
      return { counters: await system.storage.run(), delta: NONE }
    },
    async hostedObjectRecovery(input) {
      parseMaintenanceJobPayload('hostedObjectRecovery', input.payload)
      const maintenance = system.objectPublications
      return {
        counters: maintenance === undefined ? { skipped: 1 } : { ...(await maintenance.run()) },
        delta: NONE,
      }
    },
  }
}
