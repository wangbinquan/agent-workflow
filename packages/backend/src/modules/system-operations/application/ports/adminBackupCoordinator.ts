import type { AdminBackupReceipt } from '../../domain/backup'

export interface AdminBackupCoordinatorPort {
  request(input: Readonly<{ includeWorktrees: boolean }>): Promise<AdminBackupReceipt>
}
