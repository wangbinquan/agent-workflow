import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { V2Harness } from '../rfc395V2Harness'
import { frozenValues } from './contentFixtures'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import {
  compareCanonicalLogicalKeys,
  encodeLogicalRow,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/migration/legacy/logicalDatabaseExport'
import { openVerifiedLogicalDatabaseArtifactSource } from '@/platform/persistence/migration/legacy/logicalDatabaseRestore'
import { exportEpoch1PostgresqlSource } from '@/platform/persistence/migration/postgresqlSourceExport'
import { openEpoch1LogicalArtifactSource } from '@/platform/persistence/migration/artifactSourceReader'
import { composePostgresqlArchiveSource } from '@/platform/persistence/migration/conversion/postgresqlArchiveSource'

/** Real RFC-349 artifacts and physical export evidence. Only the original
 * archive's rows are synthetic; they use the frozen codecs and durable exporter. */
export async function archivedHistoryFixture(h: V2Harness) {
  const version = await h.install()
  const root = mkdtempSync(join(h.sourceHarness.operationRoot, 'retained-history-'))
  const archivedTables = version.contract.tables.filter(
    (table) => table.disposition === 'ARCHIVE_THEN_OMIT',
  )
  const values = new Map(
    archivedTables.map((table) => [
      table.id,
      ['z', 'a', 'é'].map((suffix) =>
        frozenValues(
          table.id,
          Object.fromEntries([
            ...table.migrationKey.map((key) => [key, `retained-${suffix}`]),
            ...(table.id === 'code_fix_attempts' ? [['work_item_id', `work-${suffix}`]] : []),
            ...table.columns
              .filter((column) => column.logicalCodec === 'json-text')
              .map((column) => [column.name, ` { "original": "${suffix}" }\r\n`]),
          ]),
        ),
      ),
    ]),
  )
  const originals = new Map(
    archivedTables.map((table) => [
      table.id,
      values
        .get(table.id)!
        .map((row) => encodeLogicalRow(table, row))
        .sort((a, b) => compareCanonicalLogicalKeys(a.key, b.key)),
    ]),
  )
  const retainedRoot = join(root, 'retained')
  const retained = await exportLogicalDatabaseArtifact({
    operationId: 'dbm_pgxa_retained_fixture',
    sourceProvider: 'sqlite',
    sourceGenerationId: 'dbg_pgxa_retained_fixture',
    contract: frozenEpoch1Contract,
    artifactRoot: retainedRoot,
    chunkRows: 2,
    expectedTableRows: Object.fromEntries(
      frozenEpoch1Contract.tables.map((table) => [table.id, originals.get(table.id)?.length ?? 0]),
    ),
    source: {
      provider: 'sqlite',
      async assertUnchanged() {},
      async readChunk(table, after, limit) {
        return (originals.get(table.id) ?? [])
          .filter((row) => after === null || compareCanonicalLogicalKeys(row.key, after) > 0)
          .slice(0, limit)
      },
    },
  })
  const archive = openEpoch1LogicalArtifactSource({
    artifactRoot: retainedRoot,
    envelopeFileDigest: retained.envelopeFileDigest,
  })
  if (h.sourceHarness.provider === 'sqlite')
    for (const [table, rows] of values) await h.write(table, rows)
  const physical = await h.sourceHarness.source()
  try {
    const backup =
      h.sourceHarness.provider === 'sqlite'
        ? await h.sourceHarness.backup(version)
        : await (async () => {
            const artifactRoot = join(root, 'postgresql-export')
            const receipt = await exportEpoch1PostgresqlSource({
              source: physical,
              artifactRoot,
              operationId: 'dbm_pgxa_export_fixture',
              chunkRows: 2,
              preservedArchive: openVerifiedLogicalDatabaseArtifactSource({
                artifactRoot: retainedRoot,
                contract: frozenEpoch1Contract,
                expectedManifestDigest: retained.manifest.digest,
                expectedLegacyArchiveFileDigest: retained.legacyArchiveFileDigest,
              }),
            })
            return { artifactRoot, envelopeFileDigest: receipt.envelopeFileDigest, close() {} }
          })()
    const native =
      h.sourceHarness.provider === 'postgresql'
        ? await composePostgresqlArchiveSource({ source: physical, archive })
        : physical
    const logical = openEpoch1LogicalArtifactSource({
      artifactRoot: backup.artifactRoot,
      envelopeFileDigest: backup.envelopeFileDigest,
      supportedSources: await h.sourceHarness.manifest(),
    })
    return {
      native,
      logical,
      originals,
      retainedRoot,
      async close() {
        try {
          await native.close()
          await logical.close()
          await archive.close()
        } finally {
          backup.close()
          rmSync(root, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await physical.close()
    await archive.close()
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
