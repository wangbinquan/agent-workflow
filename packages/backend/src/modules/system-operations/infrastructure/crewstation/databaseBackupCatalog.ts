// RFC-370 v3 V5 — the backup catalog. Listing uses only the durable rows;
// verification is lightweight: the catalog row plus a platform `stat` proving
// the archive object still exists with its recorded size and digest. The
// restore Job downloads and verifies the bytes it imports.
import { desc, eq } from 'drizzle-orm'
import { HostedBackupCatalogSchema, HostedBackupVerificationSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedDatabaseBackups } from '@/db/schema'
import type { CrewStationStreamObjectStorage } from '@/platform/crewstation/objectStorage'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { HostedBackupCatalogQueries } from '../../application/ports/adminBackupCoordinator'
import { HostedBackupContents, hostedBackupReference } from './databaseBackupFormat'

export function createHostedBackupCatalog(input: {
  readonly db: ProviderNeutralDatabase
  readonly objects: Pick<CrewStationStreamObjectStorage, 'stat'>
  readonly protectedBackupIds: () => Promise<readonly string[]>
  readonly now?: () => number
}): HostedBackupCatalogQueries {
  return {
    async list() {
      const protectedIds = new Set(await input.protectedBackupIds())
      const rows = await input.db
        .select()
        .from(hostedDatabaseBackups)
        .orderBy(desc(hostedDatabaseBackups.createdAt), desc(hostedDatabaseBackups.id))
        .limit(101)
      return HostedBackupCatalogSchema.parse({
        hasMore: rows.length > 100,
        backups: rows.slice(0, 100).map((row) => ({
          id: row.id,
          kind: row.kind,
          state: row.state,
          createdAt: row.createdAt,
          sizeBytes: row.sizeBytes,
          protected: protectedIds.has(row.id),
        })),
      })
    },
    async verify(id) {
      const [row] = await input.db
        .select()
        .from(hostedDatabaseBackups)
        .where(eq(hostedDatabaseBackups.id, id))
        .limit(1)
      if (!row) throw new NotFoundError('backup-not-found', 'The backup does not exist.')
      if (
        row.state !== 'ready' ||
        row.objectId === null ||
        row.sha256 === null ||
        row.sizeBytes === null ||
        row.schemaDigest === null ||
        row.sourceGenerationId === null ||
        row.contentsJson === null
      )
        throw new ConflictError('backup-not-ready', 'Only a completed backup can be verified.')
      const recorded = { id: row.objectId, sha256: row.sha256, size: row.sizeBytes }
      let actual
      try {
        actual = await input.objects.stat(row.objectId)
      } catch (error) {
        if (error instanceof CrewStationApiError && error.status === 404)
          throw new ConflictError(
            'backup-archive-unavailable',
            'The backup archive no longer exists in object storage.',
          )
        throw error
      }
      if (
        actual.id !== recorded.id ||
        actual.sha256 !== recorded.sha256 ||
        actual.size !== recorded.size
      )
        throw new ConflictError(
          'backup-archive-unavailable',
          'The backup archive in object storage does not match the catalog.',
        )
      const contents = HostedBackupContents.parse(JSON.parse(row.contentsJson))
      return HostedBackupVerificationSchema.parse({
        backupId: row.id,
        verifiedAt: (input.now ?? Date.now)(),
        reference: hostedBackupReference(recorded),
        schemaDigest: row.schemaDigest,
        sourceGenerationId: row.sourceGenerationId,
        sizeBytes: row.sizeBytes,
        workflows: contents.workflows,
        skills: contents.skills,
      })
    },
  }
}
