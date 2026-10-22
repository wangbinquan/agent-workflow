// RFC-370 v3 V5 — hosted database backups. One building slot; the archive is
// published through the neutral object journal in the same transaction that
// makes the catalog row ready, and released in the same transaction that
// retires it. Pruning is a pure catalog decision: physical unpinning happens in
// the hosted object maintenance job behind the release horizon, so no platform
// outage can block a backup, a prune or a later restore.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, desc, eq, inArray, lte, ne } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { PortableBackupApplicationAssets } from '@/services/portableBackupArchive'
import { DomainError } from '@/util/errors'
import type { AdminBackupCoordinatorPort } from '../../application/ports/adminBackupCoordinator'
import type { HostedObjectPublications } from './objectPublicationContract'
import type { DatabaseBackupMaintenance } from '../../public/commands'
import {
  createHostedDatabaseBackupArchive,
  hostedBackupFileContent,
} from './databaseBackupArtifact'
import { HOSTED_BACKUP_OWNER, hostedBackupReference } from './databaseBackupFormat'

/** Settled catalog rows are kept this long for the administrator's history. */
export const HOSTED_BACKUP_HISTORY_MS = 30 * 86_400_000

export class HostedBackupWorktreesUnsupportedError extends DomainError {
  constructor() {
    super(
      'hosted-backup-worktrees-unsupported',
      'Hosted backups contain the database only; task workspaces live on CrewStation persistent volumes and are recovered by platform actions.',
      422,
      undefined,
    )
    this.name = 'HostedBackupWorktreesUnsupportedError'
  }
}

export function createHostedDatabaseBackups(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly publications: HostedObjectPublications
  readonly installation: string
  readonly objectSpaceId: string
  readonly keyFingerprint: string
  readonly contract: LogicalSchemaContract
  readonly openSource: () => Promise<PostgresqlLogicalSource>
  readonly workflows: Pick<PortableBackupApplicationAssets, 'exportWorkflows'>
  readonly assertBornHosted: () => Promise<void>
  /** The active restored generation retains its source backup for its lifetime. */
  readonly protectedBackupIds: () => Promise<readonly string[]>
  readonly workDirectory?: string
  readonly now?: () => number
  /** Infrastructure test seam; production builds the standalone archive. */
  readonly buildArchive?: typeof createHostedDatabaseBackupArchive
}) {
  const now = input.now ?? Date.now
  const buildArchive = input.buildArchive ?? createHostedDatabaseBackupArchive
  const session = databaseSessionFor(input.db)
  const write = async <T>(operation: (tx: PersistenceDb) => Promise<T>): Promise<T> => {
    const lease = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      return operation(tx)
    })
  }
  const retireInTx = async (
    tx: PersistenceDb,
    ids: readonly string[],
    from: readonly ('building' | 'ready')[],
    to: 'failed' | 'released',
  ) => {
    if (ids.length === 0) return 0
    const { hostedDatabaseBackups } = tablesOf(tx)
    const rows = await tx
      .update(hostedDatabaseBackups)
      .set({ state: to, activeSlot: null, updatedAt: now() })
      .where(
        and(
          inArray(hostedDatabaseBackups.id, [...ids]),
          inArray(hostedDatabaseBackups.state, [...from]),
        ),
      )
      .returning({ id: hostedDatabaseBackups.id })
    // A building backup may own a pending archive upload; either way the owner
    // reference ends here and maintenance settles the object.
    await input.publications.release(
      { owner: HOSTED_BACKUP_OWNER, keys: rows.map((row) => row.id) },
      tx,
    )
    return rows.length
  }
  /** A building row of an earlier execution epoch can never complete. */
  const recover = async (): Promise<number> =>
    write(async (tx) => {
      const { hostedDatabaseBackups } = tablesOf(tx)
      const stale = await tx
        .select({ id: hostedDatabaseBackups.id })
        .from(hostedDatabaseBackups)
        .where(
          and(
            eq(hostedDatabaseBackups.state, 'building'),
            ne(hostedDatabaseBackups.epoch, input.fence.current().epoch),
          ),
        )
      return retireInTx(
        tx,
        stale.map((row) => row.id),
        ['building'],
        'failed',
      )
    })
  const purgeHistory = async (): Promise<number> =>
    write(async (tx) => {
      const { hostedDatabaseBackups } = tablesOf(tx)
      const rows = await tx
        .delete(hostedDatabaseBackups)
        .where(
          and(
            inArray(hostedDatabaseBackups.state, ['failed', 'released']),
            lte(hostedDatabaseBackups.updatedAt, now() - HOSTED_BACKUP_HISTORY_MS),
          ),
        )
        .returning({ id: hostedDatabaseBackups.id })
      return rows.length
    })

  const backup: AdminBackupCoordinatorPort = {
    async request(options) {
      if (options.includeWorktrees) throw new HostedBackupWorktreesUnsupportedError()
      await recover()
      const id = crypto.randomUUID()
      const kind = options.kind ?? 'manual'
      const createdAt = now()
      await write(async (tx) => {
        const { hostedDatabaseBackups } = tablesOf(tx)
        const active = await tx
          .select({ id: hostedDatabaseBackups.id })
          .from(hostedDatabaseBackups)
          .where(eq(hostedDatabaseBackups.state, 'building'))
          .limit(1)
        if (active.length)
          throw new DomainError(
            'backup-in-progress',
            'A database backup is already running.',
            409,
            undefined,
          )
        // Committed before the snapshot: this opens the backup's horizon window.
        await insertOne(tx, hostedDatabaseBackups, {
          id,
          epoch: input.fence.current().epoch,
          kind,
          state: 'building',
          activeSlot: 'global',
          createdAt,
          updatedAt: createdAt,
        })
      })
      try {
        const archive = await buildArchive({
          backupId: id,
          kind,
          createdAt,
          installation: input.installation,
          objectSpaceId: input.objectSpaceId,
          keyFingerprint: input.keyFingerprint,
          contract: input.contract,
          source: await input.openSource(),
          workflows: input.workflows,
          assertBornHosted: input.assertBornHosted,
          assertAuthority: () => write(async () => undefined),
          ...(input.workDirectory === undefined ? {} : { workDirectory: input.workDirectory }),
          now,
        })
        try {
          const { sidecar } = archive
          const [object] = await input.publications.publish(
            [
              {
                owner: HOSTED_BACKUP_OWNER,
                key: id,
                // Deterministic lifetime: a restored catalog re-adopts this pin.
                attempt: id,
                content: await hostedBackupFileContent(archive.path),
              },
            ],
            {
              async commit(tx, [receipt]) {
                const { hostedDatabaseBackups } = tablesOf(tx)
                const updated = await tx
                  .update(hostedDatabaseBackups)
                  .set({
                    state: 'ready',
                    activeSlot: null,
                    objectId: receipt!.id,
                    sha256: receipt!.sha256,
                    sizeBytes: receipt!.size,
                    schemaDigest: sidecar.schemaDigest,
                    sourceGenerationId: sidecar.sourceGenerationId,
                    contentsJson: JSON.stringify(sidecar.contents),
                    snapshotAt: sidecar.snapshotAt,
                    updatedAt: now(),
                  })
                  .where(
                    and(
                      eq(hostedDatabaseBackups.id, id),
                      eq(hostedDatabaseBackups.state, 'building'),
                    ),
                  )
                  .returning({ id: hostedDatabaseBackups.id })
                if (updated.length !== 1) throw new Error('hosted-backup-no-longer-building')
              },
            },
          )
          return {
            path: hostedBackupReference(object!),
            sizeBytes: object!.size,
            contents: { ...sidecar.contents, db: true, config: true },
          }
        } finally {
          archive.dispose()
        }
      } catch (error) {
        await write((tx) => retireInTx(tx, [id], ['building'], 'failed')).catch(() => undefined)
        throw error
      }
    },
  }

  const maintenance: DatabaseBackupMaintenance = {
    async prune(options) {
      await recover()
      const protectedIds = new Set(await input.protectedBackupIds())
      const { hostedDatabaseBackups } = tablesOf(input.db)
      const ready = await input.db
        .select()
        .from(hostedDatabaseBackups)
        .where(eq(hostedDatabaseBackups.state, 'ready'))
        .orderBy(desc(hostedDatabaseBackups.createdAt), desc(hostedDatabaseBackups.id))
      const scheduled = ready.filter((row) => row.kind === 'scheduled')
      const manual = ready.filter((row) => row.kind === 'manual')
      const cutoff = now() - options.retentionDays * 86_400_000
      const remove = new Set(
        scheduled
          .filter((row, index) => index >= options.retentionCount && row.createdAt <= cutoff)
          .map((row) => row.id),
      )
      if ((options.protectedKeepCount ?? 0) > 0)
        for (const row of manual.slice(options.protectedKeepCount)) remove.add(row.id)
      if ((options.maxTotalBytes ?? 0) > 0) {
        const retained = scheduled.filter((row) => !remove.has(row.id))
        let bytes = retained.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)
        for (const row of [...retained].reverse()) {
          if (bytes <= options.maxTotalBytes!) break
          if (protectedIds.has(row.id)) continue
          remove.add(row.id)
          bytes -= row.sizeBytes ?? 0
        }
      }
      // Preserve the newest usable backup, and every active restored root,
      // independently of count, age and byte policies.
      if (ready[0]) remove.delete(ready[0].id)
      for (const id of protectedIds) remove.delete(id)
      const deleted =
        remove.size === 0
          ? 0
          : await write((tx) => retireInTx(tx, [...remove], ['ready'], 'released'))
      await purgeHistory()
      return { deleted, kept: ready.length - deleted }
    },
  }

  return {
    backup,
    maintenance,
    recover,
    async retire(id: string): Promise<void> {
      if ((await input.protectedBackupIds()).includes(id))
        throw new DomainError(
          'backup-restore-source-protected',
          'The backup this database was restored from is retained.',
          409,
          undefined,
        )
      const retired = await write((tx) => retireInTx(tx, [id], ['ready'], 'released'))
      if (retired === 0)
        throw new DomainError(
          'backup-not-ready',
          'Only a completed backup can be removed.',
          409,
          undefined,
        )
    },
  }
}
