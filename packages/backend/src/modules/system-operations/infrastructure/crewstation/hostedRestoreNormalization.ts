// RFC-370 v3 V5 — System Operations' own restore normalization. Only System
// Operations rows are touched; every other context normalizes through its own
// participant. The snapshot carries the backed-up instance's execution lease
// and its own still-building backup row: neither may become live state here.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedStoredObject } from '@/platform/crewstation/objectStorage'
import type { HostedRestoreNormalizationParticipant } from './restoreNormalizationContract'
import { HOSTED_BACKUP_OWNER, type HostedBackupSidecar } from './databaseBackupFormat'
import { adoptHostedPublicationInTx, hostedPublicationId } from './objectPublications'

export function createHostedSystemRestoreNormalization(input: {
  readonly sidecar: HostedBackupSidecar
  readonly object: HostedStoredObject
}): HostedRestoreNormalizationParticipant {
  const { sidecar, object } = input
  return {
    name: 'system-operations',
    async normalize(tx: PersistenceDb, { now }) {
      const { hostedExecutionControl, hostedDatabaseBackups, hostedObjectPublications } =
        tablesOf(tx)
      // The restored database starts without execution authority.
      const control = await tx
        .update(hostedExecutionControl)
        .set({ phase: 'frozen', expiresAt: 0, migrationOperationId: null, updatedAt: now })
        .returning({ id: hostedExecutionControl.id })
      // Other backups still building in the snapshot never completed there.
      const abandoned = await tx
        .update(hostedDatabaseBackups)
        .set({ state: 'failed', activeSlot: null, updatedAt: now })
        .where(
          and(
            eq(hostedDatabaseBackups.state, 'building'),
            ne(hostedDatabaseBackups.id, sidecar.backupId),
          ),
        )
        .returning({ id: hostedDatabaseBackups.id })
      if (abandoned.length > 0)
        await tx
          .update(hostedObjectPublications)
          .set({
            state: 'releasing',
            releasedAt: now,
            updatedAt: now,
            nextAttemptAt: 0,
            sourceSealed: null,
          })
          .where(
            and(
              eq(hostedObjectPublications.owner, HOSTED_BACKUP_OWNER),
              inArray(hostedObjectPublications.state, ['pending', 'ready']),
              inArray(
                hostedObjectPublications.id,
                abandoned.map((row) => hostedPublicationId(HOSTED_BACKUP_OWNER, row.id)),
              ),
            ),
          )
      // The restore source completed after its snapshot: record its archive.
      const ready = {
        kind: sidecar.kind,
        state: 'ready' as const,
        activeSlot: null,
        objectId: object.id,
        sha256: object.sha256,
        sizeBytes: object.size,
        schemaDigest: sidecar.schemaDigest,
        sourceGenerationId: sidecar.sourceGenerationId,
        contentsJson: JSON.stringify(sidecar.contents),
        snapshotAt: sidecar.snapshotAt,
        updatedAt: now,
      }
      await tx
        .insert(hostedDatabaseBackups)
        .values({ id: sidecar.backupId, epoch: 0, createdAt: sidecar.createdAt, ...ready })
        .onConflictDoUpdate({ target: hostedDatabaseBackups.id, set: ready })
      await adoptHostedPublicationInTx(tx, {
        owner: HOSTED_BACKUP_OWNER,
        key: sidecar.backupId,
        attempt: sidecar.backupId,
        object,
        createdAt: sidecar.snapshotAt,
        now,
      })
      return { frozenControl: control.length, failedBackups: abandoned.length, adoptedBackups: 1 }
    },
  }
}
