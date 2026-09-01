// RFC-349 T10-C — real-process crash/resume worker for the hosted PostgreSQL
// evidence gate. The parent kills this process only after the worker has
// reached an exact durable checkpoint. Restarting the same fixture against the
// same operation files and external target exercises production replay rather
// than an in-process mock exception.

import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import {
  createDatabaseMigrationControlPlane,
  type DatabaseMigrationControlPlane,
} from '@/modules/system-operations/application/databaseMigrationControlPlane'
import { createDatabaseMigrationRunner } from '@/modules/system-operations/application/databaseMigrationRunner'
import { createFileDatabaseMigrationArtifactStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationArtifactStore'
import { createFileDatabaseMigrationStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'
import { createSqliteMigrationSafetyBackup } from '@/modules/system-operations/infrastructure/sqliteMigrationSafetyBackup'
import type { DatabaseMigrationPhase } from '@/modules/system-operations/domain/databaseMigration'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import {
  openPostgresqlLogicalTarget,
  type PostgresqlLogicalTarget,
} from '@/platform/persistence/postgresqlLogicalTarget'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'

const MIGRATIONS = resolve(import.meta.dir, '..', '..', 'db', 'migrations')
const OPERATION_ID = 'dbm_hosted_crash_matrix'
const SOURCE_GENERATION_ID = 'dbg_hosted_crash_source'

interface WorkerInput {
  readonly root: string
  readonly url: string
  readonly crashPoint: string | null
  readonly sentinelPath: string
  readonly resultPath: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

function workerInput(): WorkerInput {
  return {
    root: resolve(requiredEnv('RFC349_CRASH_ROOT')),
    url: requiredEnv('RFC349_DATABASE_URL'),
    crashPoint: process.env.RFC349_CRASH_POINT?.trim() || null,
    sentinelPath: resolve(requiredEnv('RFC349_CRASH_SENTINEL')),
    resultPath: resolve(requiredEnv('RFC349_CRASH_RESULT')),
  }
}

function holdAt(input: WorkerInput, point: string): never {
  mkdirSync(resolve(input.sentinelPath, '..'), { recursive: true })
  writeFileSync(
    input.sentinelPath,
    `${JSON.stringify({ point, pid: process.pid, at: Date.now() })}\n`,
    'utf8',
  )
  // This is deliberately synchronous: no event-loop callback can advance the
  // operation after the parent observes the sentinel and before SIGKILL.
  const latch = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.wait(latch, 0, 0)
  throw new Error('unreachable crash latch returned')
}

function maybeHold(input: WorkerInput, point: string): void {
  if (input.crashPoint === point) holdAt(input, point)
}

function ensureSource(path: string): void {
  if (existsSync(path)) return
  mkdirSync(resolve(path, '..'), { recursive: true })
  const drizzle = createInMemoryDb(MIGRATIONS)
  const sqlite = (drizzle as unknown as { $client: Database }).$client
  try {
    sqlite.exec(
      "INSERT INTO users (id, username, display_name, role, status, force_password_change, created_at, updated_at, schema_version, access_revision, git_name) VALUES ('usr-hosted-crash', 'hosted-crash', 'Hosted Crash', 'admin', 'active', 0, 9007199254740993, 9007199254740993, 1, 0, '')",
    )
    sqlite.exec(
      "INSERT INTO code_artifacts (id, repo_path, commit_sha, base_sha, digest, keep_ref, generation, ref_count, state, created_at) VALUES ('legacy-hosted-crash', '/tmp/hosted', 'abc', 'def', 'sha256:hosted', 'refs/keep/hosted', 1, 0, 'live', 123)",
    )
    writeFileSync(path, sqlite.serialize())
  } finally {
    sqlite.close()
  }
}

function crashAwareControlPlane(
  input: WorkerInput,
  delegate: DatabaseMigrationControlPlane,
): DatabaseMigrationControlPlane {
  const controlPlane: DatabaseMigrationControlPlane = {
    start: delegate.start,
    get: delegate.get,
    list: delegate.list,
    advance(operationId, transition) {
      maybeHold(input, `before:${transition.nextPhase}`)
      const status = delegate.advance(operationId, transition)
      maybeHold(input, `after:${transition.nextPhase}`)
      return status
    },
    checkpoint: delegate.checkpoint,
    fail: delegate.fail,
    resume: delegate.resume,
    requestCancel: delegate.requestCancel,
    settleCancelled: delegate.settleCancelled,
    markFirstLiveWrite: delegate.markFirstLiveWrite,
    markRolledBack: delegate.markRolledBack,
    readManifest: delegate.readManifest,
  }
  return Object.freeze(controlPlane)
}

function crashAwareTarget(
  input: WorkerInput,
  delegate: PostgresqlLogicalTarget,
): PostgresqlLogicalTarget {
  let chunkObserved = false
  return Object.freeze({
    provider: 'postgresql' as const,
    operationId: delegate.operationId,
    prepare: delegate.prepare,
    async copyChunk(
      table: Parameters<PostgresqlLogicalTarget['copyChunk']>[0],
      chunk: Parameters<PostgresqlLogicalTarget['copyChunk']>[1],
      now: Parameters<PostgresqlLogicalTarget['copyChunk']>[2],
    ) {
      if (!chunkObserved) maybeHold(input, 'before:copy-chunk')
      await delegate.copyChunk(table, chunk, now)
      if (!chunkObserved) {
        chunkObserved = true
        maybeHold(input, 'after:copy-chunk')
      }
    },
    finalizeSchema: delegate.finalizeSchema,
    prepareGeneration: delegate.prepareGeneration,
    activateGeneration: delegate.activateGeneration,
    assertReady: delegate.assertReady,
    firstLiveWriteAt: delegate.firstLiveWriteAt,
    retireGenerationIfUnwritten: delegate.retireGenerationIfUnwritten,
    markFinalized: delegate.markFinalized,
    close: delegate.close,
  })
}

async function main(): Promise<void> {
  const input = workerInput()
  const sourcePath = join(input.root, 'db.sqlite')
  const operationsRoot = join(input.root, 'database-migrations')
  const pointerPath = join(input.root, 'database-generation.json')
  ensureSource(sourcePath)

  const contract = buildLogicalSchemaContract()
  const source = openSqliteLogicalSource({ path: sourcePath, contract })
  const sourceSnapshot = await source.preflight()
  const store = createFileDatabaseMigrationStore({
    root: operationsRoot,
    beforeReplaceForTest(operationId, revision) {
      if (operationId === OPERATION_ID && revision === 0) maybeHold(input, 'before:planned')
    },
    afterReplaceForTest(operationId, revision) {
      if (operationId === OPERATION_ID && revision === 0) maybeHold(input, 'after:planned')
    },
  })
  const baseControlPlane = createDatabaseMigrationControlPlane({
    store,
    newOperationId: () => OPERATION_ID,
    newOwnerId: () => 'dbo_hosted_crash_owner',
  })
  if (baseControlPlane.list().length === 0) {
    baseControlPlane.start({
      idempotencyKey: 'hosted-crash-matrix',
      sourceGenerationId: SOURCE_GENERATION_ID,
      sourceSchemaDigest: contract.digest,
      sourceDatabaseFingerprint: sourceSnapshot.databaseFingerprint,
      target: {
        provider: 'postgresql',
        urlEnv: 'RFC349_DATABASE_URL',
        poolMax: 4,
        connectTimeoutMs: 10_000,
        statementTimeoutMs: 120_000,
        idleTimeoutMs: 60_000,
      },
      tableCounts: {
        source: contract.tables.length,
        active: contract.activeTableCount,
        archiveOnly: contract.archiveOnlyTableCount,
      },
      ownerLeaseMs: 300_000,
      now: Date.now(),
    })
  }

  const controlPlane = crashAwareControlPlane(input, baseControlPlane)
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC349_DATABASE_URL',
      poolMax: 4,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 120_000,
      idleTimeoutMs: 60_000,
    },
    generationId: 'dbg_hosted_crash_target',
    env: { RFC349_DATABASE_URL: input.url },
  })
  const target = crashAwareTarget(
    input,
    await openPostgresqlLogicalTarget({
      runtime,
      operationId: OPERATION_ID,
      sourceGenerationId: SOURCE_GENERATION_ID,
      contract,
      plan: buildPostgresqlSchemaPlan(contract),
    }),
  )
  try {
    const runner = createDatabaseMigrationRunner({
      controlPlane,
      source,
      sourceSnapshot,
      target,
      targetRuntime: runtime,
      contract,
      admission: {
        freezeAndDrain: async () => undefined,
        reopenSqlite: async () => undefined,
        activatePostgresql: async () => undefined,
        openPostgresqlAdmission: async () => undefined,
      },
      safetyBackup: createSqliteMigrationSafetyBackup(),
      artifacts: createFileDatabaseMigrationArtifactStore({ operationsRoot }),
      generationPointerPath: pointerPath,
      chunkRows: 25,
    })
    const accepting = await runner.run(OPERATION_ID)
    if (accepting.phase !== 'accepting-writes' && accepting.phase !== 'finalized') {
      throw new Error(`unexpected resumed phase: ${accepting.phase}`)
    }
    const finalized = await runner.finalize(OPERATION_ID)
    if (finalized.phase !== 'finalized') {
      throw new Error(`crash worker did not finalize: ${finalized.phase}`)
    }
    const userRows = await runtime
      .providerPool()
      .unsafe('SELECT id FROM agent_workflow.users WHERE id = $1', ['usr-hosted-crash'])
    const archiveRows = await runtime
      .providerPool()
      .unsafe(
        "SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = 'agent_workflow' AND table_name = 'code_artifacts'",
      )
    const result = {
      operationId: OPERATION_ID,
      phase: finalized.phase as DatabaseMigrationPhase,
      tablesCompleted: finalized.progress.tablesCompleted,
      rowsCopied: finalized.progress.rowsCopied,
      userPresent: userRows.length === 1,
      archiveTableAbsent: String(archiveRows[0]?.count ?? '') === '0',
      manifestRevision: finalized.revision,
    }
    writeFileSync(input.resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  } finally {
    await target.close().catch(() => undefined)
    await source.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
  }
}

await main()
