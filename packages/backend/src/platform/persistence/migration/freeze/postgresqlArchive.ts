import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { exportEpoch1PostgresqlSource } from '../postgresqlSourceExport'
import type { SourceArchiveInput } from '../run/types'
import { cachedVerifiedArtifactSource } from '../artifactDirectoryCache'
import {
  logicalArtifactFileDigest,
  verifyLogicalArtifactManifest,
} from '../legacy/logicalDatabaseArtifact'
import { resolveEpoch1PostgresqlVersion } from '../epoch1/releasedPostgresql'
import type { SourceMeasurementObserver } from '../sourceTypes'
import type { FrozenSourceDetails } from './sourceAccess'

export type PostgresqlBackupArchive = Pick<
  Parameters<typeof exportEpoch1PostgresqlSource>[0],
  'preservedArchive' | 'emptyArchive'
>

export async function resolvePostgresqlSourceArchive(
  details: Pick<FrozenSourceDetails, 'originalPreflight' | 'originalReader'>,
  archive: SourceArchiveInput,
  /** RFC-626 §7: told each time the retained archive's whole tree is verified. */
  onMeasure?: SourceMeasurementObserver,
): Promise<PostgresqlBackupArchive> {
  const preflight = details.originalPreflight
  if (archive.kind === 'retained-epoch1-archive') {
    const path = join(archive.path, 'legacy-archive/manifest.json')
    if (logicalArtifactFileDigest(path) !== archive.digest)
      throw new Error('postgresql-archive-digest-mismatch')
    const manifest = verifyLogicalArtifactManifest(
      JSON.parse(readFileSync(join(archive.path, 'logical-manifest.json'), 'utf8')),
    )
    const contract = (await resolveEpoch1PostgresqlVersion(manifest.payload.schemaDigest))?.contract
    if (!contract) throw new Error('postgresql-archive-contract-unsupported')
    return {
      // RFC-626 §4.6: the retained archive is resolved again at every check of the source; its
      // chunks are verified once per process for as long as the directory stays the same.
      preservedArchive: cachedVerifiedArtifactSource(
        {
          artifactRoot: archive.path,
          expectedManifestDigest: manifest.digest,
          expectedLegacyArchiveFileDigest: archive.digest,
          contract,
        },
        onMeasure,
      ),
    }
  }
  const assertProvenance = async () => {
    const evidence = archive.evidence
    const absent = preflight
      .contract!.tables.filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT')
      .map((table) => table.id)
      .sort()
    if (
      evidence.sourceBornOn !== 'postgresql' ||
      preflight.kind !== 'postgresql-database' ||
      preflight.fingerprint.provider !== 'postgresql' ||
      preflight.fingerprint.evidence !== 'physical-catalog-and-journal' ||
      evidence.sourceGenerationId !== preflight.sourceGenerationId ||
      evidence.sourceWatermark !== preflight.watermark ||
      evidence.catalogDigest !== preflight.fingerprint.catalogDigest ||
      absent.length !== 6 ||
      absent.some(
        (table) =>
          !evidence.expectedAbsent.includes(table) ||
          !preflight.expectedAbsent.includes(table) ||
          preflight.fingerprint.catalog.some(
            (entry) => entry.relation === table || entry.relation === `agent_workflow.${table}`,
          ),
      )
    )
      throw new Error('postgresql-never-installed-evidence-mismatch')
    await details.originalReader.assertUnchanged(preflight)
  }
  await assertProvenance()
  return { emptyArchive: { kind: 'born-hosted', assertProvenance } }
}
