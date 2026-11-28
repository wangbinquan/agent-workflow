import { existsSync } from 'node:fs'
import {
  createSwitchBackup,
  immutableSourceBackup,
  switchBackupMatches,
  type PostgresqlBackupArchive,
  resolvePostgresqlBackupArchive,
  persistSwitchBackup,
  materializeSwitchBackup,
} from '@/platform/persistence/migration/freeze/backup'
import { frozenSourceDetails } from '@/platform/persistence/migration/freeze/sourceAccess'
import { errorText } from '@/platform/persistence/migration/errorText'
import type {
  EpochBackupPort,
  FrozenSourceHandle,
  SwitchBackupReceipt,
} from '../../application/ports/epochSwitch'
import { EpochSwitchError } from '../../domain/epochSwitch/model'
import type { EpochSwitchArtifactPort } from '@/platform/persistence/migration/run/types'

export function createEpochBackupAdapter(
  dependencies: {
    readonly chunkRows?: number
    readonly postgresqlArchive?: (source: FrozenSourceHandle) => Promise<PostgresqlBackupArchive>
    readonly retained?: (
      input: Parameters<EpochBackupPort['create']>[0],
    ) => Promise<SwitchBackupReceipt>
    readonly retainedMatches?: (receipt: SwitchBackupReceipt, watermark: string) => Promise<boolean>
    /** Resolve the operation-scoped artifact store on a fresh Job before matches. */
    readonly artifacts?: (
      receipt: SwitchBackupReceipt,
    ) => EpochSwitchArtifactPort | Promise<EpochSwitchArtifactPort>
  } = {},
): EpochBackupPort {
  const stores = new Map<string, EpochSwitchArtifactPort>()
  /**
   * RFC-626 §4.5: backups this adapter wrote for an automatic upgrade, by receipt id. Their
   * directory digest was computed when they were written and travels with the receipt; within
   * the same process nothing else writes into the operation's backup directory, so checking
   * such a receipt does not read the whole backup again. A receipt from an earlier process is
   * not in here and is verified against the disk as before.
   */
  const written = new Map<string, SwitchBackupReceipt>()
  return {
    async create(input) {
      try {
        const persist = async (receipt: SwitchBackupReceipt) => {
          if (input.artifacts) stores.set(receipt.id, input.artifacts)
          const persisted = await persistSwitchBackup(receipt, input.artifacts)
          if (input.resolution === 'automatic') written.set(persisted.id, persisted)
          return persisted
        }
        const details = frozenSourceDetails(input.source)
        if (details.location.kind === 'backup')
          return await persist(
            await immutableSourceBackup(input.source, input.contentManifest ?? null),
          )
        if (dependencies.retained) return await dependencies.retained(input)
        if (details.sqlitePath)
          return await persist(
            await createSwitchBackup({
              sourcePath: details.sqlitePath,
              destination: input.destination,
              frozen: input.source,
              contentManifest: input.contentManifest ?? null,
              resolution: input.resolution,
            }),
          )
        return await persist(
          await createSwitchBackup({
            ...input,
            chunkRows: dependencies.chunkRows ?? 1000,
            archive: input.postgresqlArchive
              ? await resolvePostgresqlBackupArchive(input.source, input.postgresqlArchive)
              : await dependencies.postgresqlArchive?.(input.source),
          }),
        )
      } catch (error) {
        throw new EpochSwitchError('backup-failed', {
          category: 'backup-failed',
          message: errorText(error),
        })
      }
    },
    async matches(receipt, watermark) {
      if (receipt.kind === 'platform-retained')
        return dependencies.retainedMatches
          ? dependencies.retainedMatches(receipt, watermark)
          : false
      const own = written.get(receipt.id)
      if (
        own &&
        own.digest === receipt.digest &&
        own.path === receipt.path &&
        receipt.path !== null &&
        existsSync(receipt.path)
      )
        return receipt.version === 1 && receipt.sourceWatermark === watermark
      const artifacts = stores.get(receipt.id) ?? (await dependencies.artifacts?.(receipt))
      // The local directory is read once: it either is the backup, or the backup has to be
      // materialised from the artifact store and that copy is what gets read.
      const local = receipt.path ? await switchBackupMatches(receipt, watermark) : false
      if (local || !artifacts) return local
      try {
        return switchBackupMatches(await materializeSwitchBackup(receipt, artifacts), watermark)
      } catch {
        return false
      }
    },
  }
}
