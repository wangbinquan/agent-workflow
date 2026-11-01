// RFC-398 §7.2: released receipt bytes, per-migration seeds, native PG baselines and epoch-2 installation.
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistenceHistory } from '@/bootstrap/persistenceHead'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { releasedPostgresqlSources } from '@/platform/persistence/migration/epoch1/releasedPostgresql'
import {
  encodeLogicalRow,
  decodeLogicalRow,
  compareCanonicalLogicalKeys,
  LogicalDatabaseCodecError,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import {
  postgresqlUpgradeStatementSql,
  renderPostgresqlUpgradeSql,
} from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'
import { withLogicalCodecCorrections } from '@/platform/persistence/migration/supportedSources'
import type { LogicalTableContract } from '@/platform/persistence/schema/contractTypes'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/migration/legacy/logicalDatabaseExport'
import { restoreLogicalDatabaseArtifact } from '@/platform/persistence/migration/legacy/logicalDatabaseRestore'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/migration/legacy/postgresqlLogicalTarget'
import { installHistoryHead } from '@/platform/persistence/schema/history/apply'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/schema'
import { sqliteHistorySession } from '@/platform/persistence/sqlite/historySession'
import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
import {
  writeGenerationPointerV2,
  readGenerationPointerV2,
} from '@/platform/persistence/generationPointerV2'
import type { LogicalSchemaContract } from '@/platform/persistence/schema/contractTypes'
import { rfc398Postgresql } from '../rfc398Postgresql'
import { REPO_ROOT, sha256 } from '../../../../../scripts/release-upgrade/lib/io'
import {
  buildSeedDatabase,
  readApprovedExemptions,
  readSeed,
  SEEDS,
  insertSeed,
  materializeSeedContent,
  applySqliteReceipt,
  migrationSql,
  createJournal,
  sqliteValue,
} from '../../../../../scripts/release-upgrade/lib/seed-ledger'
import type { ReleaseEntry } from '../../../../../scripts/release-upgrade/lib/model'
import type { SeedFile } from '../../../../../scripts/release-upgrade/lib/seed-model'
import { migrationExpectations } from './effects'
import { equal, invariant, q, sqliteSnapshot, pgSnapshot, type Snapshot, type Row } from './data'

export type Variant = 'sqlite' | 'sqlite-no-sidecar' | 'postgresql'
const NOW = 1778459500000
export interface BuiltRelease {
  release: ReleaseEntry
  provider: 'sqlite' | 'postgresql'
  home: string
  env: Record<string, string | undefined>
  seeds: SeedFile[]
  before: Snapshot
  sourcePath: string
  startedAt: number
  pg?: Awaited<ReturnType<typeof rfc398Postgresql>>
  database?: Awaited<ReturnType<Awaited<ReturnType<typeof rfc398Postgresql>>['create']>>
  contract?: LogicalSchemaContract
  snapshotTarget(): Promise<Snapshot>
  close(): Promise<void>
}

export function releaseSeeds(release: ReleaseEntry, seeds = SEEDS): SeedFile[] {
  if (release.epoch1)
    return release.epoch1.sqlite.map((r) =>
      readSeed(join(seeds, 'epoch1', `${r.tag}.json`), 1, r.tag),
    )
  invariant(release.epoch2, 'release has no epoch')
  return [
    readSeed(
      join(seeds, 'epoch2', `${String(release.epoch2.version).padStart(4, '0')}.json`),
      2,
      release.epoch2.history,
    ),
  ]
}
export function assertBuildCoverage(release: ReleaseEntry, snapshot: Snapshot): void {
  const exemptions = readApprovedExemptions()
  for (const [table, rows] of snapshot)
    invariant(
      rows.length > 0 || exemptions.some((e) => e.build === release.buildKey && e.table === table),
      `${release.tag}: uncovered table ${table}`,
    )
}

async function loadPostgresqlBaseline(built: BuiltRelease): Promise<void> {
  const { release, pg, database, home } = built
  invariant(pg && database && release.epoch1?.postgresql, 'missing PG fixture')
  const history = await loadFrozenEpoch1History()
  const receipts = release.epoch1.postgresql
  const baseline =
    release.epoch1.postgresqlSource === 'released-baseline'
      ? releasedPostgresqlSources.find((v) => v.tag === release.tag)
      : history.postgresql.versions[0]
  invariant(baseline, `${release.tag}: baseline absent`)
  equal(
    [baseline.contract.digest, baseline.plan.digest],
    [receipts[0]!.contractDigest, receipts[0]!.planDigest],
    'original baseline identity',
  )
  const baselineRelease: ReleaseEntry = {
    ...release,
    epoch1: {
      ...release.epoch1,
      sqlite: release.epoch1.sqlite.slice(0, baseline.sqliteMigration.count),
    },
  }
  const staging = join(home, 'build-sqlite-position')
  const coverage = buildSeedDatabase(baselineRelease, staging, {
    contentHome: home,
    beforeMigration: migrationExpectations,
  })
  equal(coverage.failures, [], 'PG baseline SQLite position')
  const db = new Database(join(staging, 'db.sqlite'))
  const sourceGenerationId = 'dbg_rfc398_release_source'
  const operationId = 'dbm_rfc398_release_builder'
  const artifactRoot = join(home, 'build-logical-artifact')
  const runtime = pg.runtime(database.database)
  // Frozen V9 codec corrections (e.g. 0038: user_permission_grants.permission is plain text).
  const corrections = history.postgresql.steps.flatMap((step) => step.logicalCodecs ?? [])
  // The historical codec rejects such values, exactly as the old one-click copy did; real
  // installations only hold them when written directly on PostgreSQL. Those rows bypass the
  // logical artifact and are inserted after the restore.
  const direct: { table: LogicalTableContract; row: Row }[] = []
  // Released 0219 seeds an aggregate head for every pre-cutover task revision without replaying
  // its completed outbox events. Every released RFC-349 copy (v0.18.18–v0.19.2) refuses that
  // shape through its `committed-event-head` invariant (query identical in every PG-capable
  // release), so no real PostgreSQL source holds such a head. The builder withholds them; the PG
  // expected snapshot is derived from the built source, so the oracle sees the same rows.
  const unreplayedHead = (() => {
    const chains = new Map(
      db
        .query<Row, []>(
          `SELECT producer, family, aggregate_kind, aggregate_id, MAX(aggregate_seq) AS max_seq, COUNT(*) AS events FROM committed_events GROUP BY producer, family, aggregate_kind, aggregate_id`,
        )
        .all()
        .map((chain) => [
          JSON.stringify([chain.producer, chain.family, chain.aggregate_kind, chain.aggregate_id]),
          chain,
        ]),
    )
    return (table: LogicalTableContract, row: Row) => {
      if (table.id !== 'committed_event_aggregate_heads') return false
      const chain = chains.get(
        JSON.stringify([row.producer, row.family, row.aggregate_kind, row.aggregate_id]),
      )
      return (
        !chain ||
        Number(chain.max_seq) !== Number(row.last_seq) ||
        Number(chain.events) !== Number(chain.max_seq)
      )
    }
  })()
  try {
    const rows = new Map(
      baseline.contract.tables.map((t) => [
        t.id,
        db
          .query<Row, []>(`SELECT * FROM ${q(t.sourceTable)}`)
          .all()
          .flatMap((row) => {
            if (unreplayedHead(t, row)) return []
            try {
              return [encodeLogicalRow(t, row)]
            } catch (error) {
              if (
                !(error instanceof LogicalDatabaseCodecError) ||
                !corrections.some((correction) => correction.tableId === t.id)
              )
                throw error
              direct.push({ table: t, row })
              return []
            }
          })
          .sort((a, b) => compareCanonicalLogicalKeys(a.key, b.key)),
      ]),
    )
    const exported = await exportLogicalDatabaseArtifact({
      operationId,
      sourceProvider: 'sqlite',
      sourceGenerationId,
      contract: baseline.contract,
      artifactRoot,
      now: () => NOW,
      expectedTableRows: Object.fromEntries([...rows].map(([name, rs]) => [name, rs.length])),
      source: {
        provider: 'sqlite',
        async assertUnchanged() {},
        async readChunk(table, after, limit) {
          return rows
            .get(table.id)!
            .filter((row) => after === null || compareCanonicalLogicalKeys(row.key, after) > 0)
            .slice(0, limit)
        },
      },
    })
    const target = await openPostgresqlLogicalTarget({
      runtime,
      operationId,
      sourceGenerationId,
      headContract: history.postgresql.head.contract,
      contract: baseline.contract,
      plan: baseline.plan,
      ...(release.epoch1.postgresqlSource === 'released-baseline'
        ? {
            async verifyMigrationHistory(plan: typeof baseline.plan) {
              equal(plan, baseline.plan, 'released PG plan')
            },
          }
        : {}),
    })
    try {
      await restoreLogicalDatabaseArtifact({
        artifactRoot,
        expectedManifestDigest: exported.manifest.digest,
        expectedLegacyArchiveFileDigest: exported.legacyArchiveFileDigest,
        restoreOperationId: operationId,
        headContract: history.postgresql.head.contract,
        contract: baseline.contract,
        target,
        now: () => NOW,
      })
      await target.prepareGeneration({ generationId: 'dbg_rfc398_native_pg', sourceGenerationId })
      await target.activateGeneration('dbg_rfc398_native_pg', NOW)
      await target.markFinalized(NOW)
    } finally {
      await target.close()
    }
    for (const { table, row } of direct) {
      const codec = withLogicalCodecCorrections(table, corrections)
      const values = decodeLogicalRow(codec, encodeLogicalRow(codec, row))
      const names = Object.keys(values)
      await database.sql.unsafe(
        `INSERT INTO agent_workflow.${q(table.providerTables.postgresql!)} (${names.map(q).join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')})`,
        names.map((name) => values[name]),
      )
    }
    // The restore artifact is a builder input, never an RFC-349 installation manifest/pointer.
    let position = baseline.sqliteMigration.count
    for (const receipt of receipts.slice(1)) {
      const version = history.postgresql.versions.find(
        (v) => v.contract.digest === receipt.contractDigest && v.plan.digest === receipt.planDigest,
      )
      invariant(version, `${release.tag}: unknown PG receipt ${receipt.baselineId}`)
      const bytes = readFileSync(
        join(REPO_ROOT, 'packages/backend/db/postgresql-migrations', receipt.sqlFile),
      )
      equal(sha256(bytes), receipt.sqlSha256, 'PG released SQL digest')
      const step = history.postgresql.steps.find(
        (s) =>
          s.to.contractDigest === receipt.contractDigest && s.to.planDigest === receipt.planDigest,
      )
      invariant(step, `${release.tag}: unknown PG step ${receipt.baselineId}`)
      equal(renderPostgresqlUpgradeSql(step), bytes.toString('utf8'), 'PG released statements')
      await database.sql.begin(async (transaction) => {
        // Replay exactly as the released migrator did (v0.19.2 postgresqlMigrator): V4 retirement
        // artifacts keep the logical FK name (0024 drops `…_clarify_mindmap_sessions_id_fk`, while
        // 0022 created the 63-byte-bounded `…_clarif_29e9cd414115`); the released runtime resolves
        // the physical name from the preceding plan instead of running the artifact text verbatim.
        // Its connections carry `search_path=agent_workflow,public` (postgresqlRuntime), which the
        // unqualified `json_valid(...)` CHECKs of 0030 rely on.
        await transaction.unsafe('SET LOCAL search_path TO agent_workflow, public')
        for (const statement of step.executableStatements) {
          const rows = await transaction.unsafe<Row[]>(
            postgresqlUpgradeStatementSql(
              history.postgresql.versions[step.sequence - 1]!,
              statement,
            ),
          )
          if (statement.logicalId === 'advance-contract-row')
            equal(
              rows.map((row) => row.contract_digest),
              [step.to.contractDigest],
              'released PG contract row advances',
            )
        }
        const seeds: SeedFile[] = []
        while (position < version.sqliteMigration.count) {
          const sqliteReceipt = release.epoch1!.sqlite[position]!
          const seed = built.seeds[position]!
          // Same as buildSeedDatabase: historical migrations may re-enable FK enforcement, and
          // seed rows are not listed in FK order. PostgreSQL re-validates every reference below.
          db.exec('PRAGMA foreign_keys=OFF')
          const checkEffect = migrationExpectations(db, seed)
          applySqliteReceipt(db, migrationSql(release, sqliteReceipt), sqliteReceipt)
          checkEffect()
          insertSeed(db, seed, home)
          seeds.push(seed)
          position++
        }
        // Seed rows are listed per file, not in foreign-key order (0227 lists an operation before
        // the snapshot it references). As in installNative, insert without FKs and re-add them;
        // re-adding validates every reference.
        const fks = await transaction.unsafe<
          { table_name: string; name: string; definition: string }[]
        >(
          "SELECT c.conrelid::regclass::text AS table_name,c.conname AS name,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='agent_workflow' AND c.contype='f'",
        )
        if (seeds.some((seed) => seed.rows.length))
          for (const fk of fks)
            await transaction.unsafe(`ALTER TABLE ${fk.table_name} DROP CONSTRAINT ${q(fk.name)}`)
        for (const seed of seeds)
          for (const row of seed.rows) {
            const table = version.contract.tables.find((t) => t.id === row.table)
            invariant(table, `PG seed table missing from contract: ${row.table}`)
            if (table.disposition === 'ARCHIVE_THEN_OMIT') continue
            const sourceRow = db
              .query<
                Row,
                SQLQueryBindings[]
              >(`SELECT * FROM ${q(row.table)} WHERE ${table.migrationKey.map((name) => `${q(name)} IS ?`).join(' AND ')}`)
              .get(...table.migrationKey.map((name) => sqliteValue(row.values[name]!, home)))
            invariant(
              sourceRow,
              `PG seed source row missing: ${row.table}/${JSON.stringify(row.values)}`,
            )
            const codec = withLogicalCodecCorrections(table, corrections)
            const values = decodeLogicalRow(codec, encodeLogicalRow(codec, sourceRow))
            const names = Object.keys(values)
            await transaction.unsafe(
              `INSERT INTO agent_workflow.${q(table.providerTables.postgresql!)} (${names.map(q).join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')})`,
              names.map((name) => values[name]),
            )
          }
        if (seeds.some((seed) => seed.rows.length))
          for (const fk of fks)
            await transaction.unsafe(
              `ALTER TABLE ${fk.table_name} ADD CONSTRAINT ${q(fk.name)} ${fk.definition}`,
            )
        const previous = receipts[receipts.indexOf(receipt) - 1]!
        const advanced = await transaction.unsafe<Row[]>(
          "UPDATE agent_workflow_meta.database_generations SET contract_digest=$1 WHERE state='active' AND contract_digest=$2 RETURNING generation_id",
          [receipt.contractDigest, previous.contractDigest],
        )
        equal(
          advanced.map((row) => row.generation_id),
          ['dbg_rfc398_native_pg'],
          'released PG generation advances with its schema',
        )
        await transaction.unsafe(
          'INSERT INTO agent_workflow_meta.schema_migrations (baseline_id,contract_digest,plan_digest,applied_at) VALUES ($1,$2,$3,$4)',
          [receipt.baselineId, receipt.contractDigest, receipt.planDigest, NOW + position],
        )
      })
    }
    equal(position, release.epoch1.sqlite.length, 'PG release position')
    built.contract = (
      release.epoch1.postgresqlSource === 'released-baseline'
        ? baseline
        : history.postgresql.versions.find((v) => v.plan.digest === receipts.at(-1)!.planDigest)
    )!.contract
    const actual = await database.sql.unsafe<Row[]>(
      'SELECT baseline_id,contract_digest,plan_digest FROM agent_workflow_meta.schema_migrations ORDER BY applied_at,baseline_id',
    )
    equal(
      actual,
      receipts.map((r) => ({
        baseline_id: r.baselineId,
        contract_digest: r.contractDigest,
        plan_digest: r.planDigest,
      })),
      'PG receipt sequence',
    )
  } finally {
    db.close()
  }
}

async function installNative(built: BuiltRelease): Promise<void> {
  const epoch = built.release.epoch2!
  const history = persistenceHistory()
  const version = history.find((v) => v.contract.version === epoch.version)
  invariant(version, 'registered native history missing')
  equal(
    [version.contract.digest, version.sqlite.digest, version.postgresql.digest],
    [epoch.contractDigest, epoch.sqlitePlanDigest, epoch.postgresqlPlanDigest],
    'native registered artifacts',
  )
  const generationId = 'dbg_rfc398_native_epoch2'
  const db = built.provider === 'sqlite' ? new Database(built.sourcePath) : undefined
  const runtime = built.pg?.runtime(built.database!.database)
  try {
    await installHistoryHead(
      db ? sqliteHistorySession(db) : postgresqlHistorySession(runtime!.providerPool()),
      {
        version,
        generationId,
        installPath: 'test-baseline',
        metaTables: EPOCH2_META_TABLES,
        now: () => NOW,
      },
    )
    // The native installer supplies its required singleton rows. The historical seed
    // snapshot supplies their release-time values as well as all business history.
    if (db) {
      db.exec('PRAGMA foreign_keys=OFF')
      db.transaction(() => {
        for (const table of version.contract.contract.tables) db.exec(`DELETE FROM ${q(table.id)}`)
        for (const seed of built.seeds) insertSeed(db, seed, built.home)
      })()
      equal(db.query('PRAGMA foreign_key_check').all(), [], 'native SQLite FK check')
    } else {
      const pool = built.database!.sql
      await pool.begin(async (tx) => {
        const fks = await tx.unsafe<{ table_name: string; name: string; definition: string }[]>(
          "SELECT c.conrelid::regclass::text AS table_name,c.conname AS name,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='agent_workflow' AND c.contype='f'",
        )
        for (const fk of fks)
          await tx.unsafe(`ALTER TABLE ${fk.table_name} DROP CONSTRAINT ${q(fk.name)}`)
        for (const table of version.contract.contract.tables)
          await tx.unsafe(`DELETE FROM agent_workflow.${q(table.id)}`)
        for (const seed of built.seeds)
          for (const row of seed.rows) {
            const table = version.contract.contract.tables.find((t) => t.id === row.table)!
            const names = Object.keys(row.values)
            const values = names.map((name) => {
              const value = sqliteValue(row.values[name]!, built.home)
              const column = Object.values(table.columns).find((c) => c.name === name)!
              return column.codec === 'bool' && value !== null ? Boolean(value) : value
            })
            await tx.unsafe(
              `INSERT INTO agent_workflow.${q(row.table)} (${names.map(q).join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')})`,
              values,
            )
          }
        for (const fk of fks)
          await tx.unsafe(
            `ALTER TABLE ${fk.table_name} ADD CONSTRAINT ${q(fk.name)} ${fk.definition}`,
          )
        // Seeds carry explicit identity values. A real installation only ever generates them,
        // and any restore re-seats each sequence; do the same so the daemon's first default
        // identity (e.g. node_run_events.id) does not collide with seeded history.
        const identities = await tx.unsafe<{ table_name: string; column_name: string }[]>(
          "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='agent_workflow' AND (is_identity='YES' OR column_default LIKE 'nextval(%')",
        )
        for (const { table_name: table, column_name: column } of identities)
          await tx.unsafe(
            `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT max(${q(column)}) FROM agent_workflow.${q(table)}), 0) + 1, false)`,
            [`agent_workflow.${q(table)}`, column],
          )
      })
    }
    for (const seed of built.seeds) materializeSeedContent(seed, built.home)
    writeGenerationPointerV2({
      pointerPath: join(built.home, 'database-generation.json'),
      payload: {
        version: 2,
        schemaEpoch: 2,
        generationId,
        provider: built.provider,
        role: 'installed',
        database:
          built.provider === 'sqlite'
            ? { kind: 'sqlite-file', relativePath: 'db.sqlite' }
            : { kind: 'postgresql-target', profileRef: 'env:RFC398_URL' },
        contractDigest: version.contract.contract.digest,
        planDigest: version[built.provider].digest,
        operationId: null,
        manifestDigest: null,
        activatedAt: NOW,
        previous: null,
      },
    })
  } finally {
    db?.close()
  }
}

export async function buildReleaseHome(
  release: ReleaseEntry,
  variant: Variant,
): Promise<BuiltRelease> {
  const provider = variant === 'postgresql' ? 'postgresql' : 'sqlite'
  invariant(
    provider === 'sqlite' || release.epoch2 || release.epoch1?.postgresql,
    `${release.tag} has no PostgreSQL release`,
  )
  const pg = provider === 'postgresql' ? await rfc398Postgresql() : undefined
  const home = pg?.root ?? mkdtempSync(join(tmpdir(), 'aw-release-matrix-'))
  const built: BuiltRelease = {
    release,
    provider,
    home,
    pg,
    sourcePath: join(home, 'db.sqlite'),
    startedAt: Date.now(),
    seeds: releaseSeeds(release),
    before: new Map(),
    env: {
      ...process.env,
      AGENT_WORKFLOW_HOME: home,
      AW_DEPLOYMENT_MODE: 'standalone',
      AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS: '0',
      NO_COLOR: '1',
    },
    async snapshotTarget() {
      const pointer = readGenerationPointerV2(join(home, 'database-generation.json'))
      if (pointer.payload.database.kind === 'sqlite-file') {
        const target = new Database(join(home, pointer.payload.database.relativePath))
        try {
          return sqliteSnapshot(target)
        } finally {
          target.close()
        }
      }
      const ref = pointer.payload.database.profileRef
      invariant(ref.startsWith('env:RFC398_URL'), 'unexpected target reference')
      const name = ref.includes('/')
        ? decodeURIComponent(ref.slice(ref.indexOf('/') + 1))
        : built.database!.database
      return pgSnapshot(pg!.connect(name), { sqlitePhysical: true })
    },
    async close() {
      if (pg) {
        const root = join(home, 'database-migrations/auto-upgrade/allocations')
        if (existsSync(root)) {
          const { readdirSync } = await import('node:fs')
          for (const file of readdirSync(root).filter((f) => /^\d+\.json$/.test(f)))
            pg.databases.add(
              (JSON.parse(readFileSync(join(root, file), 'utf8')) as { database: string }).database,
            )
        }
        await pg.close()
      } else rmSync(home, { recursive: true, force: true })
    },
  }
  try {
    if (pg) {
      built.database = await pg.create()
      built.env.RFC398_URL = built.database.url
    }
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        autoEpochMigration: true,
        defaultRuntime: 'opencode',
        backupOnMigration: false,
        database: provider === 'postgresql' ? { provider, urlEnv: 'RFC398_URL' } : { provider },
      }),
    )
    if (release.epoch2) await installNative(built)
    else if (provider === 'sqlite') {
      const report = buildSeedDatabase(release, home, {
        exemptions: readApprovedExemptions(),
        beforeMigration: migrationExpectations,
      })
      equal(report.failures, [], 'release reconstruction')
      invariant(
        !existsSync(join(home, 'database-generation.json')),
        'epoch-1 SQLite must not have a pointer',
      )
    } else await loadPostgresqlBaseline(built)
    if (provider === 'sqlite') {
      const db = new Database(built.sourcePath)
      try {
        db.exec('PRAGMA journal_mode=WAL')
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        built.before = sqliteSnapshot(db)
      } finally {
        db.close()
      }
      if (variant === 'sqlite-no-sidecar') {
        rmSync(`${built.sourcePath}-wal`, { force: true })
        rmSync(`${built.sourcePath}-shm`, { force: true })
        equal([...readFileSync(built.sourcePath).subarray(18, 20)], [2, 2], 'WAL source header')
      }
    } else
      // Epoch-1 sources stay raw for the source checks' PostgreSQL text renderings; a native
      // epoch-2 database is compared with its own target, so both use the SQLite form.
      built.before = await pgSnapshot(built.database!.sql, { sqlitePhysical: !!release.epoch2 })
    assertBuildCoverage(release, built.before)
    return built
  } catch (error) {
    await built.close()
    throw error
  }
}

/** Independent SQL replay: no later seed rows and no converter calls. */
export async function buildExpectedCurrent(
  built: BuiltRelease,
): Promise<{ path: string; rows: Snapshot }> {
  invariant(built.release.epoch1, 'expected epoch-1 source')
  const path = join(built.home, 'expected-current.sqlite')
  const history = await loadFrozenEpoch1History()
  if (built.provider === 'sqlite') copyFileSync(built.sourcePath, path)
  const db = new Database(path)
  try {
    if (built.provider === 'postgresql') {
      createJournal(db)
      for (const receipt of built.release.epoch1.sqlite)
        applySqliteReceipt(db, migrationSql(built.release, receipt), receipt)
      const triggers = db
        .query<
          { sql: string; name: string },
          []
        >("SELECT name,sql FROM sqlite_schema WHERE type='trigger'")
        .all()
      db.exec('PRAGMA foreign_keys=OFF')
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${q(trigger.name)}`)
      for (const table of built.contract!.tables) {
        db.exec(`DELETE FROM ${q(table.sourceTable)}`)
        for (const row of built.before.get(table.id) ?? []) {
          const names = table.columns.map((c) => c.name)
          db.query(
            `INSERT INTO ${q(table.sourceTable)} (${names.map(q).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
          ).run(
            ...names.map((name) => {
              const value = row[name]
              return (typeof value === 'boolean' ? Number(value) : value) as SQLQueryBindings
            }),
          )
        }
      }
      for (const trigger of triggers) db.exec(trigger.sql)
    }
    for (let i = built.release.epoch1.sqlite.length; i < history.sqlite.length; i++) {
      const migration = history.sqlite[i]!
      const tag = history.sqliteTags[i]!
      // A seed file is mandatory even if this release must not receive its rows.
      const seed = readSeed(join(SEEDS, 'epoch1', `${tag}.json`), 1, tag)
      const checkEffect = migrationExpectations(db, seed)
      db.exec('PRAGMA foreign_keys=OFF')
      applySqliteReceipt(db, migration.sql.join('--> statement-breakpoint'), {
        tag,
        hash: migration.hash,
        created_at: migration.folderMillis,
      })
      checkEffect()
    }
    return { path, rows: sqliteSnapshot(db) }
  } finally {
    db.close()
  }
}
