import type { AdminBackupReceipt } from '../../domain/backup'
import type { HostedBackupCatalog, HostedBackupVerification } from '@agent-workflow/shared'

export interface HostedBackupCatalogQueries {
  list(): Promise<HostedBackupCatalog>
  verify(backupId: string): Promise<HostedBackupVerification>
}

export interface AdminBackupCoordinatorPort {
  readonly catalog?: HostedBackupCatalogQueries
  request(
    input: Readonly<{ includeWorktrees: boolean; kind?: 'manual' | 'scheduled' }>,
  ): Promise<AdminBackupReceipt>
}
