// RFC-349 T10-D — hosted evidence harness for a real external PostgreSQL
// server. It drives the separately compiled daemon, a full RFC-311 SQLite
// source, the public migration/status surfaces and PostgreSQL maintenance. The
// report is deliberately machine-readable: a local mock or installed server
// cannot be substituted for the scheduled hosted workflow.

import { SQL } from 'bun'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  databaseMigrationPreflightViewSchema,
  databaseMigrationStatusViewSchema,
  databaseRuntimeOverviewSchema,
  MaintenanceStatusSchema,
  type DatabaseMigrationStatusView,
  type DatabaseRuntimeOverview,
  type MaintenanceJobKey,
  type MaintenanceStatus,
} from '@agent-workflow/shared'

import {
  HEAVY_MAINTENANCE_JOB_KEYS,
  maintenanceJobSpec,
} from '@/platform/background/maintenanceCatalog'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlMaintenanceRunStore } from '@/platform/persistence/postgresqlMaintenanceRunStore'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { timeoutSignal } from '@/util/timeoutSignal'

import {
  defaultBinaryPath,
  startDaemon,
  type DaemonHandle,
  type DaemonProcessDiagnostics,
} from '../../../../e2e/harness'

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const CRASH_WORKER = resolve(import.meta.dir, '..', 'fixtures', 'rfc349-postgresql-crash-worker.ts')
const FULL_SEED_COUNTS = Object.freeze({
  tasks: 100_000,
  nodeRuns: 3_000_000,
  events: 10_000_000,
  webhookDeliveries: 100_000,
  cachedRepos: 500,
})
const HARD_FREEZE_MS = 1_000
/** 记一条停顿样本的门槛：比硬门槛低一档，才能看见「还没到红线但已经在长」的那些。 */
const STALL_SAMPLE_MS = 400
const EVENT_LOOP_GAP_MS = 500
const HIDDEN_POSTGRESQL_HOST_KEYS = new Set([
  'PATH',
  'PGBIN',
  'PGDATA',
  'PGROOT',
  'PGPASSWORD',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGDATABASE',
])

export const RFC349_DATABASE_MIGRATION_PHASES = [
  'planned',
  'preflighted',
  'source-frozen',
  'backed-up',
  'target-prepared',
  'copying',
  'verifying',
  'cutover-prepared',
  'switched',
  'health-checked',
  'accepting-writes',
  'finalized',
] as const

export const RFC349_CRASH_POINTS = Object.freeze([
  ...RFC349_DATABASE_MIGRATION_PHASES.flatMap((phase) => [
    `before:${phase}` as const,
    `after:${phase}` as const,
  ]),
  'before:copy-chunk' as const,
  'after:copy-chunk' as const,
])

export type Rfc349T10EvidenceRequirementId =
  | 'checkpoint-crash-and-process-restart'
  | 'owner-lease-and-late-receipt'
  | 'target-runtime-failures'
  | 'manifest-chunk-pointer-corruption'
  | 'freeze-drain-timeout'
  | 'cutover-health-rollback-first-write'
  | 'cancellation-phase-policy'
  | 'full-seed-100-client-soak'
  | 'large-migration-responsiveness'
  | 'compiled-external-postgresql-hidden-tools'

export type Rfc349T10EvidenceOracle =
  | {
      readonly kind: 'bun-test'
      readonly testFile: string
      readonly testName: string
    }
  | {
      readonly kind: 'hosted-workflow'
      readonly job: 'crash-large-and-soak' | 'compiled-external-postgresql'
      readonly invocation: '--mode crash-and-soak' | '--mode compiled-smoke'
      readonly entrypoint:
        | 'runCrashMatrix(url, args.crashPoints)'
        | 'runLargeSoak(args, url)'
        | 'runCompiledSmoke(args, url)'
    }

export interface Rfc349T10EvidenceRequirement {
  readonly id: Rfc349T10EvidenceRequirementId
  readonly oracles: readonly Rfc349T10EvidenceOracle[]
}

/**
 * Closed T10-C/D evidence plan. A test oracle is accepted only when the hosted
 * workflow actually runs its file. A hosted-only oracle is accepted only when
 * the workflow invokes the mode and that mode calls the named real-process
 * entrypoint. The contract test verifies both sides, so adding a descriptive
 * string here cannot manufacture evidence.
 */
export const RFC349_T10_EXECUTABLE_EVIDENCE = Object.freeze([
  {
    id: 'checkpoint-crash-and-process-restart',
    oracles: [
      {
        kind: 'hosted-workflow',
        job: 'crash-large-and-soak',
        invocation: '--mode crash-and-soak',
        entrypoint: 'runCrashMatrix(url, args.crashPoints)',
      },
    ],
  },
  {
    id: 'owner-lease-and-late-receipt',
    oracles: [
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-migration-control-plane.test.ts',
        testName:
          'Settings and CLI converge on one canonical operation while target/options drift does not',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-migration-control-plane.test.ts',
        testName: 'a new owner cannot take over before lease expiry but can resume after expiry',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-migration-store-lock-recovery.test.ts',
        testName: 'reclaims a dead process lock and preserves manifest CAS',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-migration-store-lock-recovery.test.ts',
        testName: 'does not steal a live lock even after its stale-age threshold',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-database-migration-runner.test.ts',
        testName: 'finalize replays the immutable receipt after target metadata interruption',
      },
    ],
  },
  {
    id: 'target-runtime-failures',
    oracles: [
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-postgresql-target-faults.integration.test.ts',
        testName:
          'disconnect, timeout, deadlock, constraint and storage faults roll back row plus receipt before exact resume',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-postgresql-hosted-evidence.test.ts',
        testName:
          'classifies disconnect, timeout and deadlock as retryable while constraint and storage failures stay fail-closed',
      },
    ],
  },
  {
    id: 'manifest-chunk-pointer-corruption',
    oracles: [
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-migration-control-plane.test.ts',
        testName: 'manifest corruption fails closed instead of guessing a phase',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-database-migration-artifact-reader.test.ts',
        testName: 'rejects a mutated chunk even when its path and control manifest still exist',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-generation-store.test.ts',
        testName: 'corrupt pointer, payload digest and binary schema drift fail closed',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-logical-database-restore.test.ts',
        testName: 'rejects a corrupt archive chunk before target prepare',
      },
    ],
  },
  {
    id: 'freeze-drain-timeout',
    oracles: [
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-database-migration-admission.test.ts',
        testName:
          'a bounded drain timeout reopens the same provider instead of copying concurrently',
      },
    ],
  },
  {
    id: 'cutover-health-rollback-first-write',
    oracles: [
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-database-migration-runner.test.ts',
        testName:
          'a target live write wins the recovery CAS and permanently blocks stale SQLite fallback',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-database-migration-runner.test.ts',
        testName: 'instant rollback retires an unwritten target and atomically restores SQLite',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-database-migration-runner.test.ts',
        testName: 'rollback loses the generation CAS after a live write and reopens PostgreSQL',
      },
    ],
  },
  {
    id: 'cancellation-phase-policy',
    oracles: [
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-postgresql-hosted-evidence.test.ts',
        testName:
          'executes cancellation policy against every allowed and forbidden migration phase',
      },
      {
        kind: 'bun-test',
        testFile: 'packages/backend/tests/rfc349-database-migration-runner.test.ts',
        testName: 'an in-flight cancellation stops at the next copied chunk boundary',
      },
    ],
  },
  {
    id: 'full-seed-100-client-soak',
    oracles: [
      {
        kind: 'hosted-workflow',
        job: 'crash-large-and-soak',
        invocation: '--mode crash-and-soak',
        entrypoint: 'runLargeSoak(args, url)',
      },
    ],
  },
  {
    id: 'large-migration-responsiveness',
    oracles: [
      {
        kind: 'hosted-workflow',
        job: 'crash-large-and-soak',
        invocation: '--mode crash-and-soak',
        entrypoint: 'runLargeSoak(args, url)',
      },
    ],
  },
  {
    id: 'compiled-external-postgresql-hidden-tools',
    oracles: [
      {
        kind: 'hosted-workflow',
        job: 'compiled-external-postgresql',
        invocation: '--mode compiled-smoke',
        entrypoint: 'runCompiledSmoke(args, url)',
      },
    ],
  },
] satisfies readonly Rfc349T10EvidenceRequirement[])

export const RFC349_T10_WORKFLOW_TEST_FILES = Object.freeze(
  Array.from(
    new Set(
      RFC349_T10_EXECUTABLE_EVIDENCE.flatMap((requirement) =>
        requirement.oracles.flatMap((oracle) =>
          oracle.kind === 'bun-test' ? [oracle.testFile] : [],
        ),
      ),
    ),
  ).sort(),
)

export const RFC349_T10_FULL_REGRESSION_TOPOLOGY = Object.freeze([
  {
    lane: 'backend',
    evidenceRole: 'provider-neutral-full-regression',
    command: 'bun test --isolate --randomize --seed=349001',
  },
  {
    lane: 'frontend',
    evidenceRole: 'ui-only-full-regression',
    command: 'bun run --filter @agent-workflow/frontend test',
  },
  {
    lane: 'e2e',
    evidenceRole: 'ui-transport-full-regression',
    command: 'bun run e2e -- --shard=${{ matrix.shard }}/4 --workers=1',
  },
] as const)

export type Rfc349CrashPoint = (typeof RFC349_CRASH_POINTS)[number]
export type Rfc349EvidenceMode = 'compiled-smoke' | 'crash-matrix' | 'large-soak' | 'crash-and-soak'

export interface Rfc349EvidenceArgs {
  readonly mode: Rfc349EvidenceMode
  readonly clients: number
  readonly durationMs: number
  readonly clientPauseMs: number
  readonly scale: 'full' | 'small'
  readonly reportPath: string
  readonly binary: string
  readonly keepHome: boolean
  readonly crashPoints: readonly Rfc349CrashPoint[]
}

export interface LatencyStats {
  readonly count: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
}

interface DatasetCounts {
  readonly tasks: number
  readonly nodeRuns: number
  readonly events: number
  readonly webhookDeliveries: number
  readonly cachedRepos: number
  readonly sourceBytes: number
  readonly totalRows: number
}

type ApplicationPoolWaitReport = NonNullable<NonNullable<MaintenanceStatus['database']>['poolWait']>

interface SidecarPoolWaitReport extends LatencyStats {
  readonly kind: 'external-bun-sql-sidecar-acquire'
  readonly poolMax: number
  readonly concurrency: number
  readonly errors: number
}

interface SocketProbe {
  readonly socket: WebSocket
  messages: number
  errors: number
  closes: number
  lastMessageAt: number
  maxGapMs: number
  intentionalClose: boolean
  allowProviderSwitchClose: boolean
  pingTimer: ReturnType<typeof setInterval> | null
  nextNonce: number
}

interface RuntimePhaseReport {
  readonly label: 'sqlite-normal' | 'postgresql-normal' | 'postgresql-maintenance'
  readonly durationMs: number
  readonly clients: number
  readonly api: LatencyStats
  readonly foregroundWrites: LatencyStats
  readonly httpErrors: number
  readonly timeouts: number
  readonly firstErrors: readonly string[]
  readonly websocket: {
    readonly connections: number
    readonly messages: number
    readonly errors: number
    readonly closes: number
    readonly maxGapMs: number
  }
  readonly eventLoop: NonNullable<MaintenanceStatus['eventLoop']> | null
  readonly processMemory: {
    readonly samples: number
    readonly maxRssMib: number | null
  }
  readonly poolWait: ApplicationPoolWaitReport | null
  readonly externalPoolProbe: SidecarPoolWaitReport | null
  readonly daemon: DaemonProcessDiagnostics
}

interface MigrationLoadReport {
  readonly operationId: string
  readonly durationMs: number
  readonly sourceBytes: number
  readonly sourceRows: number
  readonly rowsCopied: number
  readonly bytesCopied: number
  readonly rowsPerSecond: number
  readonly status: LatencyStats
  readonly statusErrors: number
  readonly retries: number
  readonly logicalBackupDigest: string
  readonly eventLoopMaxGapMs: number
  /** 超过阈值的延迟样本连同当时的迁移 phase，按大小排前几条。 */
  readonly stalls: readonly {
    readonly kind: 'status' | 'event-loop'
    readonly phase: string
    readonly ms: number
  }[]
  readonly websocket: {
    readonly connections: number
    readonly messages: number
    readonly errors: number
    readonly providerSwitchCloses: number
    readonly maxGapMs: number
  }
  readonly peakRssMib: number | null
  readonly poolWait: ApplicationPoolWaitReport
  readonly externalPoolProbe: SidecarPoolWaitReport
  readonly finalStatus: DatabaseMigrationStatusView
}

interface MaintenanceJobReport {
  readonly runId: string
  readonly job: MaintenanceJobKey
  readonly state: string
  readonly slices: number
  readonly counters: Readonly<Record<string, number>>
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

interface CrashScenarioReport {
  readonly point: Rfc349CrashPoint
  readonly crashExitCode: number
  readonly resumeExitCode: number
  readonly resumeDurationMs: number
  readonly phase: string
  readonly tablesCompleted: number
  readonly rowsCopied: number
  readonly userPresent: boolean
  readonly archiveTableAbsent: boolean
  readonly manifestRevision: number
}

interface CompiledSmokeReport {
  readonly binary: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly hiddenTools: readonly ['psql', 'pg_dump', 'postgres']
  readonly hiddenPath: string
  readonly migrationDurationMs: number
  readonly operationId: string
  readonly phase: string
  readonly runtime: DatabaseRuntimeOverview
  readonly databaseTelemetry: NonNullable<MaintenanceStatus['database']>
  readonly healthStatus: number
}

interface EvidenceReport {
  readonly version: 1
  readonly targetSha: string
  readonly generatedAt: string
  readonly mode: Rfc349EvidenceMode
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly externalPostgresql: {
    readonly urlEnv: 'RFC349_DATABASE_URL'
    readonly host: string
    readonly port: string
    readonly serverProcessOutsideBinary: true
  }
  readonly tier: {
    readonly clients: number
    readonly durationMs: number
    readonly scale: 'full' | 'small'
  }
  readonly compiledSmoke?: CompiledSmokeReport
  readonly crashMatrix?: readonly CrashScenarioReport[]
  readonly dataset?: DatasetCounts
  readonly migration?: MigrationLoadReport
  readonly runtimePhases?: readonly RuntimePhaseReport[]
  readonly maintenanceJobs?: readonly MaintenanceJobReport[]
  readonly failures: readonly string[]
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index < 0 ? undefined : argv[index + 1]
}

function integerFlag(
  argv: readonly string[],
  name: string,
  fallback: number,
  minimum: number,
): number {
  const value = Number(flag(argv, name) ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`)
  }
  return value
}

function crashPointList(raw: string | undefined): readonly Rfc349CrashPoint[] {
  if (raw === undefined || raw.trim() === '' || raw === 'all') return RFC349_CRASH_POINTS
  const selected = raw.split(',').map((value) => value.trim())
  const unknown = selected.filter(
    (value) => !RFC349_CRASH_POINTS.includes(value as Rfc349CrashPoint),
  )
  if (unknown.length > 0) throw new Error(`unknown crash point(s): ${unknown.join(', ')}`)
  return selected as Rfc349CrashPoint[]
}

export function parseRfc349EvidenceArgs(
  argv: readonly string[] = process.argv.slice(2),
): Rfc349EvidenceArgs {
  const mode = flag(argv, 'mode') ?? 'crash-and-soak'
  if (!['compiled-smoke', 'crash-matrix', 'large-soak', 'crash-and-soak'].includes(mode)) {
    throw new Error('--mode must be compiled-smoke, crash-matrix, large-soak or crash-and-soak')
  }
  const scale = flag(argv, 'scale') ?? 'full'
  if (scale !== 'full' && scale !== 'small') throw new Error('--scale must be full or small')
  return {
    mode: mode as Rfc349EvidenceMode,
    clients: integerFlag(argv, 'clients', 100, 1),
    durationMs: integerFlag(argv, 'duration-seconds', 180, 5) * 1_000,
    clientPauseMs: integerFlag(argv, 'client-pause-ms', 100, 0),
    scale,
    reportPath: resolve(flag(argv, 'report') ?? 'test-results/rfc349-postgresql-evidence.json'),
    binary: resolve(flag(argv, 'binary') ?? defaultBinaryPath()),
    keepHome: argv.includes('--keep-home'),
    crashPoints: crashPointList(flag(argv, 'crash-points')),
  }
}

function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) return 0
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[
    Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * quantile) - 1))
  ]!
}

/**
 * RFC-349 —— 不用 `Math.max(...samples)`：它把整个数组当**函数实参**展开，样本一多就
 * 直接 `RangeError: Maximum call stack size exceeded`。full 口径（100 客户端 × 180 秒
 * × 三个相位）的延迟样本是几十万条，本机全量取证跑实测在收尾算报告时炸在这里——迁移
 * 本身已经跑完（13,208,635 行、崩溃续跑 26/26），只是报告算不出来。
 */
function maxOf(samples: readonly number[]): number {
  let maximum = 0
  for (const sample of samples) if (sample > maximum) maximum = sample
  return maximum
}

export function latencyStats(samples: readonly number[]): LatencyStats {
  return Object.freeze({
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: maxOf(samples),
  })
}

function currentSha(): string {
  const configured = process.env.RFC349_TARGET_SHA ?? process.env.GITHUB_SHA
  if (configured !== undefined && configured !== '') return configured
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT })
  return result.exitCode === 0 ? result.stdout.toString().trim() : 'unknown'
}

function requiredDatabaseUrl(): string {
  const value = process.env.RFC349_DATABASE_URL
  if (value === undefined || value.trim() === '') {
    throw new Error('RFC349_DATABASE_URL must point to a disposable external PostgreSQL database')
  }
  const parsed = new URL(value)
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('RFC349_DATABASE_URL must be a postgresql:// URL')
  }
  return value
}

async function resetPostgresqlSchemas(url: string): Promise<void> {
  const sql = new SQL({ url, max: 1, connectionTimeout: 30 })
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
    await sql.unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
  } finally {
    await sql.close({ timeout: 5 })
  }
}

function processRssMib(pid: number): number | null {
  if (process.platform !== 'linux') return null
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu)
    return match === null ? null : Number(match[1]) / 1024
  } catch {
    return null
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function processExitWithTimeout(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`child timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } catch (error) {
    child.kill('SIGKILL')
    await child.exited.catch(() => undefined)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function readProcessOutput(
  child: ReturnType<typeof Bun.spawn>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ])
  return { stdout, stderr }
}

async function runCrashMatrix(
  url: string,
  points: readonly Rfc349CrashPoint[],
): Promise<readonly CrashScenarioReport[]> {
  const reports: CrashScenarioReport[] = []
  for (const [index, point] of points.entries()) {
    console.log(`[rfc349-pg] crash matrix ${index + 1}/${points.length}: ${point}`)
    await resetPostgresqlSchemas(url)
    const root = mkdtempSync(join(tmpdir(), `aw-rfc349-crash-${index}-`))
    const sentinelPath = join(root, 'crash-sentinel.json')
    const resultPath = join(root, 'resume-result.json')
    const baseEnv = {
      ...process.env,
      RFC349_DATABASE_URL: url,
      RFC349_CRASH_ROOT: root,
      RFC349_CRASH_SENTINEL: sentinelPath,
      RFC349_CRASH_RESULT: resultPath,
    }
    const crashed = Bun.spawn([process.execPath, 'run', CRASH_WORKER], {
      cwd: ROOT,
      env: { ...baseEnv, RFC349_CRASH_POINT: point },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const crashOutput = readProcessOutput(crashed)
    try {
      await waitForFile(sentinelPath, 180_000)
      crashed.kill('SIGKILL')
      const crashExitCode = await crashed.exited
      const capturedCrashOutput = await crashOutput
      if (crashExitCode === 0) {
        throw new Error(`crash worker exited cleanly at ${point}: ${capturedCrashOutput.stdout}`)
      }

      const resumeStartedAt = performance.now()
      const resumed = Bun.spawn([process.execPath, 'run', CRASH_WORKER], {
        cwd: ROOT,
        env: baseEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const resumeOutputPromise = readProcessOutput(resumed)
      const resumeExitCode = await processExitWithTimeout(resumed, 300_000)
      const resumeOutput = await resumeOutputPromise
      if (resumeExitCode !== 0) {
        throw new Error(
          `resume worker failed at ${point} (${resumeExitCode}): ${resumeOutput.stderr || resumeOutput.stdout}`,
        )
      }
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
        phase: string
        tablesCompleted: number
        rowsCopied: number
        userPresent: boolean
        archiveTableAbsent: boolean
        manifestRevision: number
      }
      if (
        result.phase !== 'finalized' ||
        result.tablesCompleted !== 184 ||
        !result.userPresent ||
        !result.archiveTableAbsent
      ) {
        throw new Error(`crash resume invariant failed at ${point}: ${JSON.stringify(result)}`)
      }
      reports.push({
        point,
        crashExitCode,
        resumeExitCode,
        resumeDurationMs: performance.now() - resumeStartedAt,
        ...result,
      })
    } finally {
      if (crashed.exitCode === null) crashed.kill('SIGKILL')
      await crashed.exited.catch(() => undefined)
      await crashOutput.catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  }
  return Object.freeze(reports)
}

function binaryEnvironment(home: string, url: string, hiddenPath: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !HIDDEN_POSTGRESQL_HOST_KEYS.has(entry[0].toUpperCase()),
      ),
    ),
    AGENT_WORKFLOW_HOME: home,
    RFC349_DATABASE_URL: url,
    PATH: hiddenPath,
  }
}

function hiddenDaemonEnvironment(url: string, hiddenPath: string): Record<string, string> {
  return {
    RFC349_DATABASE_URL: url,
    // Node's Windows child-process environment is case-insensitive. Override
    // both spellings so an inherited `Path` cannot outrank the evidence PATH.
    PATH: hiddenPath,
    Path: hiddenPath,
    PGBIN: '',
    PGDATA: '',
    PGROOT: '',
    PGPASSWORD: '',
    PGHOST: '',
    PGPORT: '',
    PGUSER: '',
    PGDATABASE: '',
  }
}

function createPostgresqlToolsHiddenPath(root: string): string {
  const isolatedPath = join(root, 'no-postgresql-tools')
  mkdirSync(isolatedPath, { recursive: true })
  const git = Bun.which('git', { PATH: process.env.PATH ?? '' })
  if (git === null) {
    throw new Error('compiled PostgreSQL evidence requires git on the host PATH')
  }

  // Git is a required daemon dependency, not a PostgreSQL sidecar tool. Keep
  // exactly its executable directory on Windows (Git for Windows needs its
  // adjacent launcher files); on POSIX expose only one symlink to the already
  // resolved executable. The application still cannot resolve psql, pg_dump
  // or postgres from this deliberately isolated PATH.
  const hiddenPath = process.platform === 'win32' ? `${isolatedPath};${dirname(git)}` : isolatedPath
  if (process.platform !== 'win32') symlinkSync(git, join(isolatedPath, 'git'))
  for (const tool of ['psql', 'pg_dump', 'postgres']) {
    if (Bun.which(tool, { PATH: hiddenPath }) !== null) {
      throw new Error(`PostgreSQL tool remained visible on isolated application PATH: ${tool}`)
    }
  }
  return hiddenPath
}

async function runBinary(input: {
  readonly binary: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([input.binary, ...input.argv], {
    cwd: ROOT,
    env: input.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const outputPromise = readProcessOutput(child)
  const exitCode = await processExitWithTimeout(child, input.timeoutMs ?? 300_000)
  const output = await outputPromise
  if (exitCode !== 0) {
    throw new Error(
      `${input.binary} ${input.argv.join(' ')} exited ${exitCode}: ${output.stderr || output.stdout}`,
    )
  }
  return output
}

function lastJsonObject(output: string): Record<string, unknown> {
  for (const line of output.trim().split(/\r?\n/u).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Informational log lines may precede the JSON projection.
    }
  }
  throw new Error(`compiled command returned no JSON object: ${output.slice(-1_000)}`)
}

async function apiJson(
  daemon: DaemonHandle,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${daemon.token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetchWithTimeout(`${daemon.baseUrl}${path}`, { ...init, headers }, 15_000)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${body.slice(0, 500)}`)
  }
  return body === '' ? {} : JSON.parse(body)
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (init.signal !== undefined && init.signal !== null) return await fetch(input, init)
  const deadline = timeoutSignal(timeoutMs)
  try {
    return await fetch(input, { ...init, signal: deadline.signal })
  } finally {
    deadline.cancel()
  }
}

async function runCompiledSmoke(
  args: Rfc349EvidenceArgs,
  url: string,
): Promise<CompiledSmokeReport> {
  await resetPostgresqlSchemas(url)
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc349-compiled-'))
  const home = join(root, 'home')
  const hiddenPath = createPostgresqlToolsHiddenPath(root)
  const env = binaryEnvironment(home, url, hiddenPath)
  let daemon: DaemonHandle | null = null
  try {
    await runBinary({ binary: args.binary, argv: ['migrate'], env })
    const startedAt = performance.now()
    const migrated = await runBinary({
      binary: args.binary,
      argv: [
        'db',
        'migrate',
        '--to',
        'postgresql',
        '--url-env',
        'RFC349_DATABASE_URL',
        '--auto',
        '--pool-max',
        '8',
        '--statement-timeout-ms',
        '120000',
        '--json',
      ],
      env,
      timeoutMs: 600_000,
    })
    const migration = databaseMigrationStatusViewSchema.parse(lastJsonObject(migrated.stdout))
    const finalized = await runBinary({
      binary: args.binary,
      argv: ['db', 'migration', 'finalize', migration.operationId, '--json'],
      env,
      timeoutMs: 300_000,
    })
    const finalStatus = databaseMigrationStatusViewSchema.parse(lastJsonObject(finalized.stdout))
    if (finalStatus.phase !== 'finalized') {
      throw new Error(`compiled migration did not finalize: ${finalStatus.phase}`)
    }
    daemon = await startDaemon({
      binary: args.binary,
      home,
      configOverrides: { database: finalStatus.target },
      extraEnv: hiddenDaemonEnvironment(url, hiddenPath),
      readyTimeoutMs: 180_000,
    })
    const health = await fetchWithTimeout(`${daemon.baseUrl}/health`, {}, 10_000)
    const runtime = databaseRuntimeOverviewSchema.parse(await apiJson(daemon, '/api/database'))
    if (runtime.provider !== 'postgresql') {
      throw new Error(`compiled daemon selected ${runtime.provider}, expected postgresql`)
    }
    const databaseTelemetry = (await maintenanceStatus(daemon)).database
    if (
      databaseTelemetry?.provider !== 'postgresql' ||
      databaseTelemetry.poolWait === null ||
      databaseTelemetry.poolWait.sampleCount === 0
    ) {
      throw new Error('compiled PostgreSQL daemon omitted production pool-wait telemetry')
    }
    return Object.freeze({
      binary: args.binary,
      platform: process.platform,
      arch: process.arch,
      hiddenTools: ['psql', 'pg_dump', 'postgres'] as const,
      hiddenPath,
      migrationDurationMs: performance.now() - startedAt,
      operationId: finalStatus.operationId,
      phase: finalStatus.phase,
      runtime,
      databaseTelemetry,
      healthStatus: health.status,
    })
  } finally {
    if (daemon !== null) await daemon.stop().catch(() => undefined)
    if (args.keepHome) console.log(`[rfc349-pg] preserved compiled home ${home}`)
    else rmSync(root, { recursive: true, force: true })
  }
}

function queryCount(raw: Database, table: string): number {
  const row = raw.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }
  return row.count
}

function datasetCounts(dbPath: string): DatasetCounts {
  const raw = new Database(dbPath, { readonly: true })
  try {
    const tasks = queryCount(raw, 'tasks')
    const nodeRuns = queryCount(raw, 'node_runs')
    const events = queryCount(raw, 'node_run_events')
    const webhookDeliveries = queryCount(raw, 'webhook_deliveries')
    const cachedRepos = queryCount(raw, 'cached_repos')
    const tableRows = raw
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('__drizzle_migrations', '_drizzle_migrations')",
      )
      .all() as { name: string }[]
    const totalRows = tableRows.reduce((sum, row) => sum + queryCount(raw, row.name), 0)
    return {
      tasks,
      nodeRuns,
      events,
      webhookDeliveries,
      cachedRepos,
      sourceBytes: statSync(dbPath).size,
      totalRows,
    }
  } finally {
    raw.close()
  }
}

function prepareSoakDataset(dbPath: string): void {
  const raw = new Database(dbPath)
  try {
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; BEGIN IMMEDIATE;')
    raw
      .query(
        `UPDATE node_runs
            SET status = 'done', finished_at = coalesce(finished_at, started_at, ?),
                exit_code = coalesce(exit_code, 0), pid = NULL
          WHERE status IN ('running', 'pending')`,
      )
      .run(Date.now())
    raw
      .query(
        `UPDATE tasks SET status = 'done', finished_at = coalesce(finished_at, started_at, ?)
          WHERE status IN ('running', 'pending')`,
      )
      .run(Date.now())
    raw.exec('COMMIT;')
  } catch (error) {
    try {
      raw.exec('ROLLBACK;')
    } catch {
      // Preserve the preparation failure.
    }
    throw error
  } finally {
    raw.close()
  }
}

async function runSeed(dbPath: string, scale: Rfc349EvidenceArgs['scale']): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      resolve(ROOT, 'scripts', 'perf-seed.ts'),
      '--db',
      dbPath,
      ...(scale === 'small' ? ['--small'] : []),
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  )
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`RFC-311 perf seed exited ${exitCode}`)
}

async function maintenanceStatus(daemon: DaemonHandle): Promise<MaintenanceStatus> {
  return MaintenanceStatusSchema.parse(await apiJson(daemon, '/api/maintenance/status'))
}

async function waitForBootMaintenance(daemon: DaemonHandle): Promise<void> {
  await Bun.sleep(31_000)
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const status = await maintenanceStatus(daemon)
    const failed = status.backlog.filter((row) => row.state === 'failed')
    if (failed.length > 0) throw new Error(`boot maintenance failed: ${JSON.stringify(failed)}`)
    if (status.worker.state === 'ready' && status.active === null && status.backlog.length === 0) {
      return
    }
    await Bun.sleep(250)
  }
  throw new Error('boot maintenance did not drain before the hosted soak')
}

/**
 * The manifest reaches `accepting-writes` a beat BEFORE business admission
 * reopens, and that ordering is deliberate: the durable record has to advance
 * first so a crash between the two replays into a well-defined state
 * (`databaseMigrationRunner`, case 'health-checked'). Every real client sees the
 * same millisecond window and answers it the same way — retry the 503. Waiting
 * here keeps the post-migration phase measuring the runtime instead of the
 * handover.
 */
async function waitForBusinessAdmission(daemon: DaemonHandle): Promise<void> {
  const deadline = Date.now() + 60_000
  let lastStatus = 0
  while (Date.now() < deadline) {
    // Must be a *business* route. `/api/maintenance/status`, `/api/health` and
    // the `/api/database*` control plane are exempt from the maintenance gate
    // by design — polling one of those answers 200 while business traffic is
    // still refused, and the phase below then opens its WebSockets too early.
    const response = await fetchWithTimeout(
      `${daemon.baseUrl}/api/tasks?limit=1`,
      { headers: { authorization: `Bearer ${daemon.token}` } },
      15_000,
    )
    await response.text()
    if (response.ok) return
    lastStatus = response.status
    if (response.status !== 503) {
      throw new Error(`business admission probe -> ${response.status}`)
    }
    await Bun.sleep(100)
  }
  throw new Error(`business admission stayed closed after the migration (last ${lastStatus})`)
}

async function openSocketProbe(
  daemon: DaemonHandle,
  allowProviderSwitchClose = false,
): Promise<SocketProbe> {
  const url = new URL(daemon.baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws/tasks'
  url.searchParams.set('token', daemon.token)
  const startedAt = performance.now()
  const socket = new WebSocket(url)
  const probe: SocketProbe = {
    socket,
    messages: 0,
    errors: 0,
    closes: 0,
    lastMessageAt: startedAt,
    maxGapMs: 0,
    intentionalClose: false,
    allowProviderSwitchClose,
    pingTimer: null,
    nextNonce: 0,
  }
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error('websocket hello timeout')), 10_000)
    socket.addEventListener('message', (event) => {
      let frame: unknown
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if ((frame as { type?: unknown } | null)?.type !== 'pong') {
        clearTimeout(timeout)
        resolveOpen()
        return
      }
      const now = performance.now()
      probe.maxGapMs = Math.max(probe.maxGapMs, now - probe.lastMessageAt)
      probe.lastMessageAt = now
      probe.messages += 1
    })
    socket.addEventListener('error', () => {
      probe.errors += 1
      clearTimeout(timeout)
      rejectOpen(new Error('websocket transport error before hello'))
    })
    socket.addEventListener('close', () => {
      probe.closes += 1
      if (!probe.intentionalClose && !probe.allowProviderSwitchClose) probe.errors += 1
    })
  })
  probe.lastMessageAt = performance.now()
  probe.pingTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping', nonce: probe.nextNonce++ }))
    }
  }, 250)
  return probe
}

function closeSocketProbes(probes: readonly SocketProbe[]): void {
  const now = performance.now()
  for (const probe of probes) {
    if (probe.socket.readyState === WebSocket.OPEN) {
      probe.maxGapMs = Math.max(probe.maxGapMs, now - probe.lastMessageAt)
    }
    probe.intentionalClose = true
    if (probe.pingTimer !== null) clearInterval(probe.pingTimer)
    probe.socket.close()
  }
}

async function runPoolWaitProbe(
  url: string,
  clients: number,
  durationMs: number,
): Promise<SidecarPoolWaitReport> {
  const poolMax = Math.max(2, Math.min(8, Math.floor(clients / 4) || 2))
  const concurrency = Math.max(poolMax + 1, Math.min(clients, 32))
  const waits: number[] = []
  let errors = 0
  const sql = new SQL({ url, max: poolMax, connectionTimeout: 30 })
  const deadline = Date.now() + Math.min(durationMs, 30_000)
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (Date.now() < deadline) {
          const startedAt = performance.now()
          try {
            const connection = await sql.reserve()
            waits.push(performance.now() - startedAt)
            try {
              await connection.unsafe('SELECT pg_sleep(0.005)')
            } finally {
              connection.release()
            }
          } catch {
            errors += 1
          }
        }
      }),
    )
  } finally {
    await sql.close({ timeout: 5 })
  }
  return Object.freeze({
    kind: 'external-bun-sql-sidecar-acquire' as const,
    poolMax,
    concurrency,
    errors,
    ...latencyStats(waits),
  })
}

async function runRuntimePhase(input: {
  readonly label: RuntimePhaseReport['label']
  readonly daemon: DaemonHandle
  readonly args: Rfc349EvidenceArgs
  readonly taskIds: readonly string[]
  readonly postgresqlUrl?: string
  readonly beforeRequests?: () => Promise<void>
}): Promise<RuntimePhaseReport> {
  const sockets = await Promise.all(
    Array.from({ length: input.args.clients }, () => openSocketProbe(input.daemon)),
  )
  await input.beforeRequests?.()
  const apiSamples: number[] = []
  const writeSamples: number[] = []
  const rssSamples: number[] = []
  const firstErrors: string[] = []
  let httpErrors = 0
  let timeouts = 0
  let taskCursor = 0
  const deadline = Date.now() + input.args.durationMs
  const headers = { authorization: `Bearer ${input.daemon.token}` }
  const readPaths = [
    '/api/tasks?limit=50',
    '/api/tasks?limit=50&status=done',
    '/api/cached-repos?limit=50',
    '/api/overview',
  ] as const
  const rssTimer = setInterval(() => {
    const rss = processRssMib(input.daemon.pid)
    if (rss !== null) rssSamples.push(rss)
  }, 1_000)
  const poolWaitPromise =
    input.postgresqlUrl === undefined
      ? Promise.resolve<SidecarPoolWaitReport | null>(null)
      : runPoolWaitProbe(input.postgresqlUrl, input.args.clients, input.args.durationMs)
  const request = async (path: string, method: 'GET' | 'PUT', body?: string): Promise<void> => {
    const startedAt = performance.now()
    try {
      const response = await fetchWithTimeout(
        `${input.daemon.baseUrl}${path}`,
        {
          method,
          headers:
            body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body }),
        },
        5_000,
      )
      await response.arrayBuffer()
      const elapsed = performance.now() - startedAt
      apiSamples.push(elapsed)
      if (method === 'PUT') writeSamples.push(elapsed)
      if (!response.ok) {
        httpErrors += 1
        if (firstErrors.length < 10) firstErrors.push(`${method} ${path} -> ${response.status}`)
      }
    } catch (error) {
      const elapsed = performance.now() - startedAt
      apiSamples.push(elapsed)
      if (method === 'PUT') writeSamples.push(elapsed)
      httpErrors += 1
      if (error instanceof DOMException && error.name === 'TimeoutError') timeouts += 1
      if (firstErrors.length < 10) {
        firstErrors.push(`${method} ${path} -> ${error instanceof Error ? error.message : error}`)
      }
    }
  }
  const startedAt = Date.now()
  try {
    await Promise.all(
      Array.from({ length: input.args.clients }, async (_, clientIndex) => {
        let iteration = 0
        while (Date.now() < deadline) {
          const shouldWrite = clientIndex % 5 === 0 && iteration % 4 === 3
          if (shouldWrite && taskCursor < input.taskIds.length) {
            const taskId = input.taskIds[taskCursor++]!
            await request(
              `/api/tasks/${encodeURIComponent(taskId)}/members`,
              'PUT',
              JSON.stringify({ members: [] }),
            )
          } else if (iteration % 5 === 4) {
            const index = (clientIndex * 97 + iteration * 13) % input.taskIds.length
            await request(`/api/tasks/${encodeURIComponent(input.taskIds[index]!)}`, 'GET')
          } else {
            await request(readPaths[(clientIndex + iteration) % readPaths.length]!, 'GET')
          }
          iteration += 1
          if (input.args.clientPauseMs > 0) await Bun.sleep(input.args.clientPauseMs)
        }
      }),
    )
  } finally {
    clearInterval(rssTimer)
    closeSocketProbes(sockets)
  }
  const status = await maintenanceStatus(input.daemon)
  const externalPoolProbe = await poolWaitPromise
  const poolWait =
    status.database?.provider === 'postgresql' ? (status.database.poolWait ?? null) : null
  return Object.freeze({
    label: input.label,
    durationMs: Date.now() - startedAt,
    clients: input.args.clients,
    api: latencyStats(apiSamples),
    foregroundWrites: latencyStats(writeSamples),
    httpErrors,
    timeouts,
    firstErrors,
    websocket: {
      connections: sockets.length,
      messages: sockets.reduce((sum, probe) => sum + probe.messages, 0),
      errors: sockets.reduce((sum, probe) => sum + probe.errors, 0),
      closes: sockets.reduce((sum, probe) => sum + probe.closes, 0),
      maxGapMs: sockets.reduce((max, probe) => Math.max(max, probe.maxGapMs), 0),
    },
    eventLoop: status.eventLoop ?? null,
    processMemory: {
      samples: rssSamples.length,
      maxRssMib: rssSamples.length === 0 ? null : maxOf(rssSamples),
    },
    poolWait,
    externalPoolProbe,
    daemon: input.daemon.diagnostics(),
  })
}

async function runLargeMigration(input: {
  readonly daemon: DaemonHandle
  readonly args: Rfc349EvidenceArgs
  readonly url: string
}): Promise<MigrationLoadReport> {
  const target = {
    provider: 'postgresql' as const,
    urlEnv: 'RFC349_DATABASE_URL',
    poolMax: 16,
    connectTimeoutMs: 10_000,
    statementTimeoutMs: 600_000,
    idleTimeoutMs: 60_000,
  }
  const preflight = databaseMigrationPreflightViewSchema.parse(
    await apiJson(input.daemon, '/api/database/migrations/preflight', {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
  )
  const sockets = await Promise.all(
    Array.from({ length: input.args.clients }, () => openSocketProbe(input.daemon, true)),
  )
  const started = databaseMigrationStatusViewSchema.parse(
    await apiJson(input.daemon, '/api/database/migrations', {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: `hosted:${currentSha()}`, target }),
    }),
  )
  const samples: number[] = []
  const rssSamples: number[] = []
  // 停顿发生在**哪个阶段**，报告以前一个字都没有：只有一个跨整场迁移的 max。
  // 2026-09-03 追一次 18.1 秒的事件循环停顿时，这条信息缺失让排查多花了一整轮
  // （最后靠离线实测各操作耗时才定位到安全备份的 quick_check）。现在超过阈值的样本
  // 连同当时的 phase 一起记下来，报告里按大小列前几条。
  const stalls: Array<{
    readonly kind: 'status' | 'event-loop'
    readonly phase: string
    readonly ms: number
  }> = []
  const recordStall = (kind: 'status' | 'event-loop', phase: string, ms: number): void => {
    if (ms < STALL_SAMPLE_MS) return
    stalls.push({ kind, phase, ms })
    stalls.sort((left, right) => right.ms - left.ms)
    if (stalls.length > 12) stalls.length = 12
  }
  let statusErrors = 0
  let retries = 0
  let eventLoopMaxGapMs = 0
  let latestPoolWait: ApplicationPoolWaitReport | null = null
  let stopTelemetry = false
  let latest = started
  const deadline = Date.now() + (input.args.scale === 'full' ? 7_200_000 : 900_000)
  const startedAt = performance.now()
  const poolWaitPromise = runPoolWaitProbe(input.url, input.args.clients, 30_000)
  const rssTimer = setInterval(() => {
    const rss = processRssMib(input.daemon.pid)
    if (rss !== null) rssSamples.push(rss)
  }, 1_000)
  const telemetryPromise = (async () => {
    do {
      try {
        const status = await maintenanceStatus(input.daemon)
        const gap = status.eventLoop?.maxGapMs ?? 0
        if (gap > eventLoopMaxGapMs) recordStall('event-loop', latest.phase, gap)
        eventLoopMaxGapMs = Math.max(eventLoopMaxGapMs, gap)
        if (status.database?.provider === 'postgresql' && status.database.poolWait !== null) {
          latestPoolWait = status.database.poolWait
        }
      } catch {
        statusErrors += 1
      }
      if (!stopTelemetry) await Bun.sleep(1_000)
    } while (!stopTelemetry && Date.now() < deadline)
  })()
  try {
    await Promise.all(
      Array.from({ length: input.args.clients }, async () => {
        while (Date.now() < deadline && latest.phase !== 'accepting-writes') {
          const requestAt = performance.now()
          try {
            latest = databaseMigrationStatusViewSchema.parse(
              await apiJson(input.daemon, `/api/database/migrations/${started.operationId}`),
            )
            retries = Math.max(retries, latest.failure?.retryCount ?? 0)
            samples.push(performance.now() - requestAt)
            recordStall('status', latest.phase, performance.now() - requestAt)
            if (latest.failure !== null) break
          } catch {
            samples.push(performance.now() - requestAt)
            statusErrors += 1
          }
          await Bun.sleep(Math.max(25, input.args.clientPauseMs))
        }
      }),
    )
    if (Date.now() >= deadline) throw new Error(`large migration timed out in ${latest.phase}`)
    if (latest.failure !== null) {
      throw new Error(`large migration failed: ${JSON.stringify(latest.failure)}`)
    }
  } finally {
    stopTelemetry = true
    await telemetryPromise
    clearInterval(rssTimer)
    closeSocketProbes(sockets)
  }
  // The phase loop above exits the moment the manifest says `accepting-writes`,
  // which is one beat BEFORE admission actually reopens (the durable record has
  // to advance first so a crash between the two replays cleanly). Artifact reads
  // are migration-control requests and therefore exempt from the maintenance
  // gate, but the provider handover itself still has a window where the listener
  // has no serving session. Retry the 503 the way any client would, and report
  // the body when it is something else — an opaque status here costs a whole
  // round-trip to diagnose.
  const artifactUrl = `${input.daemon.baseUrl}/api/database/migrations/${started.operationId}/artifacts/logical-backup`
  const artifactDeadline = Date.now() + 60_000
  let artifact = await fetchWithTimeout(
    artifactUrl,
    { headers: { authorization: `Bearer ${input.daemon.token}` } },
    60_000,
  )
  while (artifact.status === 503 && Date.now() < artifactDeadline) {
    await artifact.text()
    await Bun.sleep(200)
    artifact = await fetchWithTimeout(
      artifactUrl,
      { headers: { authorization: `Bearer ${input.daemon.token}` } },
      60_000,
    )
  }
  if (!artifact.ok) {
    throw new Error(
      `logical backup artifact returned ${artifact.status} ${(await artifact.text()).slice(0, 300)}`,
    )
  }
  await artifact.arrayBuffer()
  const digest = artifact.headers.get('x-agent-workflow-artifact-digest')
  if (digest === null) throw new Error('logical backup artifact omitted its digest header')
  const durationMs = performance.now() - startedAt
  const externalPoolProbe = await poolWaitPromise
  const statusProjection = await maintenanceStatus(input.daemon)
  eventLoopMaxGapMs = Math.max(eventLoopMaxGapMs, statusProjection.eventLoop?.maxGapMs ?? 0)
  const finalPoolWait =
    statusProjection.database?.provider === 'postgresql' ? statusProjection.database.poolWait : null
  const poolWait = finalPoolWait ?? latestPoolWait
  if (poolWait === null || poolWait === undefined) {
    throw new Error('PostgreSQL daemon did not expose production pool-wait telemetry')
  }
  return Object.freeze({
    operationId: started.operationId,
    durationMs,
    sourceBytes: preflight.sourceBytes,
    sourceRows: preflight.sourceRows,
    rowsCopied: latest.progress.rowsCopied,
    bytesCopied: latest.progress.bytesCopied,
    rowsPerSecond: latest.progress.rowsCopied / Math.max(0.001, durationMs / 1_000),
    status: latencyStats(samples),
    statusErrors,
    retries,
    logicalBackupDigest: digest,
    eventLoopMaxGapMs,
    stalls: Object.freeze([...stalls]),
    websocket: {
      connections: sockets.length,
      messages: sockets.reduce((sum, probe) => sum + probe.messages, 0),
      errors: sockets.reduce((sum, probe) => sum + probe.errors, 0),
      providerSwitchCloses: sockets.reduce((sum, probe) => sum + probe.closes, 0),
      maxGapMs: sockets.reduce((max, probe) => Math.max(max, probe.maxGapMs), 0),
    },
    peakRssMib: rssSamples.length === 0 ? null : maxOf(rssSamples),
    poolWait,
    externalPoolProbe,
    finalStatus: latest,
  })
}

/**
 * 这一轮取证要归档掉多少行事件。
 *
 * 原来写的是「保留 expectedEvents/10」——full 种子 1000 万事件就是要归档 900 万行。
 * 归档按 RFC-338 的合同走每片 1000 行的有界切片，本机对着真 PostgreSQL 实测
 * **约 1.1 秒一片**（6526 片 / 约 2 小时，`node_run_events` 的 idx_scan 2719 万次、
 * seq_scan 只有 354 次——每片确实是索引驱动的有界工作，不是每片重扫全表），
 * 900 万行需要接近 3 小时，而 hosted job 的总预算只有 210 分钟。
 *
 * 取证要证的是「PostgreSQL 上维护作业按有界切片推进并收敛」，不是「归档 900 万行」。
 * 因此把目标固定成一个有界行数：full 种子约 1500 片、25~30 分钟，既跑满多切片路径，
 * 也装得进 hosted 预算。改这个数只改本轮取证的工作量，不碰任何产品阈值。
 */
const EVIDENCE_ARCHIVE_TARGET_ROWS = 1_500_000

/** 归档阈值 = 保留行数；高于它的才会被归档。 */
export function evidenceArchiveRetainRows(expectedEvents: number): number {
  return Math.max(1_000, expectedEvents - EVIDENCE_ARCHIVE_TARGET_ROWS)
}

function heavyPayloads(expectedEvents: number): Record<string, Readonly<Record<string, unknown>>> {
  return {
    worktreeGc: { worktreeAutoGc: { enabled: false }, activeTaskIds: [] },
    webhookDeliveryGc: { bodyRetentionDays: 1, rowRetentionDays: 1 },
    eventsArchive: {
      eventsArchiveThresholds: {
        perNodeRunRows: 50_000,
        globalRows: evidenceArchiveRetainRows(expectedEvents),
        perNodeRunBytes: 0,
        globalBytes: 0,
      },
    },
    retentionSweep: { eventStreamRetentionDays: 1, webhookTriggerFiresRetentionDays: 1 },
    taskArchive: { enabled: false, retentionDays: 30, maxTreesPerSweep: 1 },
    backupPrune: {
      retentionCount: 10,
      retentionDays: 30,
      maxTotalBytes: 10 * 1024 * 1024 * 1024,
      protectedKeepCount: 3,
    },
    pluginGenerationGc: {},
    developmentUploadGc: {},
    developmentRetentionSweep: {},
    employeeInputGc: {},
    intentScratchGc: { retentionHours: 24 },
    tokenAuditGc: { retentionDays: 90 },
  }
}

async function enqueuePostgresqlMaintenance(input: {
  readonly url: string
  readonly generationId: string
  readonly expectedEvents: number
}): Promise<{
  readonly runtime: ReturnType<typeof createPostgresqlDatabaseRuntime>
  readonly store: ReturnType<typeof createPostgresqlMaintenanceRunStore>
  readonly queued: readonly { readonly runId: string; readonly job: MaintenanceJobKey }[]
}> {
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC349_DATABASE_URL',
      poolMax: 4,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 120_000,
      idleTimeoutMs: 60_000,
    },
    generationId: input.generationId,
    env: { RFC349_DATABASE_URL: input.url },
  })
  const store = createPostgresqlMaintenanceRunStore(createPostgresqlDatabaseClient(runtime))
  const payloads = heavyPayloads(input.expectedEvents)
  const runTag = randomUUID()
  const now = Date.now()
  const queued: Array<{ readonly runId: string; readonly job: MaintenanceJobKey }> = []
  for (const [index, job] of HEAVY_MAINTENANCE_JOB_KEYS.entries()) {
    const runId = randomUUID()
    const receipt = await store.enqueue({
      id: runId,
      jobKey: job,
      jobClass: maintenanceJobSpec(job).class,
      slotKey: `rfc349-soak:${runTag}:${job}`,
      cycleKey: `rfc349-soak:${runTag}`,
      payload: payloads[job] ?? {},
      scheduledAt: now,
      now: now + index,
    })
    if (!receipt.inserted) throw new Error(`PostgreSQL maintenance ${job} was coalesced`)
    queued.push({ runId, job })
  }
  return { runtime, store, queued: Object.freeze(queued) }
}

function parseCounters(value: string): Record<string, number> {
  const parsed = JSON.parse(value) as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  )
}

async function waitForMaintenanceJobs(
  store: ReturnType<typeof createPostgresqlMaintenanceRunStore>,
  queued: readonly { readonly runId: string; readonly job: MaintenanceJobKey }[],
): Promise<readonly MaintenanceJobReport[]> {
  // RFC-349 —— 判据是「还在推进吗」，不是「多少秒内做完」。
  //
  // 这里原本是死的 900 秒，而同一个 harness 自己把 `eventsArchive` 的阈值配成
  // `globalRows = expectedEvents / 10`：full 种子 1000 万事件，也就是要归档掉约 900 万行。
  // 归档按 RFC-338 的合同走**每片 1000 行**的有界切片，跟产品无关，只是工作量与等待窗
  // 对不上。工作量本身也已经按 `evidenceArchiveRetainRows` 收敛到有界的一档（见那里的
  // 实测数据），这里只保留「还在推进吗」的判据。
  //
  // 所以改成停滞判据：只要有任何一个 job 的 slice 在推进就继续等；连续 STALL_MS 没有任何
  // 推进才算真卡住（另有一个绝对上限兜底，防止无限等）。这样种子再变大也不用重新调数。
  const STALL_MS = 300_000
  // 绝对上限只是兜底：真正的判据是上面的停滞检测。按实测约 1.1 秒一片、
  // `EVIDENCE_ARCHIVE_TARGET_ROWS` 约 1500 片算，25~30 分钟就该收敛；45 分钟留足余量，
  // 又不会把 hosted job 的 210 分钟总预算耗在这一步上。
  const deadline = Date.now() + 2_700_000
  let lastProgressAt = Date.now()
  let lastSignature = ''
  while (Date.now() < deadline) {
    const rows = await Promise.all(queued.map(async ({ runId }) => await store.read(runId)))
    const signature = rows.map((row) => `${row?.state ?? '-'}:${row?.sliceNo ?? 0}`).join('|')
    if (signature !== lastSignature) {
      lastSignature = signature
      lastProgressAt = Date.now()
    } else if (Date.now() - lastProgressAt > STALL_MS) {
      const stalled = rows
        .map((row, index) => ({ job: queued[index]!.job, state: row?.state ?? 'missing' }))
        .filter((entry) => !['succeeded', 'failed'].includes(entry.state))
      throw new Error(
        `PostgreSQL maintenance stalled for ${Math.round(STALL_MS / 1000)}s: ${JSON.stringify(stalled)}`,
      )
    }
    if (rows.every((row) => row !== null && ['succeeded', 'failed'].includes(row.state))) {
      return Object.freeze(
        rows.map((row, index) => ({
          runId: queued[index]!.runId,
          job: queued[index]!.job,
          state: row!.state,
          slices: row!.sliceNo,
          counters: parseCounters(row!.countersJson),
          errorCode: row!.errorCode,
          errorMessage: row!.errorMessage,
        })),
      )
    }
    await Bun.sleep(250)
  }
  throw new Error('PostgreSQL maintenance jobs did not reach a terminal state')
}

function futureDailySchedule(): {
  readonly kind: 'daily'
  readonly at: string
  readonly timezone: 'UTC'
} {
  const future = new Date(Date.now() + 12 * 60 * 60_000)
  return {
    kind: 'daily',
    at: `${String(future.getUTCHours()).padStart(2, '0')}:${String(future.getUTCMinutes()).padStart(2, '0')}`,
    timezone: 'UTC',
  }
}

async function recordPhase(
  collected: RuntimePhaseReport[],
  input: Parameters<typeof runRuntimePhase>[0],
): Promise<RuntimePhaseReport> {
  const phase = await runRuntimePhase(input)
  collected.push(phase)
  return phase
}

async function runLargeSoak(
  args: Rfc349EvidenceArgs,
  url: string,
): Promise<{
  readonly dataset: DatasetCounts
  readonly migration: MigrationLoadReport
  readonly runtimePhases: readonly RuntimePhaseReport[]
  readonly maintenanceJobs: readonly MaintenanceJobReport[]
}> {
  await resetPostgresqlSchemas(url)
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc349-large-'))
  const home = join(root, 'home')
  const dbPath = join(home, 'db.sqlite')
  const hiddenPath = createPostgresqlToolsHiddenPath(root)
  const configOverrides = {
    maintenanceSchedule: futureDailySchedule(),
    eventsArchiveThresholds: {
      perNodeRunRows: 1_000_000_000,
      globalRows: 1_000_000_000,
      perNodeRunBytes: 0,
      globalBytes: 0,
    },
    webhookDeliveryBodyRetentionDays: 3_650,
    webhookDeliveryRowRetentionDays: 3_650,
    eventStreamRetentionDays: 3_650,
    webhookTriggerFiresRetentionDays: 3_650,
    tokenAuditRetentionDays: 3_650,
    taskArchive: { enabled: false, retentionDays: 30, maxTreesPerSweep: 1 },
    worktreeAutoGc: { enabled: false },
  }
  let daemon: DaemonHandle | null = null
  let maintenanceRuntime: ReturnType<typeof createPostgresqlDatabaseRuntime> | null = null
  // RFC-349 —— 相位测量一测完就记下来。此前它们是局部变量，任何**之后**的步骤抛错
  // （实撞：维护等待窗超时）都会把整整 50 分钟跑出来的相位证据一起丢掉，报告里只剩一行
  // failure，没法判断产品侧到底绿没绿。
  const collectedPhases: RuntimePhaseReport[] = []
  try {
    daemon = await startDaemon({
      binary: args.binary,
      home,
      configOverrides,
      extraEnv: hiddenDaemonEnvironment(url, hiddenPath),
      readyTimeoutMs: 180_000,
    })
    await daemon.stop()
    daemon = null
    await runSeed(dbPath, args.scale)
    prepareSoakDataset(dbPath)
    const dataset = datasetCounts(dbPath)
    if (args.scale === 'full') {
      for (const [key, expected] of Object.entries(FULL_SEED_COUNTS)) {
        const actual = dataset[key as keyof typeof FULL_SEED_COUNTS]
        if (actual !== expected) throw new Error(`full seed ${key}=${actual}, expected ${expected}`)
      }
    }
    daemon = await startDaemon({
      binary: args.binary,
      home,
      configOverrides,
      extraEnv: hiddenDaemonEnvironment(url, hiddenPath),
      readyTimeoutMs: args.scale === 'full' ? 600_000 : 180_000,
    })
    await waitForBootMaintenance(daemon)
    const taskIds = Array.from(
      { length: dataset.tasks },
      (_, index) => `perftask${String(index).padStart(7, '0')}`,
    )
    const sqliteNormal = await recordPhase(collectedPhases, {
      label: 'sqlite-normal',
      daemon,
      args,
      taskIds: taskIds.slice(0, Math.floor(taskIds.length / 3)),
    })
    const migration = await runLargeMigration({ daemon, args, url })
    await waitForBusinessAdmission(daemon)
    const runtime = databaseRuntimeOverviewSchema.parse(await apiJson(daemon, '/api/database'))
    if (runtime.provider !== 'postgresql') {
      throw new Error(`large migration selected ${runtime.provider}, expected postgresql`)
    }
    const postgresqlNormal = await recordPhase(collectedPhases, {
      label: 'postgresql-normal',
      daemon,
      args,
      taskIds: taskIds.slice(Math.floor(taskIds.length / 3), Math.floor((taskIds.length * 2) / 3)),
      postgresqlUrl: url,
    })
    const maintenance = await enqueuePostgresqlMaintenance({
      url,
      generationId: runtime.generationId,
      expectedEvents: dataset.events,
    })
    maintenanceRuntime = maintenance.runtime
    const postgresqlMaintenance = await recordPhase(collectedPhases, {
      label: 'postgresql-maintenance',
      daemon,
      args,
      taskIds: taskIds.slice(Math.floor((taskIds.length * 2) / 3)),
      postgresqlUrl: url,
    })
    const maintenanceJobs = await waitForMaintenanceJobs(maintenance.store, maintenance.queued)
    const finalized = databaseMigrationStatusViewSchema.parse(
      await apiJson(daemon, `/api/database/migrations/${migration.operationId}/finalize`, {
        method: 'POST',
        body: '{}',
      }),
    )
    if (finalized.phase !== 'finalized') {
      throw new Error(`large migration did not finalize: ${finalized.phase}`)
    }
    return {
      dataset,
      migration,
      runtimePhases: Object.freeze([sqliteNormal, postgresqlNormal, postgresqlMaintenance]),
      maintenanceJobs,
    }
  } catch (error) {
    // Carry whatever was already measured out with the failure so the report
    // can still show it. Losing 50 minutes of phase evidence to a late step is
    // how a run becomes undiagnosable.
    if (collectedPhases.length > 0 && typeof error === 'object' && error !== null) {
      ;(error as { runtimePhases?: readonly RuntimePhaseReport[] }).runtimePhases = Object.freeze([
        ...collectedPhases,
      ])
    }
    throw error
  } finally {
    if (maintenanceRuntime !== null) await maintenanceRuntime.close().catch(() => undefined)
    if (daemon !== null) await daemon.stop().catch(() => undefined)
    if (args.keepHome) console.log(`[rfc349-pg] preserved large-soak home ${home}`)
    else rmSync(root, { recursive: true, force: true })
  }
}

function runtimePhaseFailures(phase: RuntimePhaseReport): string[] {
  const failures: string[] = []
  if (phase.httpErrors !== 0) failures.push(`${phase.label}: HTTP errors=${phase.httpErrors}`)
  if (phase.timeouts !== 0) failures.push(`${phase.label}: timeouts=${phase.timeouts}`)
  if (phase.websocket.errors !== 0) {
    failures.push(`${phase.label}: WebSocket errors=${phase.websocket.errors}`)
  }
  if (phase.api.maxMs >= HARD_FREEZE_MS) {
    failures.push(`${phase.label}: API max ${phase.api.maxMs.toFixed(1)}ms >= ${HARD_FREEZE_MS}ms`)
  }
  if (phase.foregroundWrites.count === 0) failures.push(`${phase.label}: no foreground writes`)
  if (phase.foregroundWrites.maxMs >= HARD_FREEZE_MS) {
    failures.push(
      `${phase.label}: write max ${phase.foregroundWrites.maxMs.toFixed(1)}ms >= ${HARD_FREEZE_MS}ms`,
    )
  }
  if (phase.websocket.maxGapMs >= HARD_FREEZE_MS) {
    failures.push(
      `${phase.label}: WS max gap ${phase.websocket.maxGapMs.toFixed(1)}ms >= ${HARD_FREEZE_MS}ms`,
    )
  }
  if (phase.eventLoop === null || phase.eventLoop.sampleCount === 0) {
    failures.push(`${phase.label}: no daemon event-loop telemetry`)
  } else if (phase.eventLoop.maxGapMs >= EVENT_LOOP_GAP_MS) {
    failures.push(
      `${phase.label}: event-loop max ${phase.eventLoop.maxGapMs.toFixed(1)}ms >= ${EVENT_LOOP_GAP_MS}ms`,
    )
  }
  if (phase.label !== 'sqlite-normal') {
    if (phase.poolWait === null || phase.poolWait.sampleCount === 0) {
      failures.push(`${phase.label}: no PostgreSQL pool-wait samples`)
    } else if (phase.poolWait.failedCount !== 0) {
      failures.push(
        `${phase.label}: PostgreSQL pool acquisition failures=${phase.poolWait.failedCount}`,
      )
    }
    if (phase.externalPoolProbe === null || phase.externalPoolProbe.count === 0) {
      failures.push(`${phase.label}: no external Bun.SQL pool probe samples`)
    } else if (phase.externalPoolProbe.errors !== 0) {
      failures.push(
        `${phase.label}: external Bun.SQL pool probe errors=${phase.externalPoolProbe.errors}`,
      )
    }
  }
  return failures
}

export function rfc349EvidenceFailures(
  report: Pick<
    EvidenceReport,
    'compiledSmoke' | 'crashMatrix' | 'migration' | 'runtimePhases' | 'maintenanceJobs'
  >,
  expectedCrashPoints: readonly Rfc349CrashPoint[] = RFC349_CRASH_POINTS,
): readonly string[] {
  const failures: string[] = []
  if (report.compiledSmoke !== undefined) {
    if (report.compiledSmoke.healthStatus !== 200) {
      failures.push(`compiled daemon health=${report.compiledSmoke.healthStatus}`)
    }
    if (report.compiledSmoke.runtime.provider !== 'postgresql') {
      failures.push(`compiled daemon provider=${report.compiledSmoke.runtime.provider}`)
    }
    if (
      report.compiledSmoke.databaseTelemetry.provider !== 'postgresql' ||
      report.compiledSmoke.databaseTelemetry.poolWait === null ||
      report.compiledSmoke.databaseTelemetry.poolWait.sampleCount === 0
    ) {
      failures.push('compiled daemon has no production PostgreSQL pool-wait samples')
    }
  }
  if (report.crashMatrix !== undefined) {
    const observed = new Set(report.crashMatrix.map((scenario) => scenario.point))
    for (const point of expectedCrashPoints) {
      if (!observed.has(point)) failures.push(`crash matrix missing ${point}`)
    }
  }
  if (report.migration !== undefined) {
    if (report.migration.statusErrors !== 0) {
      failures.push(`migration status errors=${report.migration.statusErrors}`)
    }
    if (report.migration.status.count === 0) failures.push('migration has no status samples')
    if (report.migration.status.maxMs >= HARD_FREEZE_MS) {
      failures.push(
        `migration status max ${report.migration.status.maxMs.toFixed(1)}ms >= ${HARD_FREEZE_MS}ms`,
      )
    }
    if (report.migration.eventLoopMaxGapMs >= EVENT_LOOP_GAP_MS) {
      failures.push(
        `migration event-loop max ${report.migration.eventLoopMaxGapMs.toFixed(1)}ms >= ${EVENT_LOOP_GAP_MS}ms`,
      )
    }
    if (report.migration.poolWait.sampleCount === 0) {
      failures.push('migration has no production pool-wait samples')
    }
    if (report.migration.poolWait.failedCount !== 0) {
      failures.push(
        `migration PostgreSQL pool acquisition failures=${report.migration.poolWait.failedCount}`,
      )
    }
    if (report.migration.externalPoolProbe.count === 0) {
      failures.push('migration has no external Bun.SQL pool probe samples')
    }
    if (report.migration.externalPoolProbe.errors !== 0) {
      failures.push(
        `migration external pool probe errors=${report.migration.externalPoolProbe.errors}`,
      )
    }
    if (report.migration.finalStatus.phase !== 'accepting-writes') {
      failures.push(`migration phase=${report.migration.finalStatus.phase}`)
    }
  }
  for (const phase of report.runtimePhases ?? []) failures.push(...runtimePhaseFailures(phase))
  for (const job of report.maintenanceJobs ?? []) {
    if (job.state !== 'succeeded') {
      failures.push(`${job.job}: ${job.state}/${job.errorCode ?? 'no-code'}`)
    }
    if (job.slices === 0) failures.push(`${job.job}: no maintenance slice`)
  }
  return Object.freeze(failures)
}

function markdown(report: EvidenceReport): string {
  const lines = [
    '# RFC-349 external PostgreSQL evidence',
    '',
    `- Target SHA: \`${report.targetSha}\``,
    `- Mode: ${report.mode}`,
    `- Native runner: ${report.platform}/${report.arch}`,
    `- External PostgreSQL: ${report.externalPostgresql.host}:${report.externalPostgresql.port}`,
    `- Verdict: **${report.failures.length === 0 ? 'PASS' : 'FAIL'}**`,
  ]
  if (report.compiledSmoke !== undefined) {
    lines.push(
      `- Compiled migration: ${report.compiledSmoke.migrationDurationMs.toFixed(1)}ms; runtime=${report.compiledSmoke.runtime.provider}; pool-wait p95=${report.compiledSmoke.databaseTelemetry.poolWait?.p95Ms.toFixed(1) ?? 'n/a'}ms max=${report.compiledSmoke.databaseTelemetry.poolWait?.maxMs.toFixed(1) ?? 'n/a'}ms; hidden tools=${report.compiledSmoke.hiddenTools.join(', ')}`,
    )
  }
  if (report.crashMatrix !== undefined) {
    lines.push(`- Crash/resume: ${report.crashMatrix.length}/${RFC349_CRASH_POINTS.length} points`)
  }
  if (report.dataset !== undefined) {
    lines.push(
      `- Dataset: ${report.dataset.sourceBytes} bytes / ${report.dataset.totalRows} rows / ${report.dataset.tasks} tasks / ${report.dataset.nodeRuns} node runs / ${report.dataset.events} events`,
    )
  }
  if (report.migration !== undefined) {
    lines.push(
      `- Large migration: ${report.migration.durationMs.toFixed(1)}ms; ${report.migration.rowsCopied} rows; ${report.migration.rowsPerSecond.toFixed(1)} rows/s; status p95=${report.migration.status.p95Ms.toFixed(1)}ms max=${report.migration.status.maxMs.toFixed(1)}ms; event-loop max=${report.migration.eventLoopMaxGapMs.toFixed(1)}ms; pool-wait p95=${report.migration.poolWait.p95Ms.toFixed(1)}ms max=${report.migration.poolWait.maxMs.toFixed(1)}ms; errors=${report.migration.statusErrors}`,
    )
    // 停顿落在哪个阶段——排查一次多秒级冻结时，这一行顶一整轮离线实测。
    for (const stall of report.migration.stalls ?? []) {
      lines.push(`  - stall ${stall.kind} ${stall.ms.toFixed(1)}ms during \`${stall.phase}\``)
    }
  }
  if (report.runtimePhases !== undefined) {
    lines.push(
      '',
      '| phase | clients | API p95 ms | API max ms | WS max gap ms | event-loop max ms | pool wait p95 ms | errors |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    )
    for (const phase of report.runtimePhases) {
      lines.push(
        `| ${phase.label} | ${phase.clients} | ${phase.api.p95Ms.toFixed(1)} | ${phase.api.maxMs.toFixed(1)} | ${phase.websocket.maxGapMs.toFixed(1)} | ${phase.eventLoop?.maxGapMs.toFixed(1) ?? 'n/a'} | ${phase.poolWait?.p95Ms.toFixed(1) ?? 'n/a'} | ${phase.httpErrors + phase.websocket.errors} |`,
      )
    }
  }
  if (report.failures.length > 0) {
    lines.push('', '## Failures', '', ...report.failures.map((failure) => `- ${failure}`))
  }
  return `${lines.join('\n')}\n`
}

function writeReport(path: string, report: EvidenceReport): void {
  mkdirSync(dirname(path), { recursive: true })
  const markdownPath = path.replace(/\.json$/u, '.md')
  const rendered = markdown(report)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(markdownPath, rendered, 'utf8')
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, rendered, 'utf8')
  }
  console.log(rendered)
}

/** Phase reports a failing large-soak carried out with it (see runLargeSoak). */
function salvagedRuntimePhases(error: unknown): { runtimePhases?: readonly RuntimePhaseReport[] } {
  if (typeof error !== 'object' || error === null) return {}
  const phases = (error as { runtimePhases?: readonly RuntimePhaseReport[] }).runtimePhases
  return phases === undefined || phases.length === 0 ? {} : { runtimePhases: phases }
}

export async function runRfc349PostgresqlHostedEvidence(
  args: Rfc349EvidenceArgs = parseRfc349EvidenceArgs(),
): Promise<EvidenceReport> {
  const url = requiredDatabaseUrl()
  const parsedUrl = new URL(url)
  let compiledSmoke: CompiledSmokeReport | undefined
  let crashMatrix: readonly CrashScenarioReport[] | undefined
  let large:
    | {
        readonly dataset: DatasetCounts
        readonly migration: MigrationLoadReport
        readonly runtimePhases: readonly RuntimePhaseReport[]
        readonly maintenanceJobs: readonly MaintenanceJobReport[]
      }
    | undefined
  try {
    if (args.mode === 'compiled-smoke') compiledSmoke = await runCompiledSmoke(args, url)
    if (args.mode === 'crash-matrix' || args.mode === 'crash-and-soak') {
      crashMatrix = await runCrashMatrix(url, args.crashPoints)
    }
    if (args.mode === 'large-soak' || args.mode === 'crash-and-soak') {
      large = await runLargeSoak(args, url)
    }
    const failures = rfc349EvidenceFailures(
      {
        ...(compiledSmoke === undefined ? {} : { compiledSmoke }),
        ...(crashMatrix === undefined ? {} : { crashMatrix }),
        ...(large === undefined
          ? {}
          : {
              migration: large.migration,
              runtimePhases: large.runtimePhases,
              maintenanceJobs: large.maintenanceJobs,
            }),
      },
      args.crashPoints,
    )
    const report: EvidenceReport = Object.freeze({
      version: 1,
      targetSha: currentSha(),
      generatedAt: new Date().toISOString(),
      mode: args.mode,
      platform: process.platform,
      arch: process.arch,
      externalPostgresql: {
        urlEnv: 'RFC349_DATABASE_URL' as const,
        host: parsedUrl.hostname,
        port: parsedUrl.port || '5432',
        serverProcessOutsideBinary: true as const,
      },
      tier: { clients: args.clients, durationMs: args.durationMs, scale: args.scale },
      ...(compiledSmoke === undefined ? {} : { compiledSmoke }),
      ...(crashMatrix === undefined ? {} : { crashMatrix }),
      ...(large === undefined ? {} : large),
      failures,
    })
    writeReport(args.reportPath, report)
    if (failures.length > 0) throw new Error(`RFC-349 evidence failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    const report: EvidenceReport = {
      version: 1,
      targetSha: currentSha(),
      generatedAt: new Date().toISOString(),
      mode: args.mode,
      platform: process.platform,
      arch: process.arch,
      externalPostgresql: {
        urlEnv: 'RFC349_DATABASE_URL',
        host: parsedUrl.hostname,
        port: parsedUrl.port || '5432',
        serverProcessOutsideBinary: true,
      },
      tier: { clients: args.clients, durationMs: args.durationMs, scale: args.scale },
      ...(compiledSmoke === undefined ? {} : { compiledSmoke }),
      ...(crashMatrix === undefined ? {} : { crashMatrix }),
      ...(large === undefined ? salvagedRuntimePhases(error) : large),
      failures: [error instanceof Error ? error.message : String(error)],
    }
    writeReport(args.reportPath, report)
    throw error
  }
}

if (import.meta.main) await runRfc349PostgresqlHostedEvidence()
