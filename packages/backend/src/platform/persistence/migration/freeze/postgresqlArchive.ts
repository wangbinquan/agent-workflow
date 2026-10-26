import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { exportEpoch1PostgresqlSource } from '../postgresqlSourceExport'
import type { SourceArchiveInput } from '../run/types'
import { openVerifiedLogicalDatabaseArtifactSource } from '../legacy/logicalDatabaseRestore'
import {
  logicalArtifactFileDigest,
  verifyLogicalArtifactManifest,
} from '../legacy/logicalDatabaseArtifact'
import { loadFrozenEpoch1History } from '../epoch1/bundle'
import type { FrozenSourceDetails } from './sourceAccess'

export type PostgresqlBackupArchive = Pick<
  Parameters<typeof exportEpoch1PostgresqlSource>[0],
  'preservedArchive' | 'emptyArchive'
>

export async function resolvePostgresqlSourceArchive(
  details: Pick<FrozenSourceDetails, 'originalPreflight' | 'originalReader'>,
  archive: SourceArchiveInput,
): Promise<PostgresqlBackupArchive> {
  const preflight = details.originalPreflight
  if (archive.kind === 'retained-epoch1-archive') {
    const path = join(archive.path, 'legacy-archive/manifest.json')
    if (logicalArtifactFileDigest(path) !== archive.digest)
      throw new Error('postgresql-archive-digest-mismatch')
    const manifest = verifyLogicalArtifactManifest(
      JSON.parse(readFileSync(join(archive.path, 'logical-manifest.json'), 'utf8')),
    )
    const history = await loadFrozenEpoch1History()
    const contract = history.postgresql.versions.find(
      (version) => version.contract.digest === manifest.payload.schemaDigest,
    )?.contract
    if (!contract) throw new Error('postgresql-archive-contract-unsupported')
    return {
      preservedArchive: openVerifiedLogicalDatabaseArtifactSource({
        artifactRoot: archive.path,
        expectedManifestDigest: manifest.digest,
        expectedLegacyArchiveFileDigest: archive.digest,
        contract,
      }),
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
