// RFC-338 AC-11 — real-socket large-database maintenance responsiveness gate.
//
// The regular workflow runs 50 mixed clients; the scheduled tier runs 100.
// Both reuse RFC-311's seed (100k tasks / 3M node runs / ~10M events), boot
// the separately compiled daemon, open one real WebSocket per client, and
// compare control vs maintenance windows while every cleanup owner is queued.

import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  HEAVY_MAINTENANCE_JOB_KEYS,
  maintenanceJobSpec,
} from '../packages/backend/src/platform/background/maintenanceCatalog'
import { openDb } from '../packages/backend/src/db/client'
import { createMaintenanceRunStore } from '../packages/backend/src/platform/persistence/sqlite/maintenanceRunStore'
import {
  MaintenanceStatusSchema,
  type MaintenanceJobKey,
  type MaintenanceStatus,
} from '../packages/shared/src/index'
import {
  defaultBinaryPath,
  startDaemon,
  type DaemonHandle,
  type DaemonProcessDiagnostics,
} from '../e2e/harness'

interface Args {
  readonly clients: number
  readonly durationMs: number
  readonly clientPauseMs: number
  readonly scale: 'full' | 'small'
  readonly reportPath: string
  readonly binary: string
  readonly keepHome: boolean
}

interface DatasetCounts {
  readonly tasks: number
  readonly nodeRuns: number
  readonly events: number
  readonly webhookDeliveries: number
  readonly cachedRepos: number
  readonly dbBytes: number
}

interface DatasetPreparation {
  readonly tasksTerminalized: number
  readonly nodeRunsTerminalized: number
  readonly elapsedMs: number
}

interface LatencyStats {
  readonly count: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
}

interface PhaseReport {
  readonly label: 'control' | 'maintenance'
  readonly durationMs: number
  readonly clients: number
  readonly api: LatencyStats
  readonly reads: LatencyStats
  readonly foregroundWrites: LatencyStats
  readonly routes: Readonly<Record<string, LatencyStats>>
  readonly httpErrors: number
  readonly timeouts: number
  readonly firstErrors: readonly string[]
  readonly websocket: {
    readonly connections: number
    readonly messages: number
    readonly errors: number
    readonly maxGapMs: number
  }
  readonly eventLoop: MaintenanceStatus['eventLoop'] | null
  readonly processMemory: {
    readonly samples: number
    readonly lastRssMib: number | null
    readonly maxRssMib: number | null
  }
  readonly daemon: DaemonProcessDiagnostics
}

interface TimingSummary {
  readonly count: number
  readonly maxMs: number
  readonly le50Ratio: number
  readonly le250Ratio: number
  readonly p95UpperBoundMs: 50 | 250 | null
}

interface JobReport {
  readonly runId: string
  readonly job: MaintenanceJobKey
  readonly state: string
  readonly slices: number
  readonly counters: Readonly<Record<string, number>>
  readonly elapsedMs: number
  readonly workUnits: number
  readonly throughputPerSecond: number
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

interface SocketProbe {
  readonly socket: WebSocket
  messages: number
  errors: number
  lastMessageAt: number
  maxGapMs: number
  intentionalClose: boolean
  pingTimer: ReturnType<typeof setInterval> | null
  nextNonce: number
}

const ROOT = resolve(import.meta.dir, '..')
const MIGRATIONS = resolve(ROOT, 'packages', 'backend', 'db', 'migrations')
const HARD_FREEZE_MS = 1_000
const EVENT_LOOP_GAP_MS = 500

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index < 0 ? undefined : argv[index + 1]
  }
  const integer = (name: string, fallback: number, minimum: number): number => {
    const parsed = Number(flag(name) ?? fallback)
    if (!Number.isInteger(parsed) || parsed < minimum) {
      throw new Error(`--${name} must be an integer >= ${minimum}`)
    }
    return parsed
  }
  const scaleRaw = flag('scale') ?? (argv.includes('--small') ? 'small' : 'full')
  if (scaleRaw !== 'full' && scaleRaw !== 'small') {
    throw new Error('--scale must be full or small')
  }
  return {
    clients: integer('clients', 50, 1),
    durationMs: integer('duration-seconds', 60, 5) * 1_000,
    clientPauseMs: integer('client-pause-ms', 100, 0),
    scale: scaleRaw,
    reportPath: resolve(flag('report') ?? 'test-results/rfc338-maintenance-soak.json'),
    binary: resolve(flag('binary') ?? defaultBinaryPath()),
    keepHome: argv.includes('--keep-home'),
  }
}

function currentSha(): string {
  const configured = process.env.RFC338_TARGET_SHA ?? process.env.GITHUB_SHA
  if (configured !== undefined && configured !== '') return configured
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT })
  if (result.exitCode !== 0) return 'unknown'
  return result.stdout.toString().trim()
}

function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) return 0
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[
    Math.min(ordered.length - 1, Math.max(0, Math.ceil(quantile * ordered.length) - 1))
  ]!
}

function stats(samples: readonly number[]): LatencyStats {
  return {
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: samples.length === 0 ? 0 : Math.max(...samples),
  }
}

function processRssMib(pid: number): number | null {
  if (process.platform !== 'linux') return null
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8')
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu)
    return match === null ? null : Number(match[1]) / 1024
  } catch {
    return null
  }
}

async function runSeed(dbPath: string, scale: Args['scale']): Promise<void> {
  const command = [
    process.execPath,
    'run',
    resolve(ROOT, 'scripts', 'perf-seed.ts'),
    '--db',
    dbPath,
    ...(scale === 'small' ? ['--small'] : []),
  ]
  const child = Bun.spawn(command, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`perf seed exited ${code}`)
}

function queryCount(raw: Database, table: string): number {
  const row = raw.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

function datasetCounts(dbPath: string): DatasetCounts {
  const raw = new Database(dbPath, { readonly: true })
  try {
    return {
      tasks: queryCount(raw, 'tasks'),
      nodeRuns: queryCount(raw, 'node_runs'),
      events: queryCount(raw, 'node_run_events'),
      webhookDeliveries: queryCount(raw, 'webhook_deliveries'),
      cachedRepos: queryCount(raw, 'cached_repos'),
      dbBytes: statSync(dbPath).size,
    }
  } finally {
    raw.close()
  }
}

function prepareSoakDataset(dbPath: string): DatasetPreparation {
  // RFC-311's capacity fixture deliberately leaves 2/7 rows pending/running.
  // Reaping ~857k synthetic runs one by one is a separate cold-recovery
  // benchmark and can consume minutes before HTTP binds. Terminalize only that
  // synthetic population offline so this gate measures RFC-338 maintenance
  // over the same row counts. Cold-start time remains explicit in the report.
  const raw = new Database(dbPath)
  const startedAt = performance.now()
  try {
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; BEGIN IMMEDIATE;')
    const nodeRuns = raw
      .query(
        `UPDATE node_runs
            SET status = 'done',
                finished_at = coalesce(finished_at, started_at, ?),
                exit_code = coalesce(exit_code, 0),
                pid = NULL
          WHERE status IN ('running', 'pending')`,
      )
      .run(Date.now())
    const tasks = raw
      .query(
        `UPDATE tasks
            SET status = 'done',
                finished_at = coalesce(finished_at, started_at, ?)
          WHERE status IN ('running', 'pending')`,
      )
      .run(Date.now())
    raw.exec('COMMIT;')
    return {
      tasksTerminalized: tasks.changes,
      nodeRunsTerminalized: nodeRuns.changes,
      elapsedMs: performance.now() - startedAt,
    }
  } catch (error) {
    try {
      raw.exec('ROLLBACK;')
    } catch {
      // Preserve the original preparation failure.
    }
    throw error
  } finally {
    raw.close()
  }
}

async function maintenanceStatus(daemon: DaemonHandle): Promise<MaintenanceStatus> {
  const response = await fetch(`${daemon.baseUrl}/api/maintenance/status`, {
    headers: { authorization: `Bearer ${daemon.token}` },
    signal: AbortSignal.timeout(5_000),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(
      `maintenance status returned ${response.status}${body === '' ? '' : ` ${body.replace(/\s+/gu, ' ').slice(0, 240)}`}`,
    )
  }
  return MaintenanceStatusSchema.parse(JSON.parse(body))
}

async function observeMaintenanceStatus(daemon: DaemonHandle): Promise<{
  readonly status: MaintenanceStatus | null
  readonly errors: readonly string[]
}> {
  const errors: string[] = []
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return { status: await maintenanceStatus(daemon), errors }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      if (attempt < 9) await Bun.sleep(100)
    }
  }
  return { status: null, errors }
}

async function waitForBootMaintenance(daemon: DaemonHandle): Promise<void> {
  // Heavy schedule catch-up has a deliberate 30-second boot delay and
  // lifecycleInvariants uses five seconds. Wait past both before declaring the
  // control window clean, then require the durable queue to drain (or fail
  // loudly with its projection). Config makes this catch-up a no-op; the
  // maintenance phase below queues the measured payloads explicitly.
  await Bun.sleep(31_000)
  const deadline = Date.now() + 120_000
  let latest: MaintenanceStatus | null = null
  let lastStatusError: string | null = null
  while (Date.now() < deadline) {
    try {
      latest = await maintenanceStatus(daemon)
      lastStatusError = null
    } catch (error) {
      lastStatusError = error instanceof Error ? error.message : String(error)
      await Bun.sleep(250)
      continue
    }
    const failed = latest.backlog.filter((row) => row.state === 'failed')
    if (failed.length > 0) throw new Error(`boot maintenance failed: ${JSON.stringify(failed)}`)
    if (
      latest.worker.state === 'ready' &&
      latest.active === null &&
      latest.backlog.every((row) => row.state === 'failed')
    ) {
      return
    }
    await Bun.sleep(250)
  }
  throw new Error(`boot maintenance did not drain: ${JSON.stringify({ latest, lastStatusError })}`)
}

function candidateTaskIds(taskCount: number): string[] {
  return Array.from(
    { length: taskCount },
    (_, index) => `perftask${String(index).padStart(7, '0')}`,
  )
}

async function openSocketProbe(daemon: DaemonHandle): Promise<SocketProbe> {
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
    lastMessageAt: startedAt,
    maxGapMs: 0,
    intentionalClose: false,
    pingTimer: null,
    nextNonce: 0,
  }
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error('websocket hello timeout')), 5_000)
    socket.addEventListener('message', (event) => {
      let frame: unknown
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (
        frame === null ||
        typeof frame !== 'object' ||
        (frame as { type?: unknown }).type !== 'pong'
      ) {
        if (probe.messages === 0) {
          clearTimeout(timeout)
          resolveOpen()
        }
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
      if (!probe.intentionalClose) probe.errors += 1
    })
  })
  probe.lastMessageAt = performance.now()
  probe.pingTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'ping', nonce: probe.nextNonce++ }))
  }, 250)
  return probe
}

async function runPhase(input: {
  readonly label: PhaseReport['label']
  readonly daemon: DaemonHandle
  readonly args: Args
  readonly taskIds: readonly string[]
  readonly beforeRequests?: () => Promise<void> | void
}): Promise<PhaseReport> {
  console.log(`[maintenance-soak] ${input.label}: opening ${input.args.clients} WebSockets`)
  const sockets = await Promise.all(
    Array.from({ length: input.args.clients }, () => openSocketProbe(input.daemon)),
  )
  await input.beforeRequests?.()

  const apiSamples: number[] = []
  const readSamples: number[] = []
  const writeSamples: number[] = []
  const routeSamples = new Map<string, number[]>()
  const rssSamples: number[] = []
  const firstErrors: string[] = []
  let httpErrors = 0
  let timeouts = 0
  let taskCursor = 0
  const startedAt = Date.now()
  const deadline = startedAt + input.args.durationMs
  const headers = { authorization: `Bearer ${input.daemon.token}` }
  const readPaths = [
    '/api/tasks?limit=50',
    '/api/tasks?limit=50&status=running',
    '/api/cached-repos?limit=50',
    '/api/overview',
  ] as const
  const sampleRss = (): void => {
    const rss = processRssMib(input.daemon.pid)
    if (rss !== null) rssSamples.push(rss)
  }
  sampleRss()
  const rssTimer = setInterval(sampleRss, 1_000)

  const request = async (
    path: string,
    method: 'GET' | 'PUT',
    write: boolean,
    body?: string,
  ): Promise<void> => {
    const beganAt = performance.now()
    const routeKey = `${method} ${path.replace(/\/perftask\d{7}(?=\/|$)/u, '/:taskId')}`
    try {
      const response = await fetch(`${input.daemon.baseUrl}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(5_000),
      })
      const responseBody = await response.text()
      const elapsed = performance.now() - beganAt
      apiSamples.push(elapsed)
      ;(write ? writeSamples : readSamples).push(elapsed)
      const samples = routeSamples.get(routeKey) ?? []
      samples.push(elapsed)
      routeSamples.set(routeKey, samples)
      if (response.status !== 200) {
        httpErrors += 1
        if (firstErrors.length < 10) {
          const detail = responseBody.replace(/\s+/gu, ' ').slice(0, 240)
          firstErrors.push(
            `${method} ${path} -> ${response.status}${detail === '' ? '' : ` ${detail}`}`,
          )
        }
      }
    } catch (error) {
      const elapsed = performance.now() - beganAt
      apiSamples.push(elapsed)
      ;(write ? writeSamples : readSamples).push(elapsed)
      const samples = routeSamples.get(routeKey) ?? []
      samples.push(elapsed)
      routeSamples.set(routeKey, samples)
      httpErrors += 1
      if (error instanceof DOMException && error.name === 'TimeoutError') timeouts += 1
      if (firstErrors.length < 10) {
        firstErrors.push(`${method} ${path} -> ${error instanceof Error ? error.message : error}`)
      }
    }
  }

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
            true,
            JSON.stringify({ members: [] }),
          )
        } else if (iteration % 5 === 4) {
          const detailIndex =
            (clientIndex * 97 + iteration * 13) % Math.max(1, input.taskIds.length)
          const taskId = input.taskIds[detailIndex] ?? 'perftask0000000'
          await request(`/api/tasks/${encodeURIComponent(taskId)}`, 'GET', false)
        } else {
          await request(readPaths[(clientIndex + iteration) % readPaths.length]!, 'GET', false)
        }
        iteration += 1
        if (input.args.clientPauseMs > 0) await Bun.sleep(input.args.clientPauseMs)
      }
    }),
  )

  clearInterval(rssTimer)
  const endedAt = performance.now()
  const statusObservation = await observeMaintenanceStatus(input.daemon)
  httpErrors += statusObservation.errors.length
  for (const error of statusObservation.errors) {
    if (firstErrors.length < 10) firstErrors.push(`GET /api/maintenance/status -> ${error}`)
  }
  for (const probe of sockets) {
    probe.maxGapMs = Math.max(probe.maxGapMs, endedAt - probe.lastMessageAt)
    probe.intentionalClose = true
    if (probe.pingTimer !== null) clearInterval(probe.pingTimer)
    probe.socket.close()
  }
  const report: PhaseReport = {
    label: input.label,
    durationMs: Date.now() - startedAt,
    clients: input.args.clients,
    api: stats(apiSamples),
    reads: stats(readSamples),
    foregroundWrites: stats(writeSamples),
    routes: Object.fromEntries(
      [...routeSamples.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([route, samples]) => [route, stats(samples)]),
    ),
    httpErrors,
    timeouts,
    firstErrors,
    websocket: {
      connections: sockets.length,
      messages: sockets.reduce((sum, probe) => sum + probe.messages, 0),
      errors: sockets.reduce((sum, probe) => sum + probe.errors, 0),
      maxGapMs: sockets.reduce((maximum, probe) => Math.max(maximum, probe.maxGapMs), 0),
    },
    eventLoop: statusObservation.status?.eventLoop ?? null,
    processMemory: {
      samples: rssSamples.length,
      lastRssMib: rssSamples.at(-1) ?? null,
      maxRssMib: rssSamples.length === 0 ? null : Math.max(...rssSamples),
    },
    daemon: input.daemon.diagnostics(),
  }
  console.log(
    `[maintenance-soak] ${input.label}: api p95=${report.api.p95Ms.toFixed(1)}ms ` +
      `max=${report.api.maxMs.toFixed(1)}ms writeMax=${report.foregroundWrites.maxMs.toFixed(1)}ms ` +
      `wsMaxGap=${report.websocket.maxGapMs.toFixed(1)}ms ` +
      `eventLoopMax=${report.eventLoop?.maxGapMs.toFixed(1) ?? 'n/a'}ms errors=${httpErrors}`,
  )
  return report
}

function heavyPayloads(expectedEvents: number): Record<string, Readonly<Record<string, unknown>>> {
  return {
    worktreeGc: { worktreeAutoGc: { enabled: false }, activeTaskIds: [] },
    webhookDeliveryGc: { bodyRetentionDays: 1, rowRetentionDays: 1 },
    eventsArchive: {
      eventsArchiveThresholds: {
        perNodeRunRows: 50_000,
        globalRows: Math.max(1_000, Math.floor(expectedEvents / 10)),
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

function enqueueMaintenance(
  store: ReturnType<typeof createMaintenanceRunStore>,
  expectedEvents: number,
): Array<{ runId: string; job: MaintenanceJobKey }> {
  const runTag = randomUUID()
  const now = Date.now()
  const payloads = heavyPayloads(expectedEvents)
  const jobs = [...HEAVY_MAINTENANCE_JOB_KEYS, 'walCheckpoint'] as const
  return jobs.map((job, index) => {
    const runId = randomUUID()
    const spec = maintenanceJobSpec(job)
    const receipt = store.enqueue({
      id: runId,
      jobKey: job,
      jobClass: spec.class,
      slotKey: `soak:${runTag}:${job}`,
      cycleKey: `soak:${runTag}`,
      payload: job === 'walCheckpoint' ? {} : payloads[job]!,
      scheduledAt: now,
      now: now + index,
    })
    if (!receipt.inserted) throw new Error(`soak run for ${job} was unexpectedly coalesced`)
    return { runId, job }
  })
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

function jobReports(
  dbPath: string,
  queued: readonly { runId: string; job: MaintenanceJobKey }[],
): JobReport[] {
  const raw = new Database(dbPath, { readonly: true })
  try {
    const query = raw.query(
      `SELECT state, slice_no, counters_json, error_code, error_message,
              scheduled_at, started_at, finished_at, updated_at
         FROM maintenance_runs WHERE id = ?`,
    )
    return queued.map(({ runId, job }) => {
      const row = query.get(runId) as {
        state: string
        slice_no: number
        counters_json: string
        error_code: string | null
        error_message: string | null
        scheduled_at: number
        started_at: number | null
        finished_at: number | null
        updated_at: number
      } | null
      if (row === null) throw new Error(`missing maintenance run ${runId}`)
      const counters = parseCounters(row.counters_json)
      const workUnits = Object.entries(counters)
        .filter(
          ([key]) =>
            key !== 'countedRows' && !/^(worker|dbStatement|dbTransaction|sqliteBusy)/.test(key),
        )
        .reduce((sum, [, value]) => sum + Math.max(0, value), 0)
      const elapsedMs = Math.max(
        1,
        (row.finished_at ?? row.updated_at) - (row.started_at ?? row.scheduled_at),
      )
      return {
        runId,
        job,
        state: row.state,
        slices: row.slice_no,
        counters,
        elapsedMs,
        workUnits,
        throughputPerSecond: (workUnits * 1_000) / elapsedMs,
        errorCode: row.error_code,
        errorMessage: row.error_message,
      }
    })
  } finally {
    raw.close()
  }
}

function summarizeTiming(
  jobs: readonly JobReport[],
  prefix: 'dbStatement' | 'dbTransaction',
): TimingSummary {
  const count = jobs.reduce((sum, job) => sum + (job.counters[`${prefix}Count`] ?? 0), 0)
  const le50 = jobs.reduce((sum, job) => sum + (job.counters[`${prefix}Le50Ms`] ?? 0), 0)
  const le250 = jobs.reduce((sum, job) => sum + (job.counters[`${prefix}Le250Ms`] ?? 0), 0)
  const maxMs = jobs.reduce(
    (maximum, job) => Math.max(maximum, job.counters[`${prefix}MsMax`] ?? 0),
    0,
  )
  const le50Ratio = count === 0 ? 1 : le50 / count
  const le250Ratio = count === 0 ? 1 : le250 / count
  return {
    count,
    maxMs,
    le50Ratio,
    le250Ratio,
    p95UpperBoundMs: le50Ratio >= 0.95 ? 50 : le250Ratio >= 0.95 ? 250 : null,
  }
}

function phaseFailures(phase: PhaseReport): string[] {
  const failures: string[] = []
  if (phase.daemon.exitCode !== null || phase.daemon.signalCode !== null) {
    failures.push(
      `${phase.label}: daemon exited code=${phase.daemon.exitCode ?? 'null'} signal=${phase.daemon.signalCode ?? 'null'}`,
    )
  }
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
      `${phase.label}: foreground write max ${phase.foregroundWrites.maxMs.toFixed(1)}ms >= ${HARD_FREEZE_MS}ms`,
    )
  }
  if (phase.websocket.maxGapMs >= HARD_FREEZE_MS) {
    failures.push(
      `${phase.label}: WebSocket max gap ${phase.websocket.maxGapMs.toFixed(1)}ms >= ${HARD_FREEZE_MS}ms`,
    )
  }
  if (phase.eventLoop === null || phase.eventLoop.sampleCount === 0) {
    failures.push(`${phase.label}: no daemon event-loop samples`)
  } else if (phase.eventLoop.maxGapMs >= EVENT_LOOP_GAP_MS) {
    failures.push(
      `${phase.label}: event-loop max gap ${phase.eventLoop.maxGapMs.toFixed(1)}ms >= ${EVENT_LOOP_GAP_MS}ms`,
    )
  }
  return failures
}

function markdown(report: {
  targetSha: string
  args: Args
  before: DatasetCounts
  after: DatasetCounts
  control: PhaseReport
  maintenance: PhaseReport
  statements: TimingSummary
  transactions: TimingSummary
  jobs: readonly JobReport[]
  failures: readonly string[]
  preparation: DatasetPreparation
  coldStartMs: number
}): string {
  const row = (phase: PhaseReport): string =>
    `| ${phase.label} | ${phase.api.p50Ms.toFixed(1)} | ${phase.api.p95Ms.toFixed(1)} | ${phase.api.maxMs.toFixed(1)} | ${phase.foregroundWrites.maxMs.toFixed(1)} | ${phase.websocket.maxGapMs.toFixed(1)} | ${phase.eventLoop?.maxGapMs.toFixed(1) ?? 'n/a'} | ${phase.httpErrors} |`
  return (
    `# RFC-338 maintenance soak\n\n` +
    `- Target SHA: \`${report.targetSha}\`\n` +
    `- Tier: ${report.args.clients} clients, ${report.args.scale} seed, ${(report.args.durationMs / 1_000).toFixed(0)}s per phase\n` +
    `- Dataset: ${report.before.tasks} tasks / ${report.before.nodeRuns} node runs / ${report.before.events} events / ${report.before.webhookDeliveries} webhook deliveries / ${report.before.cachedRepos} repos\n` +
    `- Fixture prep: ${report.preparation.tasksTerminalized} synthetic tasks + ${report.preparation.nodeRunsTerminalized} synthetic node runs terminalized offline in ${report.preparation.elapsedMs.toFixed(1)}ms\n` +
    `- Cold start to authenticated ready: ${report.coldStartMs.toFixed(1)}ms\n` +
    `- Daemon RSS: control max=${report.control.processMemory.maxRssMib?.toFixed(1) ?? 'n/a'} MiB; maintenance max=${report.maintenance.processMemory.maxRssMib?.toFixed(1) ?? 'n/a'} MiB\n` +
    `- Daemon terminal state: code=${report.maintenance.daemon.exitCode ?? 'running'}, signal=${report.maintenance.daemon.signalCode ?? 'none'}\n` +
    `- Verdict: **${report.failures.length === 0 ? 'PASS' : 'FAIL'}**\n\n` +
    `| phase | API p50 ms | API p95 ms | API max ms | write max ms | WS max gap ms | event-loop max gap ms | errors |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n` +
    `${row(report.control)}\n${row(report.maintenance)}\n\n` +
    `SQLite statements: count=${report.statements.count}, p95<=${report.statements.p95UpperBoundMs ?? '>250'}ms, max=${report.statements.maxMs.toFixed(1)}ms. ` +
    `Explicit transactions: count=${report.transactions.count}, p95<=${report.transactions.p95UpperBoundMs ?? '>250'}ms, max=${report.transactions.maxMs.toFixed(1)}ms.\n\n` +
    `Backlog delta: events ${report.before.events} -> ${report.after.events}; webhook deliveries ${report.before.webhookDeliveries} -> ${report.after.webhookDeliveries}.\n\n` +
    `## Jobs\n\n` +
    `| job | state | slices | work units | throughput/s | busy deferrals |\n| --- | --- | ---: | ---: | ---: | ---: |\n` +
    report.jobs
      .map(
        (job) =>
          `| ${job.job} | ${job.state} | ${job.slices} | ${job.workUnits} | ${job.throughputPerSecond.toFixed(1)} | ${job.counters.sqliteBusyDeferrals ?? 0} |`,
      )
      .join('\n') +
    (report.failures.length === 0
      ? '\n'
      : `\n\n## Failures\n\n${report.failures.map((failure) => `- ${failure}`).join('\n')}\n`)
  )
}

async function main(): Promise<void> {
  const args = parseArgs()
  const targetSha = currentSha()
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc338-soak-'))
  const home = join(root, 'home')
  const dbPath = join(home, 'db.sqlite')
  const now = new Date(Date.now() + 12 * 60 * 60_000)
  const dailyAt = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
  const configOverrides = {
    maintenanceSchedule: { kind: 'daily', at: dailyAt, timezone: 'UTC' },
    eventsArchiveThresholds: {
      perNodeRunRows: 1_000_000_000,
      globalRows: 1_000_000_000,
      // The capacity fixture's payload bytes exceed the production byte
      // watermark long before its row watermark. Disable both byte dimensions
      // only for boot catch-up; the measured phase enqueues its own low row
      // threshold and therefore still archives real rows.
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
  let probeDb: ReturnType<typeof openDb> | null = null
  try {
    console.log(`[maintenance-soak] target=${targetSha} binary=${args.binary}`)
    console.log('[maintenance-soak] initializing durable home')
    daemon = await startDaemon({ binary: args.binary, home, configOverrides })
    await daemon.stop()
    daemon = null

    await runSeed(dbPath, args.scale)
    const preparation = prepareSoakDataset(dbPath)
    const before = datasetCounts(dbPath)
    console.log(
      `[maintenance-soak] seeded ${JSON.stringify(before)} preparation=${JSON.stringify(preparation)}`,
    )

    const coldStartBeganAt = performance.now()
    daemon = await startDaemon({
      binary: args.binary,
      home,
      configOverrides,
      readyTimeoutMs: args.scale === 'full' ? 300_000 : 30_000,
    })
    const coldStartMs = performance.now() - coldStartBeganAt
    await waitForBootMaintenance(daemon)
    const taskIds = candidateTaskIds(before.tasks)
    const split = Math.floor(taskIds.length / 2)
    const control = await runPhase({
      label: 'control',
      daemon,
      args,
      taskIds: taskIds.slice(0, split),
    })

    probeDb = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipMigrations: true,
      skipIntegrityCheck: true,
      busyTimeoutMs: 5_000,
      slowQueryMs: 0,
    })
    const store = createMaintenanceRunStore(probeDb)
    let queued: Array<{ runId: string; job: MaintenanceJobKey }> = []
    const maintenance = await runPhase({
      label: 'maintenance',
      daemon,
      args,
      taskIds: taskIds.slice(split),
      beforeRequests: () => {
        queued = enqueueMaintenance(store, before.events)
        console.log(`[maintenance-soak] queued ${queued.length} maintenance jobs`)
      },
    })
    const jobs = jobReports(dbPath, queued)
    const after = datasetCounts(dbPath)
    const statements = summarizeTiming(jobs, 'dbStatement')
    const transactions = summarizeTiming(jobs, 'dbTransaction')
    const failures = [
      ...phaseFailures(control),
      ...phaseFailures(maintenance),
      ...jobs
        .filter((job) => job.state === 'failed')
        .map((job) => `${job.job}: ${job.errorCode ?? 'failed'} ${job.errorMessage ?? ''}`.trim()),
    ]
    if (jobs.every((job) => job.slices === 0)) failures.push('no maintenance job completed a slice')
    if (statements.count === 0) failures.push('no Worker SQLite statement timings recorded')
    if (statements.le50Ratio < 0.95) {
      failures.push(
        `SQLite statement p95 exceeded 50ms (${(statements.le50Ratio * 100).toFixed(1)}% <=50ms)`,
      )
    }
    if (statements.maxMs >= 250) {
      failures.push(`SQLite statement max ${statements.maxMs.toFixed(1)}ms >= 250ms`)
    }
    if (transactions.count > 0 && transactions.le50Ratio < 0.95) {
      failures.push(
        `SQLite transaction p95 exceeded 50ms (${(transactions.le50Ratio * 100).toFixed(1)}% <=50ms)`,
      )
    }
    if (transactions.maxMs >= 250) {
      failures.push(`SQLite transaction max ${transactions.maxMs.toFixed(1)}ms >= 250ms`)
    }

    const report = {
      version: 1,
      generatedAt: new Date().toISOString(),
      targetSha,
      tier: { clients: args.clients, scale: args.scale, durationMs: args.durationMs },
      thresholds: {
        wholeSiteFreezeMs: HARD_FREEZE_MS,
        eventLoopGapMs: EVENT_LOOP_GAP_MS,
        sqliteP95Ms: 50,
        sqliteMaxMs: 250,
      },
      dataset: { before, after, preparation, coldStartMs },
      phases: { control, maintenance },
      sqlite: { statements, transactions },
      jobs,
      verdict: { ok: failures.length === 0, failures },
    }
    const md = markdown({
      targetSha,
      args,
      before,
      after,
      control,
      maintenance,
      statements,
      transactions,
      jobs,
      failures,
      preparation,
      coldStartMs,
    })
    mkdirSync(dirname(args.reportPath), { recursive: true })
    writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    writeFileSync(args.reportPath.replace(/\.json$/u, '.md'), md, 'utf-8')
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, md, 'utf-8')
    }
    console.log(md)
    if (failures.length > 0) throw new Error(`RFC-338 soak failed: ${failures.join('; ')}`)
  } finally {
    if (probeDb !== null) {
      ;(probeDb as unknown as { $client: { close(): void } }).$client.close()
    }
    if (daemon !== null) await daemon.stop().catch(() => undefined)
    if (args.keepHome) console.log(`[maintenance-soak] preserved home ${home}`)
    else rmSync(root, { recursive: true, force: true })
  }
}

await main()
