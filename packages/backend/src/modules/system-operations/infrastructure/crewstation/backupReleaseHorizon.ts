// RFC-370 v3 V5 — the backup release horizon. A backup pins only its own
// archive; every object its snapshot references stays pinned by time instead:
// an owner-released publication is unpinned only when no building/ready backup
// may have captured the owner's reference. A backup's capture window opens when
// its row is committed (before the snapshot) and closes when the repeatable-read
// snapshot is established; a building backup's window is still open. The margin
// absorbs clock skew between instances and transactions that commit after the
// timestamp they wrote.
import { and, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedDatabaseBackups } from '@/db/schema'
import type { HostedBackupReleaseHorizon } from './objectPublicationContract'

export const HOSTED_BACKUP_HORIZON_MARGIN_MS = 5 * 60_000

export function createHostedBackupReleaseHorizon(input: {
  readonly db: ProviderNeutralDatabase
  readonly marginMs?: number
}): HostedBackupReleaseHorizon {
  const margin = input.marginMs ?? HOSTED_BACKUP_HORIZON_MARGIN_MS
  return {
    async protects({ createdAt, releasedAt }) {
      const rows = await input.db
        .select({ id: hostedDatabaseBackups.id })
        .from(hostedDatabaseBackups)
        .where(
          and(
            inArray(hostedDatabaseBackups.state, ['building', 'ready']),
            // The backup started before the owner reference was released ...
            lte(hostedDatabaseBackups.createdAt, releasedAt + margin),
            // ... and its snapshot was taken after the reference existed.
            or(
              isNull(hostedDatabaseBackups.snapshotAt),
              sql`${hostedDatabaseBackups.snapshotAt} + ${margin} >= ${createdAt}`,
            ),
          ),
        )
        .limit(1)
      return rows.length > 0
    },
  }
}
