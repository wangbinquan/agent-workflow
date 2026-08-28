// RFC-338 — long-lived maintenance Worker entrypoint. It owns a separate
// bun:sqlite connection and serializes every heavy/recovery/checkpoint job.
// There is intentionally no fallback that runs a failed Worker job on main.

import { MaintenanceJobKeySchema } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import { openDb, type DbClient } from '@/db/client'
import { retryableSqliteWriteErrorCode } from '@/db/sqliteWriteRetry'
import { composeDevelopmentAutomationMaintenanceCommands } from '@/modules/development-automation/composition'
import { composeDigitalEmployeeMaintenanceCommands } from '@/modules/digital-employee/composition'
import {
  createMaintenanceRunStore,
  type ClaimedMaintenanceRun,
  type MaintenanceRunStore,
} from '@/platform/persistence/sqlite/maintenanceRunStore'
import { MAINTENANCE_CATALOG_DIGEST } from './maintenanceCatalog'
import { runMaintenanceJob } from './maintenanceJobRunner'
import { installMaintenanceWorkerErrorBoundary } from './maintenanceWorkerErrorBoundary'
import {
  MAINTENANCE_PROTOCOL_VERSION,
  MaintenanceWorkerRequestSchema,
  type MaintenanceWorkerEvent,
} from './maintenanceProtocol'

declare const self: Worker

const LEASE_MS = 60 * 60 * 1_000
const IDLE_POLL_MS = 1_000
const HEARTBEAT_MS = 5_000
const MAX_BUSY_BACKOFF_MS = 30_000
const CLEANUP_COOLDOWN_MS = 25

let db: DbClient | null = null
let developmentAutomationMaintenance: ReturnType<
  typeof composeDevelopmentAutomationMaintenanceCommands
> | null = null
let digitalEmployeeMaintenance: ReturnType<
  typeof composeDigitalEmployeeMaintenanceCommands
> | null = null
let appHome = ''
let processing = false
let draining = false
let active: { runId: string; leaseToken: string } | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let statementTimings: TimingHistogram | null = null
let transactionTimings: TimingHistogram | null = null

interface TimingHistogram {
  count: number
  totalMs: number
  maxMs: number
  le10: number
  le50: number
  le250: number
}

function emptyTimingHistogram(): TimingHistogram {
  return { count: 0, totalMs: 0, maxMs: 0, le10: 0, le50: 0, le250: 0 }
}

function recordTiming(histogram: TimingHistogram | null, ms: number): void {
  if (histogram === null) return
  histogram.count += 1
  histogram.totalMs += ms
  histogram.maxMs = Math.max(histogram.maxMs, ms)
  if (ms <= 10) histogram.le10 += 1
  if (ms <= 50) histogram.le50 += 1
  if (ms <= 250) histogram.le250 += 1
}

function timingCounters(
  prefix: 'dbStatement' | 'dbTransaction',
  histogram: TimingHistogram,
): Record<string, number> {
  return {
    [`${prefix}Count`]: histogram.count,
    [`${prefix}MsTotal`]: histogram.totalMs,
    [`${prefix}MsMax`]: histogram.maxMs,
    [`${prefix}Le10Ms`]: histogram.le10,
    [`${prefix}Le50Ms`]: histogram.le50,
    [`${prefix}Le250Ms`]: histogram.le250,
  }
}

function emit(event: MaintenanceWorkerEvent): void {
  postMessage(event)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

installMaintenanceWorkerErrorBoundary({
  target: self,
  onFatal: (error) => {
    emit({
      type: 'degraded',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at: Date.now(),
      error,
    })
  },
})

function isSqliteBusy(error: unknown): boolean {
  return retryableSqliteWriteErrorCode(error) !== undefined
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('maintenance-ledger-json-object-invalid')
  }
  return parsed as Record<string, unknown>
}

function parseCounters(value: string): Record<string, number> {
  const parsed = parseJsonObject(value)
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  )
}

function addCounters(
  before: Readonly<Record<string, number>>,
  delta: Readonly<Record<string, number>>,
): Record<string, number> {
  const next = { ...before }
  for (const [key, value] of Object.entries(delta)) {
    next[key] = key.endsWith('MsMax') ? Math.max(next[key] ?? 0, value) : (next[key] ?? 0) + value
  }
  return next
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function busyBackoffMs(attempt: number): number {
  return Math.min(MAX_BUSY_BACKOFF_MS, 250 * 2 ** Math.min(8, Math.max(0, attempt)))
}

async function claimNextWithBusyBackoff(
  store: MaintenanceRunStore,
  input: Parameters<MaintenanceRunStore['claimNext']>[0],
): Promise<{ claimed: ClaimedMaintenanceRun | null; busyDeferrals: number }> {
  let busyDeferrals = 0
  for (;;) {
    if (draining) return { claimed: null, busyDeferrals }
    try {
      return { claimed: store.claimNext(input), busyDeferrals }
    } catch (error) {
      if (!isSqliteBusy(error)) throw error
      await delay(busyBackoffMs(busyDeferrals))
      busyDeferrals += 1
    }
  }
}

async function settleWithBusyBackoff(
  store: MaintenanceRunStore,
  input: Parameters<MaintenanceRunStore['settle']>[0] & {
    readonly counters: Readonly<Record<string, number>>
  },
): Promise<{ settled: boolean; counters: Record<string, number> }> {
  let busyDeferrals = 0
  for (;;) {
    const counters = addCounters(
      input.counters,
      busyDeferrals === 0 ? {} : { sqliteBusyDeferrals: busyDeferrals },
    )
    try {
      return { settled: store.settle({ ...input, counters }), counters }
    } catch (error) {
      if (!isSqliteBusy(error)) throw error
      await delay(busyBackoffMs(busyDeferrals))
      busyDeferrals += 1
    }
  }
}

function closeConnection(): void {
  if (pollTimer !== null) clearInterval(pollTimer)
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  pollTimer = null
  heartbeatTimer = null
  const current = db
  db = null
  developmentAutomationMaintenance = null
  digitalEmployeeMaintenance = null
  ;(current as unknown as { $client?: { close(): void } } | null)?.$client?.close()
}

async function drainIfReady(): Promise<void> {
  if (!draining || processing) return
  closeConnection()
  emit({
    type: 'drained',
    version: MAINTENANCE_PROTOCOL_VERSION,
    at: Date.now(),
  })
}

async function processQueue(): Promise<void> {
  const currentDb = db
  const currentDevelopmentAutomationMaintenance = developmentAutomationMaintenance
  const currentDigitalEmployeeMaintenance = digitalEmployeeMaintenance
  if (
    currentDb === null ||
    currentDevelopmentAutomationMaintenance === null ||
    currentDigitalEmployeeMaintenance === null ||
    processing ||
    draining
  ) {
    await drainIfReady()
    return
  }
  processing = true
  const store = createMaintenanceRunStore(currentDb)
  try {
    for (;;) {
      if (draining) break
      const now = Date.now()
      const leaseToken = ulid()
      const claim = await claimNextWithBusyBackoff(store, { leaseToken, now, leaseMs: LEASE_MS })
      const claimed = claim.claimed
      if (claimed === null) break
      const job = MaintenanceJobKeySchema.parse(claimed.row.jobKey)
      active = { runId: claimed.row.id, leaseToken }
      emit({
        type: 'active',
        version: MAINTENANCE_PROTOCOL_VERSION,
        runId: claimed.row.id,
        job,
        startedAt: claimed.row.startedAt ?? now,
      })
      try {
        const payload = parseJsonObject(claimed.row.payloadJson)
        const cursor =
          claimed.row.cursorJson === null ? undefined : parseJsonObject(claimed.row.cursorJson)
        statementTimings = emptyTimingHistogram()
        transactionTimings = emptyTimingHistogram()
        const sliceStartedAt = performance.now()
        const result = await runMaintenanceJob({
          db: currentDb,
          appHome,
          ownerCommands: {
            developmentAutomation: currentDevelopmentAutomationMaintenance,
            digitalEmployee: currentDigitalEmployeeMaintenance,
          },
          job,
          payload,
          ...(cursor === undefined ? {} : { cursor }),
        })
        const sliceMs = performance.now() - sliceStartedAt
        const sliceCounters = {
          ...result.counters,
          ...(claim.busyDeferrals === 0 ? {} : { sqliteBusyDeferrals: claim.busyDeferrals }),
          workerSliceCount: 1,
          workerSliceMsTotal: sliceMs,
          workerSliceMsMax: sliceMs,
          ...timingCounters('dbStatement', statementTimings),
          ...timingCounters('dbTransaction', transactionTimings),
        }
        statementTimings = null
        transactionTimings = null
        const finishedAt = Date.now()
        const counters = addCounters(parseCounters(claimed.row.countersJson), sliceCounters)
        const continuation = result.continuation
        const outcome = continuation === undefined ? 'succeeded' : 'deferred'
        const settlement = await settleWithBusyBackoff(store, {
          runId: claimed.row.id,
          leaseToken,
          now: finishedAt,
          outcome,
          counters,
          ...(continuation === undefined
            ? {}
            : {
                cursor: continuation.cursor,
                nextAttemptAt: finishedAt + continuation.resumeAfterMs,
              }),
        })
        if (settlement.settled) {
          emit({
            type: 'completed',
            version: MAINTENANCE_PROTOCOL_VERSION,
            runId: claimed.row.id,
            job,
            outcome,
            counters: settlement.counters,
            delta: result.delta,
            finishedAt,
          })
        }
        if (continuation !== undefined) await delay(continuation.resumeAfterMs)
        else if (claimed.row.jobClass === 'cleanup') await delay(CLEANUP_COOLDOWN_MS)
      } catch (error) {
        statementTimings = null
        transactionTimings = null
        const finishedAt = Date.now()
        const message = errorMessage(error)
        const busy = isSqliteBusy(error)
        const backoff = Math.min(
          MAX_BUSY_BACKOFF_MS,
          250 * 2 ** Math.min(8, Math.max(0, claimed.row.attempt)),
        )
        const outcome = busy ? 'deferred' : 'failed'
        const errorCode = busy ? 'sqlite-busy' : 'job-failed'
        const counters = addCounters(parseCounters(claimed.row.countersJson), {
          ...(busy ? { sqliteBusyDeferrals: 1 } : { workerFailures: 1 }),
        })
        const settlement = await settleWithBusyBackoff(store, {
          runId: claimed.row.id,
          leaseToken,
          now: finishedAt,
          outcome,
          errorCode,
          errorMessage: message,
          counters,
          ...(busy ? { nextAttemptAt: finishedAt + backoff } : {}),
        })
        if (settlement.settled) {
          emit({
            type: 'completed',
            version: MAINTENANCE_PROTOCOL_VERSION,
            runId: claimed.row.id,
            job,
            outcome,
            counters: settlement.counters,
            delta: { kind: 'none' },
            finishedAt,
            errorCode,
            errorMessage: message,
          })
        }
      } finally {
        active = null
      }
    }
  } catch (error) {
    emit({
      type: 'degraded',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at: Date.now(),
      error: errorMessage(error),
    })
  } finally {
    processing = false
    await drainIfReady()
  }
}

function initialise(value: unknown): void {
  const parsed = MaintenanceWorkerRequestSchema.parse(value)
  if (parsed.type !== 'init') throw new Error('maintenance-worker-first-message-must-be-init')
  if (db !== null) throw new Error('maintenance-worker-already-initialised')
  if (parsed.catalogDigest !== MAINTENANCE_CATALOG_DIGEST) {
    throw new Error('maintenance-worker-catalog-digest-mismatch')
  }
  appHome = parsed.appHome
  db = openDb({
    path: parsed.dbPath,
    migrationsFolder: parsed.migrationsFolder,
    skipMigrations: true,
    skipIntegrityCheck: true,
    synchronous: parsed.sqlite.synchronous,
    pageCacheMib: parsed.sqlite.pageCacheMib,
    mmapMib: parsed.sqlite.mmapMib,
    busyTimeoutMs: parsed.sqlite.busyTimeoutMs,
    slowQueryMs: 0,
    observeStatementMs: (ms) => recordTiming(statementTimings, ms),
    observeTransactionMs: (ms) => recordTiming(transactionTimings, ms),
  })
  developmentAutomationMaintenance = composeDevelopmentAutomationMaintenanceCommands(db)
  digitalEmployeeMaintenance = composeDigitalEmployeeMaintenanceCommands(db)
  createMaintenanceRunStore(db).recoverRunning(Date.now())
  pollTimer = setInterval(() => void processQueue(), IDLE_POLL_MS)
  pollTimer.unref?.()
  heartbeatTimer = setInterval(() => {
    const at = Date.now()
    const current = active
    if (current !== null && db !== null) {
      try {
        createMaintenanceRunStore(db).heartbeat({
          runId: current.runId,
          leaseToken: current.leaseToken,
          now: at,
          leaseMs: LEASE_MS,
        })
      } catch (error) {
        // The one-hour lease easily covers a skipped heartbeat. Foreground
        // write pressure must not turn a transient 50ms BUSY into a Worker
        // restart; the next heartbeat retries on the same fenced lease.
        if (!isSqliteBusy(error)) {
          emit({
            type: 'degraded',
            version: MAINTENANCE_PROTOCOL_VERSION,
            at,
            error: errorMessage(error),
          })
          return
        }
      }
    }
    emit({
      type: 'heartbeat',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at,
      activeRunId: current?.runId ?? null,
    })
  }, HEARTBEAT_MS)
  heartbeatTimer.unref?.()
  emit({
    type: 'ready',
    version: MAINTENANCE_PROTOCOL_VERSION,
    catalogDigest: MAINTENANCE_CATALOG_DIGEST,
    at: Date.now(),
  })
  void processQueue()
}

self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    if (db === null) {
      initialise(event.data)
      return
    }
    const request = MaintenanceWorkerRequestSchema.parse(event.data)
    if (request.type === 'wake') {
      void processQueue()
      return
    }
    if (request.type === 'drain') {
      draining = true
      void drainIfReady()
      return
    }
    throw new Error('maintenance-worker-init-after-ready')
  } catch (error) {
    emit({
      type: 'degraded',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at: Date.now(),
      error: errorMessage(error),
    })
  }
}
