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
  return {
    async create(input) {
      try {
        const persist = async (receipt: SwitchBackupReceipt) => {
          if (input.artifacts) stores.set(receipt.id, input.artifacts)
          return persistSwitchBackup(receipt, input.artifacts)
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
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
    async matches(receipt, watermark) {
      if (receipt.kind === 'platform-retained')
        return dependencies.retainedMatches
          ? dependencies.retainedMatches(receipt, watermark)
          : false
      const artifacts = stores.get(receipt.id) ?? (await dependencies.artifacts?.(receipt))
      if (artifacts && (!receipt.path || !(await switchBackupMatches(receipt, watermark)))) {
        try {
          return switchBackupMatches(await materializeSwitchBackup(receipt, artifacts), watermark)
        } catch {
          return false
        }
      }
      return switchBackupMatches(receipt, watermark)
    },
  }
}
