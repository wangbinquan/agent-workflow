// RFC-629: concurrent isolated-database runner for `ci-work.yml:test-backend-postgresql`.
// Zero third-party dependencies: runs directly under Bun using `Bun.SQL`, `node:*`, and `./backend-shards`.
//
// Each concurrent worker slot receives its own ephemeral PostgreSQL database (`aw_pg_gate_<pid>_<slot>`)
// so suites that connect directly to `AW_TEST_POSTGRESQL_URL` / `RFC357_DATABASE_URL` and execute
// `DROP SCHEMA public CASCADE` never race each other, while `describeEachProvider` suites still share
// one cluster-wide template database keyed without URL pathname.
import { SQL } from 'bun'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { TEST_BACKEND_POSTGRESQL_FILES } from './backend-shards'

const SLOT_DB_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const SKIPPED_REAL_POSTGRESQL_PATTERN = /\(skip\).*real PostgreSQL/

export interface RunPostgresqlGateArgs {
  concurrency: number
  logOut?: string
}

export interface PostgresqlGateFileResult {
  file: string
  slot: number
  exitCode: number
  durationMs: number
  output: string
}

export interface RunPostgresqlGateOptions {
  files?: readonly string[]
  baseUrl: string
  concurrency: number
  repoRoot: string
  baseEnv?: Record<string, string | undefined>
  logOut?: string
  provisionSlot?: (baseUrl: string, databaseName: string) => Promise<void>
  cleanupSlot?: (baseUrl: string, databaseName: string) => Promise<void>
  runFile?: (
    file: string,
    env: Record<string, string | undefined>,
    repoRoot: string,
  ) => Promise<{ exitCode: number; output: string }>
}

export function parseRunPostgresqlGateArgs(args: readonly string[]): RunPostgresqlGateArgs {
  let concurrency = 3
  let logOut: string | undefined

  const parseConcurrency = (raw: string | undefined): number => {
    if (raw === undefined || !/^[1-8]$/.test(raw)) {
      throw new Error(`Invalid --concurrency value '${raw ?? '(missing)'}': expected integer 1..8`)
    }
    return Number(raw)
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--concurrency') {
      concurrency = parseConcurrency(args[++index])
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = parseConcurrency(arg.slice('--concurrency='.length))
    } else if (arg === '--log-out') {
      const value = args[++index]
      if (!value) throw new Error('Missing --log-out path')
      logOut = value
    } else if (arg.startsWith('--log-out=')) {
      const value = arg.slice('--log-out='.length)
      if (!value) throw new Error('Missing --log-out path')
      logOut = value
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { concurrency, logOut }
}

export function rewritePostgresqlDatabaseUrl(baseUrl: string, databaseName: string): string {
  if (!SLOT_DB_NAME_PATTERN.test(databaseName)) {
    throw new Error(`Invalid PostgreSQL slot database name: ${databaseName}`)
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`Invalid PostgreSQL URL: ${baseUrl}`)
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`Unsupported PostgreSQL URL protocol: ${parsed.protocol}`)
  }
  parsed.pathname = `/${databaseName}`
  return parsed.toString()
}

export function buildPostgresqlSlotEnv(
  baseEnv: Record<string, string | undefined>,
  slotUrl: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    AW_TEST_POSTGRESQL_URL: slotUrl,
    RFC357_DATABASE_URL: slotUrl,
  }
  if (baseEnv.RFC359_DATABASE_URL !== undefined) {
    env.RFC359_DATABASE_URL = slotUrl
  }
  return env
}

export function assertNoSkippedRealPostgresql(combinedOutput: string): void {
  if (SKIPPED_REAL_POSTGRESQL_PATTERN.test(combinedOutput)) {
    throw new Error('At least one real PostgreSQL parity test was skipped; refusing silent green.')
  }
}

async function defaultProvisionSlot(baseUrl: string, databaseName: string): Promise<void> {
  if (!SLOT_DB_NAME_PATTERN.test(databaseName)) {
    throw new Error(`Invalid PostgreSQL slot database name: ${databaseName}`)
  }
  const admin = new SQL(baseUrl)
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await admin.close()
  }
}

async function defaultCleanupSlot(baseUrl: string, databaseName: string): Promise<void> {
  if (!SLOT_DB_NAME_PATTERN.test(databaseName)) {
    throw new Error(`Invalid PostgreSQL slot database name: ${databaseName}`)
  }
  const admin = new SQL(baseUrl)
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${databaseName} AND pid <> pg_backend_pid()`
    for (let attempt = 0; attempt < 15; attempt++) {
      const remaining =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${databaseName} AND pid <> pg_backend_pid()`
      if (Number(remaining[0]?.n ?? 0) === 0) break
      await Bun.sleep(50)
    }
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`)
  } finally {
    await admin.close()
  }
}

async function defaultRunFile(
  file: string,
  env: Record<string, string | undefined>,
  repoRoot: string,
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bun', 'test', '--isolate', file], {
    cwd: repoRoot,
    env: env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const output = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout
  return { exitCode, output }
}

export async function runPostgresqlGate(
  options: RunPostgresqlGateOptions,
): Promise<{ results: PostgresqlGateFileResult[]; combinedOutput: string; failedFiles: string[] }> {
  const files = options.files ?? TEST_BACKEND_POSTGRESQL_FILES
  if (files.length === 0) {
    throw new Error('TEST_BACKEND_POSTGRESQL_FILES must not be empty')
  }
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 8
  ) {
    throw new Error(`Invalid concurrency: ${options.concurrency}`)
  }
  const slotCount = Math.min(options.concurrency, files.length)
  const provisionSlot = options.provisionSlot ?? defaultProvisionSlot
  const cleanupSlot = options.cleanupSlot ?? defaultCleanupSlot
  const runFile = options.runFile ?? defaultRunFile
  const baseEnv = options.baseEnv ?? process.env

  const createdSlots: { slot: number; dbName: string; url: string }[] = []
  const orderedResults: (PostgresqlGateFileResult | undefined)[] = Array.from(
    { length: files.length },
    () => undefined,
  )
  let runError: unknown = null

  const cleanupErrors: Error[] = []
  try {
    for (let slot = 0; slot < slotCount; slot++) {
      const dbName = `aw_pg_gate_${process.pid}_${slot}`
      const url = rewritePostgresqlDatabaseUrl(options.baseUrl, dbName)
      await provisionSlot(options.baseUrl, dbName)
      createdSlots.push({ slot, dbName, url })
    }

    let nextIndex = 0
    const runWorker = async (slotInfo: { slot: number; dbName: string; url: string }) => {
      const slotEnv = buildPostgresqlSlotEnv(baseEnv, slotInfo.url)
      while (true) {
        const index = nextIndex++
        if (index >= files.length) return
        const file = files[index]!
        const startedAt = Date.now()
        const { exitCode, output } = await runFile(file, slotEnv, options.repoRoot)
        orderedResults[index] = {
          file,
          slot: slotInfo.slot,
          exitCode,
          durationMs: Date.now() - startedAt,
          output,
        }
      }
    }

    await Promise.all(createdSlots.map((slotInfo) => runWorker(slotInfo)))
  } catch (error) {
    runError = error
  } finally {
    for (const slotInfo of createdSlots) {
      try {
        await cleanupSlot(options.baseUrl, slotInfo.dbName)
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
  if (runError !== null) {
    throw runError
  }
  if (cleanupErrors.length > 0) {
    throw new Error(
      `Failed to clean up ${cleanupErrors.length} PostgreSQL gate slot database(s): ${cleanupErrors.map((err) => err.message).join('; ')}`,
    )
  }

  const results = orderedResults.map((entry, index) => {
    if (!entry) throw new Error(`Missing execution result for ${files[index]}`)
    return entry
  })

  const combinedOutput = results
    .map(
      (entry) =>
        `=== [slot ${entry.slot}] ${entry.file} (exit=${entry.exitCode}, ${entry.durationMs}ms) ===\n${entry.output.trimEnd()}\n`,
    )
    .join('\n')

  if (options.logOut) {
    const destination = resolve(options.logOut)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, combinedOutput, 'utf8')
  }

  const failedFiles = results.filter((entry) => entry.exitCode !== 0).map((entry) => entry.file)
  return { results, combinedOutput, failedFiles }
}

if (import.meta.main) {
  const { concurrency, logOut } = parseRunPostgresqlGateArgs(process.argv.slice(2))
  const baseUrl = process.env.AW_TEST_POSTGRESQL_URL ?? process.env.RFC357_DATABASE_URL
  if (!baseUrl) {
    console.error('AW_TEST_POSTGRESQL_URL or RFC357_DATABASE_URL is required')
    process.exit(1)
  }
  const repoRoot = resolve(import.meta.dir, '../..')
  const startedAt = Date.now()
  console.log(
    `Running ${TEST_BACKEND_POSTGRESQL_FILES.length} real PostgreSQL gate files across ${concurrency} isolated slot database(s)...`,
  )
  const { results, combinedOutput, failedFiles } = await runPostgresqlGate({
    files: TEST_BACKEND_POSTGRESQL_FILES,
    baseUrl,
    concurrency,
    repoRoot,
    logOut,
  })
  process.stdout.write(combinedOutput)
  const totalMs = Date.now() - startedAt
  console.log(
    `PostgreSQL gate completed ${results.length} files in ${(totalMs / 1000).toFixed(1)}s (failed=${failedFiles.length}).`,
  )
  if (failedFiles.length > 0) {
    console.error(`Failed PostgreSQL gate files:\n- ${failedFiles.join('\n- ')}`)
    process.exit(1)
  }
  assertNoSkippedRealPostgresql(combinedOutput)
}
