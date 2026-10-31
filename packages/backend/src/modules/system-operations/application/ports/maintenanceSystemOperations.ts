import type { MaintenanceJobExecutionResult } from '@/platform/contracts/maintenanceJob'
import type {
  DatabaseBackupMaintenance,
  HostedObjectPublicationMaintenance,
} from '../../public/commands'

export interface MaintenanceSystemOperations {
  readonly databaseBackups?: DatabaseBackupMaintenance
  /** Hosted deployments only; standalone has no CS object publications. */
  readonly objectPublications?: HostedObjectPublicationMaintenance
  readonly eventsArchive: {
    runSlice(input: {
      readonly thresholds: {
        readonly perNodeRunRows: number
        readonly globalRows: number
        readonly perNodeRunBytes: number
        readonly globalBytes: number
      }
      readonly cursor?: unknown
    }): Promise<MaintenanceJobExecutionResult>
  }
  readonly retention: {
    runSlice(input: {
      readonly eventStreamRetentionDays: number
      readonly webhookTriggerFiresRetentionDays: number
      readonly cursor?: unknown
    }): Promise<MaintenanceJobExecutionResult>
  }
  readonly storage: {
    run(): Promise<Readonly<Record<string, number>>>
  }
}

/**
 * Standalone fallback of the backupPrune job when the provider has no database backup maintenance:
 * prunes `<appHome>/backups`. Implemented in local infrastructure (RFC-346 keeps node:path out of
 * the application layer) and injected by composition.
 */
export interface LocalBackupMaintenance {
  prune(input: {
    readonly appHome: string
    readonly retentionCount: number
    readonly retentionDays: number
    readonly maxTotalBytes: number
    readonly protectedKeepCount: number
  }): { readonly deleted: number; readonly kept: number }
}
