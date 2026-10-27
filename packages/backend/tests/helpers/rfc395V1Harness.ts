// RFC-395 II-b V1: real provider fixtures, frozen history installation and existing backup exporters.
import { beforeAll, beforeEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeR2Providers, type R2Harness } from './rfc395R2Harness'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import {
  loadSupportedSourceManifest,
  compileEpoch1PostgresqlCatalog,
  type SupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'
import { collectSourceFingerprint } from '@/platform/persistence/migration/sourceCatalog'
import {
  applyFrozenSqliteMigrations,
  createFrozenSqliteJournal,
} from '@/platform/persistence/migration/epoch1/sqliteChain'
import { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import { openEpoch1PostgresqlSource } from '@/platform/persistence/migration/postgresqlSourceReader'
import { exportEpoch1PostgresqlSource } from '@/platform/persistence/migration/postgresqlSourceExport'
import type { LogicalTableContract } from '@/platform/persistence/schema/contractTypes'
import type { CanonicalLogicalValue } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import type { VersionedSourceReader } from '@/platform/persistence/migration/sourceTypes'
import {
  migratePostgresqlSchema,
  activateHostedPostgresqlGeneration,
} from '@/platform/persistence/migration/legacy/postgresqlMigrator'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/migration/legacy/logicalDatabaseExport'
import {
  writeManifest,
  readDbMigrationIdentity,
} from '@/platform/persistence/migration/legacy/backupManifest'
import { vacuumSqliteInto } from '@/platform/persistence/migration/legacy/sqliteSnapshot'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type { PostgresqlMigrationVersion } from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'
import type { SourceFingerprint } from '@/platform/persistence/migration/sourceTypes'
import { readPostgresqlMajor } from '@/platform/persistence/schema/history/catalog'
import { postgresqlHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { pinnedSnapshotReader } from '@/platform/persistence/migration/freeze/liveSnapshot'

const sourceManifests = new Map<string, Promise<SupportedSourceManifest>>()

export interface V1Harness extends R2Harness {
  readonly operationRoot: string
  source(): Promise<VersionedSourceReader>
  manifest(): Promise<SupportedSourceManifest>
  install(which?: 'head' | 'pre-seq' | 'root'): Promise<PostgresqlMigrationVersion>
  fingerprint(): Promise<SourceFingerprint>
  seed(): Promise<void>
  backup(
    version: PostgresqlMigrationVersion,
  ): Promise<{ root: string; artifactRoot: string; envelopeFileDigest: string; close(): void }>
}
export async function installFrozenSqlite(database: Database, through: number): Promise<void> {
  const history = await loadFrozenEpoch1History()
  createFrozenSqliteJournal(database)
  applyFrozenSqliteMigrations(database, history.sqlite.slice(0, through))
  database.exec('PRAGMA foreign_keys = ON')
}
export function describeV1Providers(name: string, body: (h: V1Harness) => void): void {
  describeR2Providers(name, (h) => {
    const provider = h.provider
    let operationRoot: string
    beforeEach(() => {
      operationRoot = mkdtempSync(join(tmpdir(), 'aw-v1-operation-'))
    }, 5_000)
    const readers = new Set<VersionedSourceReader>()
    h.afterTest(async () => {
      const results = await Promise.allSettled([...readers].map((reader) => reader.close()))
      readers.clear()
      if (operationRoot) rmSync(operationRoot, { recursive: true, force: true })
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      )
      if (errors.length) throw new AggregateError(errors, 'V1 source reader cleanup')
    })
    let manifest: Promise<SupportedSourceManifest> | undefined
    const getManifest = () =>
      (manifest ??= (async () => {
        const history = await loadFrozenEpoch1History()
        const major =
          provider === 'postgresql'
            ? await readPostgresqlMajor(postgresqlHistoryConnection(h.referencePool))
            : 0
        const key = `${provider}:${history.chainDigest}:${major}`
        let pending = sourceManifests.get(key)
        if (!pending) {
          pending = loadSupportedSourceManifest(
            provider === 'sqlite'
              ? {}
              : {
                  async postgresqlCatalog(version) {
                    const connection = await h.referencePool.reserve()
                    try {
                      return await compileEpoch1PostgresqlCatalog(connection, version)
                    } finally {
                      connection.release()
                    }
                  },
                },
          ).catch((error: unknown) => {
            sourceManifests.delete(key)
            throw error
          })
          sourceManifests.set(key, pending)
        }
        return await pending
      })())
    // Compile every supported source once, outside Bun's default 5s test budget.
    beforeAll(async () => {
      await getManifest()
    }, 90_000)
    const extended: V1Harness = {
      get operationRoot() {
        return operationRoot
      },
      async source() {
        const manifest = await getManifest()
        const reader =
          h.provider === 'sqlite'
            ? await openEpoch1SqliteSource({ path: h.sqlitePath, manifest, operationRoot })
            : await openEpoch1PostgresqlSource({
                runtime: h.runtime,
                manifest,
                contentRoot: operationRoot,
              })
        readers.add(reader)
        return reader
      },
      get provider() {
        return provider
      },
      get native() {
        return h.native
      },
      get sqlite() {
        return h.sqlite
      },
      get sqlitePath() {
        return h.sqlitePath
      },
      get runtime() {
        return h.runtime
      },
      get pool() {
        return h.pool
      },
      get cache() {
        return h.cache
      },
      table: h.table,
      apply: h.apply,
      admit: h.admit,
      transaction: h.transaction,
      manifest: getManifest,
      async install(which = 'head') {
        await getManifest()
        const history = await loadFrozenEpoch1History()
        // pre-seq: the version just before RFC-374 added node_runs.seq; later heads move the tail.
        const seqStep = history.postgresql.steps.findIndex(
          (step) => step.id === '0036_rfc374_node_run_seq',
        )
        if (which === 'pre-seq' && seqStep < 0)
          throw new Error('frozen history lacks the RFC-374 node_run_seq step')
        const version =
          which === 'root'
            ? history.postgresql.root
            : which === 'pre-seq'
              ? history.postgresql.versions[seqStep]!
              : history.postgresql.head
        await h.installFixture(
          `${history.chainDigest}:${version.plan.digest}:${version.sqliteMigrations.length}`,
          async () => {
            if (h.provider === 'sqlite')
              await installFrozenSqlite(h.sqlite, version.sqliteMigrations.length)
            else
              await migratePostgresqlSchema({
                runtime: h.runtime,
                headContract: frozenEpoch1Contract,
                plan: version.plan,
              })
          },
        )
        return version
      },
      async fingerprint() {
        return h.provider === 'sqlite'
          ? collectSourceFingerprint(h.sqlite)
          : await collectSourceFingerprint(h.native)
      },
      async seed() {
        await h.native.execute(`DELETE FROM ${h.table('maintenance_state')}`)
        for (const key of ['v1-z', 'v1-a', 'v1-é']) {
          const parameters = h.provider === 'sqlite' ? '?,?,?' : '$1,$2,$3'
          await h.native.execute(
            `INSERT INTO ${h.table('maintenance_state')} (key,value,updated_at) VALUES (${parameters})`,
            [key, '{ "original": 1 }\n', 123],
          )
        }
      },
      async backup(version) {
        const root = mkdtempSync(join(tmpdir(), 'aw-v1-backup-'))
        const artifactRoot = join(root, 'database/logical')
        mkdirSync(artifactRoot, { recursive: true })
        const generationId = 'dbg_rfc395_v1_backup_fixture'
        if (h.provider === 'postgresql') {
          await activateHostedPostgresqlGeneration({
            runtime: h.runtime,
            generation: { generationId, operationId: 'dbm_rfc395_v1_fixture' },
            contractDigest: version.contract.digest,
            planDigest: version.plan.digest,
            now: 123,
          })
        }
        const source = await extended.source()
        try {
          const preflight = await source.preflight()
          const fingerprint = await extended.fingerprint()
          // The reader exports its immutable copy. Check the live source at both
          // boundaries, not by rescanning both full databases for every empty table.
          const snapshot = pinnedSnapshotReader(source, preflight)
          if (h.provider === 'sqlite') await source.assertUnchanged(preflight)
          const exportInput = {
            operationId: 'dbm_rfc395_v1_export',
            sourceProvider: h.provider,
            sourceGenerationId: generationId,
            contract: version.contract,
            artifactRoot,
            chunkRows: 2,
            expectedTableRows: Object.fromEntries(
              version.contract.tables
                .filter((table) => h.provider === 'sqlite' || table.providerTables.postgresql)
                .map((table) => [
                  table.id,
                  fingerprint.tableRows[
                    h.provider === 'sqlite' ? table.id : `agent_workflow.${table.id}`
                  ]!,
                ]),
            ),
            source: {
              provider: h.provider,
              assertUnchanged: () => snapshot.assertUnchanged(preflight),
              async readChunk(
                table: LogicalTableContract,
                afterKey: readonly CanonicalLogicalValue[] | null,
                limit: number,
              ) {
                return (await source.readChunk(table.id, afterKey, limit)).rows
              },
            },
            ...(h.provider === 'postgresql'
              ? {
                  emptyArchive: { kind: 'born-hosted' as const, async assertProvenance() {} },
                }
              : {}),
          }
          const receipt =
            h.provider === 'postgresql'
              ? await exportEpoch1PostgresqlSource({ ...exportInput, source })
              : await exportLogicalDatabaseArtifact(exportInput)
          if (h.provider === 'sqlite') {
            await source.assertUnchanged(preflight)
            vacuumSqliteInto({ dbPath: h.sqlitePath, dest: join(root, 'db.sqlite') })
          }
          writeManifest(root, {
            manifestVersion: 2,
            kind: 'manual',
            appVersion: 'v1-fixture',
            createdAt: 123,
            includesWorktrees: false,
            migration:
              h.provider === 'sqlite'
                ? readDbMigrationIdentity(h.sqlitePath)!
                : { lastHash: null, lastCreatedAt: null },
            database: {
              format: 'agent-workflow-logical-database-v1',
              provider: h.provider,
              sourceGenerationId: generationId,
              schemaDigest: version.contract.digest,
              logicalPath: 'database/logical',
              envelopeFileDigest: receipt.envelopeFileDigest,
              rawSqlitePath: h.provider === 'sqlite' ? 'db.sqlite' : null,
            },
          })
          writeFileSync(
            join(root, 'hosted-backup.json'),
            canonicalSchemaJson({
              format: 'aw-hosted-database-backup-v2',
              backupId: 'f3e91d68-6cc4-451f-b9d3-515ce996a7cf',
              kind: 'manual',
              installation: 'fixture',
              objectSpaceId: '3ca3d488-6baa-4d21-a8a8-34efaa75b0d7',
              keyFingerprint: 'a'.repeat(64),
              createdAt: 123,
              snapshotAt: 123,
              schemaDigest: version.contract.digest,
              sourceGenerationId: generationId,
              contents: { workflows: 0, skills: 0 },
            }),
          )
          return {
            root,
            artifactRoot,
            envelopeFileDigest: receipt.envelopeFileDigest,
            close: () => rmSync(root, { recursive: true, force: true }),
          }
        } catch (error) {
          rmSync(root, { recursive: true, force: true })
          throw error
        } finally {
          await source.close()
        }
      },
    }
    body(extended)
  })
}
