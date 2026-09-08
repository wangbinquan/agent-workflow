// Hosted RFC-359 AC11 evidence. Workers run sequentially on one machine, using
// separate real databases and the original RFC-311 corpus. No daemon boot or
// recovery runs against the benchmark's running/pending tasks.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cpus, totalmem } from 'node:os'
import type { SQLQueryBindings } from 'bun:sqlite'
import { openDb } from '../packages/backend/src/db/client'
import { databaseSessionFor } from '../packages/backend/src/platform/persistence/databaseTransaction'
import { exportLogicalDatabaseArtifact } from '../packages/backend/src/platform/persistence/logicalDatabaseExport'
import { restoreLogicalDatabaseArtifact } from '../packages/backend/src/platform/persistence/logicalDatabaseRestore'
import { createPostgresqlDatabaseClient } from '../packages/backend/src/platform/persistence/postgresqlDatabaseClient'
import { openPostgresqlLogicalTarget } from '../packages/backend/src/platform/persistence/postgresqlLogicalTarget'
import { createPostgresqlDatabaseRuntime } from '../packages/backend/src/platform/persistence/postgresqlRuntime'
import { buildPostgresqlSchemaPlan } from '../packages/backend/src/platform/persistence/postgresqlSchema'
import { buildLogicalSchemaContract } from '../packages/backend/src/platform/persistence/schemaContract'
import { openSqliteLogicalSource } from '../packages/backend/src/platform/persistence/sqliteLogicalSource'
import { createProductionPerformanceApplication } from '../packages/backend/tests/helpers/productionPerformanceApplication'
import { measurePerformanceArchive, measurePerformanceHttp } from './perf-bench'
import { comparePerformanceReports, PERF_SOURCE_PATHS, type PerfHttpReport } from './perf-compare'
import {
  profilePerformanceQueries,
  profilePostgresqlQueries,
  profileSqliteQueries,
} from './perf-query-profile'
import {
  PERF_CORPUS_ENTRY,
  PERF_CORPUS_FULL_DIMENSIONS,
  PERF_CORPUS_SMALL_DIMENSIONS,
  type PerfCorpusDimensions,
} from './perf-corpus'
import {
  readPerformanceCorpusReceipt,
  seedPerformanceCorpus,
  seedPerformanceCorpusEntry,
} from './perf-seed'

const REPO = resolve(import.meta.dir, '..')
const MIGRATIONS = join(REPO, 'packages/backend/db/migrations')
const SOURCE_GENERATION = 'dbg_legacy_sqlite'
type Tier = PerfHttpReport['tier']

export function performanceDimensions(tier: Tier): PerfCorpusDimensions {
  if (tier === 'full') return PERF_CORPUS_FULL_DIMENSIONS
  if (tier === 'small') return PERF_CORPUS_SMALL_DIMENSIONS
  return { tasks: 10_000, runsPerTask: 30, events: 1_000_000, deliveries: 10_000, repos: 50 }
}

interface RunInput {
  readonly output: string
  readonly directory: string
  readonly tier: Tier
  readonly sourceSha: string
}

interface TemplateReceipt {
  readonly generationId: string
  readonly operationId: string
  readonly templateDigest: string
  readonly schemaDigest: string
  readonly exported: Awaited<ReturnType<typeof exportLogicalDatabaseArtifact>>
}

function json(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function templateReceipt(input: RunInput): TemplateReceipt {
  return JSON.parse(readFileSync(join(input.output, 'template.json'), 'utf8')) as TemplateReceipt
}

async function runProcess(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: REPO,
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`performance worker exited ${code}: ${args[0]}`)
}

// A late native close failure must not erase the original failed endpoint or load.
export async function withPerformanceCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await operation() }
  } catch (error) {
    outcome = { ok: false, error }
  }
  try {
    await cleanup()
  } catch (cleanupError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        'performance operation and cleanup both failed',
      )
    }
    throw cleanupError
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

async function prepareTemplate(input: RunInput): Promise<void> {
  const path = join(input.directory, 'template.db')
  const db = openDb({ path, migrationsFolder: MIGRATIONS })
  await withPerformanceCleanup(
    async () => {
      await seedPerformanceCorpusEntry({ db, session: databaseSessionFor(db) })
      db.$client.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    },
    () => {
      db.$client.close()
    },
  )
  // Workflow's original database-generated timestamps are stored once. The
  // SQLite file copy and the real logical restore therefore share those bytes.
  const templateDigest = createHash('sha256').update(readFileSync(path)).digest('hex')
  const contract = buildLogicalSchemaContract()
  const source = openSqliteLogicalSource({ path, contract })
  await withPerformanceCleanup(
    async () => {
      const snapshot = await source.preflight()
      const exported = await exportLogicalDatabaseArtifact({
        operationId: `dbm_perf_export_${randomUUID().replaceAll('-', '')}`,
        sourceProvider: 'sqlite',
        sourceGenerationId: SOURCE_GENERATION,
        source: {
          provider: 'sqlite',
          assertUnchanged: () => source.assertUnchanged(snapshot),
          readChunk: (table, key, limit) => source.readChunk(table, key, limit),
        },
        expectedTableRows: snapshot.tableRows,
        contract,
        artifactRoot: join(input.directory, 'logical-template'),
      })
      json(join(input.output, 'template.json'), {
        generationId: `dbg_perf_${randomUUID().replaceAll('-', '')}`,
        operationId: `dbm_perf_restore_${randomUUID().replaceAll('-', '')}`,
        schemaDigest: contract.digest,
        templateDigest,
        exported,
      } satisfies TemplateReceipt)
    },
    () => {
      return source.close()
    },
  )
}

function postgresqlRuntime(receipt: TemplateReceipt) {
  return createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC359_PERFORMANCE_DATABASE_URL',
      poolMax: 16,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    },
    generationId: receipt.generationId,
  })
}

async function seedSqlite(input: RunInput): Promise<void> {
  const dimensions = performanceDimensions(input.tier)
  const path = join(input.directory, 'sqlite.db')
  copyFileSync(join(input.directory, 'template.db'), path)
  // Keep the original native prepared-statement CLI for the full SQLite load.
  await runProcess([
    'scripts/perf-seed.ts',
    '--db',
    path,
    '--tasks',
    String(dimensions.tasks),
    '--runs-per-task',
    String(dimensions.runsPerTask),
    '--events',
    String(dimensions.events),
    '--deliveries',
    String(dimensions.deliveries),
    '--repos',
    String(dimensions.repos),
  ])
  const db = openDb({ path, migrationsFolder: MIGRATIONS })
  await withPerformanceCleanup(
    async () => {
      const receipt = await readPerformanceCorpusReceipt(db, dimensions)
      json(join(input.output, 'sqlite-seed.json'), receipt)
      if (!receipt.matchesExpected) throw new Error('SQLite differs from original RFC-311 corpus')
      db.$client.exec('ANALYZE')
    },
    () => {
      db.$client.close()
    },
  )
}

async function seedPostgresql(input: RunInput): Promise<void> {
  const receipt = templateReceipt(input)
  const contract = buildLogicalSchemaContract()
  if (contract.digest !== receipt.schemaDigest) throw new Error('template schema changed')
  const runtime = postgresqlRuntime(receipt)
  await withPerformanceCleanup(
    async () => {
      const target = await openPostgresqlLogicalTarget({
        runtime,
        operationId: receipt.operationId,
        sourceGenerationId: SOURCE_GENERATION,
        contract,
        plan: buildPostgresqlSchemaPlan(contract),
      })
      await withPerformanceCleanup(
        async () => {
          const restored = await restoreLogicalDatabaseArtifact({
            artifactRoot: join(input.directory, 'logical-template'),
            expectedManifestDigest: receipt.exported.manifest.digest,
            expectedLegacyArchiveFileDigest: receipt.exported.legacyArchiveFileDigest,
            restoreOperationId: receipt.operationId,
            contract,
            target,
            envelope: receipt.exported.envelope,
          })
          await target.prepareGeneration({
            generationId: receipt.generationId,
            sourceGenerationId: SOURCE_GENERATION,
          })
          await target.activateGeneration(receipt.generationId, Date.now())
          await target.assertReady(receipt.generationId)
          json(join(input.output, 'postgresql-template-restore.json'), restored)
        },
        () => target.close(),
      )
      const db = createPostgresqlDatabaseClient(runtime)
      const seeded = await seedPerformanceCorpus({
        db,
        session: databaseSessionFor(db),
        dimensions: performanceDimensions(input.tier),
        onProgress: (progress) => {
          console.log('[perf-run] PostgreSQL load', progress)
        },
      })
      json(join(input.output, 'postgresql-seed.json'), seeded)
      if (!seeded.matchesExpected)
        throw new Error('PostgreSQL differs from original RFC-311 corpus')
      await runtime.providerPool().unsafe('ANALYZE')
    },
    () => {
      return runtime.close()
    },
  )
}

async function withDatabase(
  input: RunInput,
  provider: PerfHttpReport['provider'],
  phase: 'http' | 'profile' | 'archive',
): Promise<void> {
  const template = templateReceipt(input)
  const runtime = provider === 'postgresql' ? postgresqlRuntime(template) : null
  const sqlite =
    runtime === null
      ? openDb({ path: join(input.directory, 'sqlite.db'), migrationsFolder: MIGRATIONS })
      : null
  const pgProfile =
    phase === 'profile' && runtime !== null ? profilePostgresqlQueries(runtime) : null
  const sqliteProfile =
    phase === 'profile' && sqlite !== null ? profileSqliteQueries(sqlite.$client) : null
  const db =
    runtime === null ? sqlite! : createPostgresqlDatabaseClient(pgProfile?.runtime ?? runtime)
  await withPerformanceCleanup(
    async () => {
      if (phase === 'profile') {
        // Reading the comparison is an ordering precondition: these extra
        // requests and EXPLAINs cannot run before either original measurement.
        const comparison = JSON.parse(
          readFileSync(join(input.output, 'comparison.json'), 'utf8'),
        ) as { comparable: boolean }
        if (!comparison.comparable) throw new Error('cannot profile incomparable HTTP reports')
        const report = JSON.parse(
          readFileSync(join(input.output, `${provider}-http.json`), 'utf8'),
        ) as PerfHttpReport
        if (report.sourceSha !== input.sourceSha || report.executionId !== template.operationId)
          throw new Error('profile does not match measured source and execution')
        const appHome = join(input.directory, `${provider}-profile-home`)
        mkdirSync(appHome, { recursive: true })
        process.env.AGENT_WORKFLOW_HOME = appHome
        const app = await createProductionPerformanceApplication({
          db,
          appHome,
          configPath: join(appHome, 'config.json'),
          daemonToken: PERF_CORPUS_ENTRY.bearerToken,
        })
        const profile = await profilePerformanceQueries({
          app,
          token: PERF_CORPUS_ENTRY.bearerToken,
          report,
          capture: (pgProfile ?? sqliteProfile)!.capture,
          explain: async (statement) => {
            if (sqlite !== null)
              return sqlite.$client
                .query(`EXPLAIN QUERY PLAN ${statement.sql}`)
                .all(...(statement.parameters as SQLQueryBindings[]))
            const connection = await runtime!.providerPool().reserve()
            return await withPerformanceCleanup(
              async () => {
                await connection.unsafe('BEGIN READ ONLY')
                return await connection.unsafe(
                  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`,
                  statement.parameters,
                )
              },
              async () => {
                try {
                  await connection.unsafe('ROLLBACK')
                } finally {
                  connection.release()
                }
              },
            )
          },
        })
        const corpusAfter = await readPerformanceCorpusReceipt(
          db,
          performanceDimensions(input.tier),
        )
        const unchangedFromHttp = JSON.stringify(corpusAfter) === JSON.stringify(report.seedAfter)
        writeFileSync(
          join(input.output, `${provider}-query-profile.json`),
          `${JSON.stringify(
            {
              ...profile,
              profileSourceDigest: createHash('sha256')
                .update(readFileSync(join(REPO, 'scripts/perf-query-profile.ts')))
                .digest('hex'),
              corpusAfter,
              unchangedFromHttp,
            },
            (_key, value: unknown) =>
              typeof value === 'bigint' ? { bigint: String(value) } : value,
            2,
          )}\n`,
        )
        if (!profile.complete || !unchangedFromHttp)
          throw new Error(`${provider} query profile incomplete or changed the measured corpus`)
        return
      }
      if (phase === 'archive') {
        const result = await measurePerformanceArchive(
          db,
          join(input.directory, `${provider}-archive`),
        )
        json(join(input.output, `${provider}-archive.json`), {
          ...result,
          phase: 'after-all-http-samples',
          corpusAfter: await readPerformanceCorpusReceipt(db, performanceDimensions(input.tier)),
        })
        return
      }
      const sourceDigests = Object.fromEntries(
        PERF_SOURCE_PATHS.map((path) => [
          path,
          createHash('sha256')
            .update(readFileSync(join(REPO, path)))
            .digest('hex'),
        ]),
      )
      const appHome = join(input.directory, `${provider}-home`)
      mkdirSync(appHome, { recursive: true })
      process.env.AGENT_WORKFLOW_HOME = appHome
      const seedBefore = await readPerformanceCorpusReceipt(db, performanceDimensions(input.tier))
      let report: PerfHttpReport = {
        version: 1,
        provider,
        sourceSha: input.sourceSha,
        executionId: template.operationId,
        machine: {
          platform: process.platform,
          arch: process.arch,
          bunVersion: Bun.version,
          cpuModel: cpus()[0]?.model ?? 'unknown',
          logicalCpus: cpus().length,
          totalMemory: totalmem(),
        },
        sourceDigests,
        schemaDigest: template.schemaDigest,
        templateDigest: template.templateDigest,
        tier: input.tier,
        transport: 'hono-app-request',
        rounds: 20,
        warmups: 1,
        seedBefore,
        seedAfter: null,
        scenarios: [],
        complete: false,
      }
      const reportPath = join(input.output, `${provider}-http.json`)
      json(reportPath, report)
      if (!seedBefore.matchesExpected)
        throw new Error(`${provider} corpus changed before HTTP timing`)
      const app = await createProductionPerformanceApplication({
        db,
        appHome,
        configPath: join(appHome, 'config.json'),
        daemonToken: PERF_CORPUS_ENTRY.bearerToken,
      })
      await measurePerformanceHttp({
        app,
        token: PERF_CORPUS_ENTRY.bearerToken,
        rounds: 20,
        onScenario: (result) => {
          report = { ...report, scenarios: [...report.scenarios, result] }
          json(reportPath, report)
          console.log(`[perf-run] ${provider} ${result.id} P95=${result.p95}ms`, result.samples)
        },
      })
      report = {
        ...report,
        seedAfter: await readPerformanceCorpusReceipt(db, performanceDimensions(input.tier)),
        complete: true,
      }
      json(reportPath, report)
    },
    async () => {
      sqliteProfile?.stop()
      if (runtime !== null) await runtime.close()
      sqlite?.$client.close()
    },
  )
}

async function run(input: RunInput, stage: string | undefined): Promise<void> {
  if (stage === 'template') return await prepareTemplate(input)
  if (stage === 'seed-sqlite') return await seedSqlite(input)
  if (stage === 'seed-postgresql') return await seedPostgresql(input)
  if (stage === 'http-sqlite') return await withDatabase(input, 'sqlite', 'http')
  if (stage === 'http-postgresql') return await withDatabase(input, 'postgresql', 'http')
  if (stage === 'profile-sqlite') return await withDatabase(input, 'sqlite', 'profile')
  if (stage === 'profile-postgresql') return await withDatabase(input, 'postgresql', 'profile')
  if (stage === 'archive-sqlite') return await withDatabase(input, 'sqlite', 'archive')
  if (stage === 'archive-postgresql') return await withDatabase(input, 'postgresql', 'archive')
  if (stage !== undefined) throw new Error(`unknown performance worker stage: ${stage}`)
  const child = async (workerStage: string) => {
    await runProcess([
      'scripts/perf-run.ts',
      '--output',
      input.output,
      '--directory',
      input.directory,
      '--scale',
      input.tier,
      '--sha',
      input.sourceSha,
      '--stage',
      workerStage,
    ])
  }
  for (const workerStage of [
    'template',
    'seed-sqlite',
    'seed-postgresql',
    'http-sqlite',
    'http-postgresql',
  ])
    await child(workerStage)
  const comparison = comparePerformanceReports(
    JSON.parse(readFileSync(join(input.output, 'sqlite-http.json'), 'utf8')) as PerfHttpReport,
    JSON.parse(readFileSync(join(input.output, 'postgresql-http.json'), 'utf8')) as PerfHttpReport,
  )
  json(join(input.output, 'comparison.json'), comparison)
  console.log('[perf-run] comparison', comparison)
  let profileFailed = false
  if (comparison.comparable) {
    for (const workerStage of ['profile-sqlite', 'profile-postgresql']) {
      try {
        await child(workerStage)
      } catch (error) {
        profileFailed = true
        console.error(`[perf-run] ${workerStage} failed`, error)
      }
    }
  }
  // Preserve both complete HTTP receipts before either database is archived.
  for (const workerStage of ['archive-sqlite', 'archive-postgresql']) await child(workerStage)
  if (
    profileFailed ||
    !(input.tier === 'full' ? comparison.acceptancePassed : comparison.comparable)
  )
    process.exitCode = 1
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`)
    return index < 0 ? undefined : args[index + 1]
  }
  const tier = flag('scale') ?? 'small'
  if (tier !== 'small' && tier !== 'weekly' && tier !== 'full')
    throw new Error('scale must be small, weekly or full')
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO,
    encoding: 'utf8',
  }).trim()
  if (flag('sha') !== undefined && flag('sha') !== sourceSha)
    throw new Error('requested SHA is not the checked-out commit')
  const output = resolve(flag('output') ?? 'test-results/rfc359-http-performance')
  mkdirSync(output, { recursive: true })
  const directory = flag('directory') ?? mkdtempSync(join(output, 'databases-'))
  await run({ output, directory, tier, sourceSha }, flag('stage'))
}
