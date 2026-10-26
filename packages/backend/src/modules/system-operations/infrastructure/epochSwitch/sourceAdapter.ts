import {
  openFrozenSource,
  openLiveSnapshotSource,
  type SourceAccessInput,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import type { EpochSourcePort, SourceSnapshotRequest } from '../../application/ports/epochSwitch'
import { EpochSwitchError } from '../../domain/epochSwitch/model'

export interface EpochSourceAdapterDependencies {
  resolve(
    input: SourceSnapshotRequest,
  ): Promise<
    Pick<
      SourceAccessInput,
      'manifest' | 'postgresql' | 'createScratchPostgresql' | 'reopenScratchPostgresql'
    >
  >
}
export function createEpochSourceAdapter(
  dependencies: EpochSourceAdapterDependencies,
): EpochSourcePort {
  const open = async (input: Parameters<EpochSourcePort['freeze']>[0], frozen: boolean) => {
    try {
      const options = { ...input, ...(await dependencies.resolve(input)) }
      return frozen ? await openFrozenSource(options) : await openLiveSnapshotSource(options)
    } catch (error) {
      if (error instanceof EpochSwitchError) throw error
      const message = error instanceof Error ? error.message : String(error)
      const category =
        /scratch.*(required|not.empty|owned)|postgresql-target-not-empty|Offline PostgreSQL copy must start empty/i.test(
          message,
        )
          ? 'scratch-required'
          : /source.chang|source.*differ|changed.*source|changed after preflight|Offline copy differs|Backup changed|Logical source changed/i.test(
                message,
              )
            ? 'source-changed'
            : 'source-blocked'
      throw new EpochSwitchError(category, { category, message })
    }
  }
  return { discover: (input) => open(input, false), freeze: (input) => open(input, true) }
}
