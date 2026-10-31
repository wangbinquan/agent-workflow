// RFC-399 B1: standalone backup-directory pruning for the System Operations backupPrune job (the
// pre-move runner body, unchanged). RFC-346 keeps node:path out of SO application; composition
// injects this into the job handlers.
import { join } from 'node:path'
import { pruneBackups } from '@/platform/background/providerBackupScheduler'
import type { LocalBackupMaintenance } from '../../application/ports/maintenanceSystemOperations'

export function pruneLocalBackups(
  input: Parameters<LocalBackupMaintenance['prune']>[0],
): ReturnType<LocalBackupMaintenance['prune']> {
  const result = pruneBackups({
    dir: join(input.appHome, 'backups'),
    count: input.retentionCount,
    days: input.retentionDays,
    maxTotalBytes: input.maxTotalBytes,
    protectedKeepCount: input.protectedKeepCount,
    now: Date.now(),
  })
  return { deleted: result.deleted.length, kept: result.kept.length }
}
