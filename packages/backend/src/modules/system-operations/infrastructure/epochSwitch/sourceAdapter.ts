import {
  openFrozenSource,
  openLiveSnapshotSource,
  type SourceAccessInput,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import {
  precheckSource,
  type SourcePrecheckInput,
} from '@/platform/persistence/migration/freeze/sourcePrecheck'
import { errorCode, errorText } from '@/platform/persistence/migration/errorText'
import type {
  EpochSourcePort,
  SourcePrecheck,
  SourceSnapshotRequest,
} from '../../application/ports/epochSwitch'
import { EpochSwitchError } from '../../domain/epochSwitch/model'

export interface EpochSourceAdapterDependencies {
  /**
   * `watch` (RFC-626 §4.1) is borrowed from the assembly of the automatic upgrade, which keeps
   * it for the whole session; a source handle never closes it.
   */
  resolve(
    input: SourceSnapshotRequest,
  ): Promise<
    Pick<
      SourceAccessInput,
      'manifest' | 'postgresql' | 'createScratchPostgresql' | 'reopenScratchPostgresql' | 'watch'
    >
  >
  /**
   * RFC-626 §3.5: what the read-only check before an automatic upgrade needs, obtained without
   * creating anything — no scratch database and no file of the operation. A PostgreSQL source
   * needs its runtime; the releases to compare its structure with are compiled in a scratch
   * database, so `manifest` may be null when none exists yet and the structure is then left to
   * the freeze. Without this, `resolve` is asked, which is enough for a SQLite source.
   */
  resolvePrecheck?(
    input: SourceSnapshotRequest,
  ): Promise<Pick<SourcePrecheckInput, 'manifest' | 'postgresql' | 'supportedPostgresqlMajors'>>
}
export function createEpochSourceAdapter(
  dependencies: EpochSourceAdapterDependencies,
): EpochSourcePort & { precheck(input: SourceSnapshotRequest): Promise<SourcePrecheck> } {
  const open = async (input: Parameters<EpochSourcePort['freeze']>[0], frozen: boolean) => {
    try {
      const options = { ...input, ...(await dependencies.resolve(input)) }
      return frozen ? await openFrozenSource(options) : await openLiveSnapshotSource(options)
    } catch (error) {
      if (error instanceof EpochSwitchError) throw error
      // A database client throws values that are not `Error` instances; read their message.
      const message = errorText(error)
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
  return {
    discover: (input) => open(input, false),
    freeze: (input) => open(input, true),
    async precheck(input) {
      let access: Pick<SourcePrecheckInput, 'manifest' | 'postgresql' | 'supportedPostgresqlMajors'>
      try {
        access = dependencies.resolvePrecheck
          ? await dependencies.resolvePrecheck(input)
          : await dependencies.resolve(input)
      } catch (error) {
        if (error instanceof EpochSwitchError) throw error
        // Resolving the source reaches for it (a PostgreSQL profile is probed for readiness):
        // a source that cannot be reached is what this check is there to report.
        const text = errorText(error)
        return {
          ok: false,
          reason: 'unreadable',
          message: `The old database cannot be reached: ${text}; check that it is available, then start again.`,
          detail: { error: text, code: errorCode(error) },
        }
      }
      return precheckSource({
        location: input.location,
        emptyTables: input.emptyTables,
        manifest: access.manifest,
        postgresql: access.postgresql,
        supportedPostgresqlMajors: access.supportedPostgresqlMajors,
      })
    },
  }
}
