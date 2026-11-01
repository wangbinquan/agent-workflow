// RFC-398 §3.8/§7.6: original release catalogs and live PostgreSQL rows, not epoch-1-head substitutes.
// Each released PostgreSQL source registers from its own test file
// (rfc398-postgresql-bridge-<tag>.test.ts): both releases together ran about 4.6 CI minutes, most
// of a 15-minute backend shard. rfc398-split-test-coverage.test.ts requires one file per release.
import { expect, test } from 'bun:test'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  releasedPostgresqlSources,
  type ReleasedPostgresqlSource,
} from '@/platform/persistence/migration/epoch1/releasedPostgresql'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import {
  applyFrozenSqliteMigrations,
  createFrozenSqliteJournal,
} from '@/platform/persistence/migration/epoch1/sqliteChain'
import {
  compileEpoch1PostgresqlCatalog,
  loadSupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'
import { executePostgresqlReferenceStatements } from '@/platform/persistence/postgresql/referenceStatements'
import { openEpoch1PostgresqlSource } from '@/platform/persistence/migration/postgresqlSourceReader'
import { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import {
  openFrozenSource,
  frozenSourceDetails,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import {
  bridgeReleasedPostgresql,
  PostgresqlBridgeBlockedError,
} from '@/platform/persistence/migration/postgresqlBridge'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/migration/legacy/logicalDatabaseExport'
import { openVerifiedLogicalDatabaseArtifactSource } from '@/platform/persistence/migration/legacy/logicalDatabaseRestore'
import { decodeLogicalRow } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { collectSqliteHistoryCatalog } from '@/platform/persistence/schema/history/catalog'
import { composeConversionInput, composeBootUpgradeEnvironment } from '@/bootstrap/conversionRules'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { explainSourceRow } from '@/platform/persistence/migration/conversion/trace'
import { canonicalValue } from '@/platform/persistence/migration/conversion/migrationKey'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { epochMigrationCommand } from '@/cli/epochMigration'
import { createMigrationTraceQuery } from '@/modules/system-operations/application/epochSwitch/trace'
import { createMigrationMetaStore } from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { createTargetLoader } from '@/platform/persistence/migration/target/loader'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { openConversionTarget } from '@/platform/persistence/migration/target/connection'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import type {
  MigrationRunInit,
  FrozenSourceHandle,
} from '@/platform/persistence/migration/run/types'
import { FakeContentInventory, frozenValues } from './rfc395V2/contentFixtures'
import { taskRow } from './rfc395V2/taskFixtures'
import { ordinaryDefinition, runValues } from './rfc395V2/runFixtures'
import { makeSwitchFixture } from './rfc395V3SwitchFixture'
import { describeRfc398Postgresql, rfc398Postgresql, pgQuote } from './rfc398Postgresql'

async function fixture(release: ReleasedPostgresqlSource, invalid = false) {
  const f = await rfc398Postgresql()
  try {
    const source = await f.create()
    const reference = await f.create()
    const runtime = f.runtime(source.database)
    const compiler = await f.runtime(reference.database).providerPool().reserve()
    let manifest
    try {
      manifest = await loadSupportedSourceManifest({
        postgresqlCatalog: (version) => compileEpoch1PostgresqlCatalog(compiler, version),
      })
    } finally {
      compiler.release()
    }
    const sqliteManifest = {
      ...manifest,
      sources: manifest.sources.map((entry) =>
        entry.provider === 'sqlite' && entry.sqliteThrough === release.sqliteMigrations.length
          ? { ...entry, contract: release.contract, readMode: 'frozen-codec' as const }
          : entry,
      ),
    }
    const path = join(f.root, 'original.sqlite')
    const sqlite = new Database(path)
    try {
      createFrozenSqliteJournal(sqlite)
      applyFrozenSqliteMigrations(
        sqlite,
        (await loadFrozenEpoch1History()).sqlite.slice(0, release.sqliteMigrations.length),
      )
      for (const row of sqlite
        .query(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name <> '__drizzle_migrations'",
        )
        .all() as { name: string }[])
        sqlite.exec(`DELETE FROM ${pgQuote(row.name)}`)
      const insert = (table: string, values: Record<string, unknown>) => {
        const columns = release.contract.tables
          .find((entry) => entry.id === table)!
          .columns.filter((column) => Object.hasOwn(values, column.name))
        sqlite
          .query(
            `INSERT INTO ${pgQuote(table)} (${columns.map((column) => pgQuote(column.name)).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(
            ...columns.map((column) => {
              const value = values[column.name]
              return (typeof value === 'boolean' ? Number(value) : value) as SQLQueryBindings
            }),
          )
      }
      insert(
        'users',
        frozenValues('users', {
          id: '__system__',
          username: '__system__',
          display_name: 'System',
          created_by: null,
        }),
      )
      insert('auth_login_policy', frozenValues('auth_login_policy', { id: 'global' }))
      insert(
        'employee_os_writer_state',
        frozenValues('employee_os_writer_state', {
          id: 'global',
          active_generation: 0,
          mode: 'pre-cutover',
          legacy_admissions_enabled: true,
          legacy_open_mission_count: 0,
        }),
      )
      insert('code_artifacts', {
        id: 'retained-code',
        repo_path: '/original/repo',
        commit_sha: 'retained-commit',
        base_sha: 'retained-base',
        digest: 'retained-diff',
        keep_ref: 'refs/retained/original',
        generation: 1,
        ref_count: 0,
        state: 'released',
        created_at: 100,
        released_at: 101,
      })
      insert('maintenance_state', {
        key: 'bridge-bytes',
        value: ' { "kept": "原始" }\r\n',
        updated_at: 123,
      })
    } finally {
      sqlite.close()
    }
    const sqliteReader = openEpoch1SqliteSource({
      path,
      manifest: sqliteManifest,
      operationRoot: join(f.root, 'original-reader'),
      sourceGenerationId: 'dbg_original_sqlite',
    })
    const artifactRoot = join(f.root, 'retained')
    try {
      const preflight = await sqliteReader.preflight()
      const exported = await exportLogicalDatabaseArtifact({
        operationId: 'dbm_original_release',
        sourceProvider: 'sqlite',
        sourceGenerationId: preflight.sourceGenerationId,
        contract: release.contract,
        artifactRoot,
        expectedTableRows: Object.fromEntries(
          release.contract.tables.map((table) => [
            table.id,
            preflight.fingerprint.tableRows[table.sourceTable] ?? 0,
          ]),
        ),
        now: () => 123,
        source: {
          provider: 'sqlite',
          assertUnchanged: () => sqliteReader.assertUnchanged(preflight),
          readChunk: async (table, after, limit) =>
            (await sqliteReader.readChunk(table.id, after, limit)).rows,
        },
      })
      const archive = openVerifiedLogicalDatabaseArtifactSource({
        artifactRoot,
        contract: release.contract,
        expectedManifestDigest: exported.manifest.digest,
        expectedLegacyArchiveFileDigest: exported.legacyArchiveFileDigest,
      })
      const connection = await runtime.providerPool().reserve()
      try {
        await executePostgresqlReferenceStatements(
          connection,
          release.plan.statements.map((statement) => statement.sql),
        )
      } finally {
        connection.release()
      }
      await source.sql.unsafe(
        'INSERT INTO agent_workflow_meta.schema_migrations (baseline_id,contract_digest,plan_digest,applied_at) VALUES ($1,$2,$3,$4)',
        [release.plan.baselineId, release.contract.digest, release.plan.digest, 123],
      )
      const insert = async (table: string, values: Record<string, unknown>) => {
        const contract = release.contract.tables.find((entry) => entry.id === table)!
        const columns = contract.columns.filter((column) => Object.hasOwn(values, column.name))
        await source.sql.unsafe(
          `INSERT INTO agent_workflow.${pgQuote(contract.providerTables.postgresql!)} (${columns.map((column) => pgQuote(column.name)).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
          columns.map((column) => values[column.name]),
        )
      }
      for (const table of release.contract.tables.filter(
        (table) => table.providerTables.postgresql,
      )) {
        const entry = archive.verification.manifest.payload.tables.find(
          (entry) => entry.table === table.id,
        )!
        for (let index = 0; index < entry.chunkCount; index++)
          for (const row of archive.readChunk(table, index).payload.rows)
            await insert(table.id, decodeLogicalRow(table, row))
      }
      // These rows are created after the switch. PostgreSQL has no SQLite lineage trigger.
      await insert(
        'tasks',
        taskRow('after-switch', {
          space_kind: 'internal',
          workflow_id: 'deleted-workflow',
          repo_count: 0,
          workflow_snapshot: JSON.stringify(ordinaryDefinition),
          repo_path: '',
          base_branch: '',
          branch: '',
          base_commit: '',
          worktree_path: '',
        }),
      )
      await insert(
        'node_runs',
        runValues('after-switch-run', {
          task_id: 'after-switch',
          lineage_slot_path_json: null,
          continuation_slot_key: null,
          ...(invalid ? { container_run_id: 'missing-parent' } : {}),
        }),
      )
      if (invalid)
        await insert(
          'node_runs',
          runValues('second-bad-run', {
            task_id: 'after-switch',
            container_run_id: 'another-missing-parent',
            lineage_slot_path_json: null,
          }),
        )
      const open = (operationRoot: string) =>
        openFrozenSource({
          location: { kind: 'postgresql-database', profileRef: 'env:SOURCE' },
          manifest,
          operationRoot,
          emptyTables: [],
          postgresql: () => runtime,
          postgresqlArchive: async () => ({
            kind: 'retained-epoch1-archive',
            path: artifactRoot,
            digest: exported.legacyArchiveFileDigest,
          }),
        })
      return {
        ...f,
        source,
        sourceRuntime: runtime,
        manifest,
        archive,
        archiveDigest: exported.legacyArchiveFileDigest,
        artifactRoot,
        open,
      }
    } finally {
      await sqliteReader.close()
    }
  } catch (error) {
    await f.close()
    throw error
  }
}

async function conversionInput(source: FrozenSourceHandle, root: string) {
  const content = new FakeContentInventory()
  const artifacts = new Map<string, Uint8Array>()
  const bootUpgradeFacts = await composeBootUpgradeEnvironment({ open: async () => null }).capture({
    stage: 'plan',
    source,
    content,
    root: { kind: 'app-home', root, runsSupplied: false, objects: 'none' },
    manifest: {
      version: 1,
      roots: [],
      files: [],
      objects: [],
      databaseTrees: [],
      digest: valueDigest([]),
    },
    readArtifact: async (name) => artifacts.get(name) ?? null,
    writeArtifact: async (name, bytes) => {
      artifacts.set(name, bytes)
    },
  })
  return composeConversionInput({
    source: source.reader,
    preflight: source.preflight,
    preUpgradeSource: source.preUpgrade!.reader,
    preUpgradePreflight: source.preUpgrade!.preflight,
    content,
    scratchRoot: join(root, 'convert-scratch'),
    targetGeneration: 'dbg_rfc398_bridge_target',
    candidateBuild: 'rfc398-bridge-test',
    sourceBackupId: null,
    contentManifestDigest: valueDigest([]),
    planTime: 123,
    chunkLimit: 17,
    bootUpgradeFacts,
  })
}

export const BRIDGE_RELEASE_TAGS: readonly string[] = releasedPostgresqlSources.map((r) => r.tag)

/** Registers the bridge cases for one released PostgreSQL source. */
export function registerBridgeRelease(tag: string): void {
  const release = releasedPostgresqlSources.find((r) => r.tag === tag)
  if (!release) throw new Error(`unknown released PostgreSQL source ${tag}`)
  describeRfc398Postgresql('RFC-398 original PostgreSQL logical bridge', () => {
    test(`${release.tag}: exact catalog/receipts, retained archive, NULL lineage, conversion and trace --replay`, async () => {
      const f = await fixture(release)
      let frozen: FrozenSourceHandle | undefined
      const reader = openEpoch1PostgresqlSource({
        runtime: f.sourceRuntime,
        manifest: f.manifest,
        contentRoot: f.root,
      })
      try {
        const expected = await reader.preflight()
        expect(expected.contract?.digest).toBe(release.contract.digest)
        const bridgePath = join(f.root, 'direct/bridge.sqlite')
        const bridge = await bridgeReleasedPostgresql({
          release,
          source: reader,
          expected,
          manifest: f.manifest,
          path: bridgePath,
          archive: f.archive,
          archiveDigest: f.archiveDigest,
        })
        try {
          expect(
            (await bridge.reader.readChunk('node_runs', null, 10)).decodedRows[0]
              ?.lineage_slot_path_json,
          ).toBeNull()
          expect(
            (await bridge.reader.readChunk('code_artifacts', null, 10)).decodedRows[0]?.commit_sha,
          ).toBe('retained-commit')
          expect(bridge.preflight.fingerprint).toEqual(expected.fingerprint)
          expect(bridge.preflight.identityHighWater).toEqual(expected.identityHighWater)
          expect(bridge.preflight.watermark).toBe(expected.watermark)
          const db = new Database(bridgePath, { readonly: true })
          try {
            expect(collectSqliteHistoryCatalog(db)).toEqual(release.sqliteCatalog)
            expect(
              db
                .query('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
                .all(),
            ).toEqual(
              release.sqliteMigrations.map((row) => ({
                hash: row.hash,
                created_at: row.folderMillis,
              })),
            )
            expect(
              db
                .query(
                  "SELECT sql FROM sqlite_schema WHERE name='rfc328_node_runs_lineage_after_insert'",
                )
                .get(),
            ).toBeTruthy()
          } finally {
            db.close()
          }
          expect(bridge.receipt.tables.filter((table) => table.origin === 'archive')).toHaveLength(
            6,
          )
          expect(
            bridge.receipt.tables.find((table) => table.table === 'code_artifacts')?.rows,
          ).toBe(1)
          for (const table of bridge.receipt.tables)
            expect(table.sqliteDigest).toBe(table.sourceDigest)
        } finally {
          await bridge.reader.close()
        }
        await reader.close()
        const operationRoot = join(f.root, 'operation')
        frozen = await f.open(operationRoot)
        expect(frozen.preflight.fingerprint.provider).toBe('postgresql')
        expect(frozenSourceDetails(frozen).originalPreflight).toEqual(expected)
        expect(
          (await frozen.preUpgrade!.reader.readChunk('node_runs', null, 10)).decodedRows[0]
            ?.lineage_slot_path_json,
        ).toBeNull()
        const receiptRoot = join(operationRoot, 'source-access/bridges')
        const receiptPath = join(receiptRoot, readdirSync(receiptRoot)[0]!, 'receipt.json')
        const receipt = readFileSync(receiptPath)
        const bound = {
          watermark: frozen.watermark,
          preUpgradeWatermark: frozen.preUpgrade!.preflight.watermark,
          sourceGenerationId: frozen.preflight.sourceGenerationId,
        }
        await frozen.close()
        // Reopening for replay must reproduce the receipt and original source identity.
        frozen = await f.open(operationRoot)
        expect({
          watermark: frozen.watermark,
          preUpgradeWatermark: frozen.preUpgrade!.preflight.watermark,
          sourceGenerationId: frozen.preflight.sourceGenerationId,
        }).toEqual(bound)
        expect(readFileSync(receiptPath)).toEqual(receipt)
        const input = await conversionInput(frozen, f.root)
        const head = createHistoryVersion({ registry: persistenceSchema, slug: 'baseline' })
        const destination = await f.create()
        const target = openConversionTarget({ runtime: f.runtime(destination.database) })
        const cliFixture = makeSwitchFixture()
        try {
          await installConversionTarget(target, {
            head,
            metaTables: EPOCH2_META_TABLES,
            generationId: input.targetGeneration,
            now: 123,
          })
          const meta = createMigrationMetaStore({ target, registry: persistenceSchema })
          const plan = planConversion(input)
          const run: MigrationRunInit = {
            version: 1,
            runId: 'emr_rfc398_bridge',
            operationId: 'dbm_e2_rfc398_bridge',
            ordinal: 0,
            kind: 'epoch-conversion',
            role: 'converted',
            sourceProvider: 'postgresql',
            sourceEpoch: 1,
            sourceKind: input.preflight.kind,
            targetProvider: 'postgresql',
            targetEpoch: 2,
            migrationPlanDigest: valueDigest('migration'),
            approvalDigest: valueDigest('approval'),
            conversionPlan: plan,
            emptyTables: [],
            startedAt: 123,
          }
          const sink = createTargetConversionSink({
            target,
            meta,
            loader: createTargetLoader({ registry: persistenceSchema, provider: 'postgresql' }),
            run,
            now: () => 123,
          })
          const converted = await runConversion(input, sink)
          expect(converted.blocks).toEqual([])
          expect(converted.status).toBe('converted')
          const trace = createMigrationTraceQuery({
            meta,
            replay: {
              async replay(query) {
                const result = await explainSourceRow(input, query.table, query.key, query.phase)
                return {
                  runId: run.runId,
                  sourceTable: result.sourceTable,
                  sourcePhase: result.sourcePhase,
                  sourceKey: result.sourceKey,
                  proof: result.found ? 'replay' : 'not-found',
                  class: result.class,
                  dispositions: result.dispositions,
                  unit: null,
                  targets: await Promise.all(
                    result.targets.map(async (target) => ({
                      ...target,
                      probed: true,
                      present: await meta.probeTarget(target),
                    })),
                  ),
                  artifacts: [],
                  restrictions: result.dispositions.flatMap((row) =>
                    row.history ? [row.history] : [],
                  ),
                  blocks: result.blocks,
                  archive: result.dispositions.find((row) => row.archive)?.archive ?? null,
                }
              },
            },
          })
          for (const [table, key] of [
            ['maintenance_state', 'bridge-bytes'],
            ['node_runs', 'after-switch-run'],
            ['code_artifacts', 'retained-code'],
          ] as const) {
            const phase = input.preflight.tables.some((entry) => entry.table === table)
              ? 'current'
              : 'pre-upgrade'
            const result = await epochMigrationCommand(
              [
                'trace',
                run.operationId,
                table,
                JSON.stringify([canonicalValue(key)]),
                '--phase',
                phase,
                '--replay',
                '--json',
              ],
              { application: { ...cliFixture.app, trace } },
            )
            expect(result.status).toBe('ok')
            // `--replay` only re-converts when the unit evidence cannot decide membership
            // (trace.ts returns the committed unit-range proof first), so the CLI answer may be
            // either proof; it must be found, unblocked and every named target must exist.
            const traced = JSON.parse(result.output) as {
              proof: string
              blocks: unknown[]
              targets: { probed: boolean; present: boolean }[]
            }
            expect(traced.proof).not.toBe('not-found')
            expect(traced.blocks).toEqual([])
            expect(traced.targets.every((entry) => entry.probed && entry.present)).toBe(true)
            // The bridged source itself must replay: re-run the conversion for this exact row.
            const replayed = await explainSourceRow(input, table, [canonicalValue(key)], phase)
            expect({ found: replayed.found, blocks: replayed.blocks }).toEqual({
              found: true,
              blocks: [],
            })
          }
        } finally {
          cliFixture.close()
          await target.close()
        }
      } finally {
        await frozen?.close()
        await reader.close()
        await f.close()
      }
    }, 300_000)

    test(`${release.tag}: removing the independent registration fails exact source identification`, async () => {
      const f = await fixture(release)
      const reader = openEpoch1PostgresqlSource({
        runtime: f.sourceRuntime,
        manifest: {
          ...f.manifest,
          sources: f.manifest.sources.filter(
            (entry) => entry.contract?.digest !== release.contract.digest,
          ),
        },
        contentRoot: f.root,
      })
      try {
        await expect(reader.preflight()).rejects.toThrow()
      } finally {
        await reader.close()
        await f.close()
      }
    }, 180_000)

    test(`${release.tag}: SQLite-only foreign-key violations report every offending PostgreSQL row`, async () => {
      const f = await fixture(release, true)
      try {
        let error: unknown
        try {
          await f.open(join(f.root, 'blocked'))
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(PostgresqlBridgeBlockedError)
        const blocks = (error as PostgresqlBridgeBlockedError).blocks.filter(
          (row) => row.table === 'node_runs',
        )
        expect(blocks.map((row) => row.key).sort()).toEqual(
          [[canonicalValue('after-switch-run')], [canonicalValue('second-bad-run')]].sort(),
        )
        expect(blocks.every((row) => row.constraint.startsWith('foreign-key:') && row.row)).toBe(
          true,
        )
        expect(
          (
            await f.source.sql.unsafe('SELECT lineage_slot_path_json FROM agent_workflow.node_runs')
          ).every((row: Record<string, unknown>) => row.lineage_slot_path_json === null),
        ).toBe(true)
      } finally {
        await f.close()
      }
    }, 180_000)
  })
}
