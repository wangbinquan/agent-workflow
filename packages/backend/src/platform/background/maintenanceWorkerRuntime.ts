// RFC-389 — maintenance Worker mechanism. The entry supplies the thread graph.
import { MaintenanceJobKeySchema } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { retryableSqliteWriteErrorCode } from '@/platform/persistence/sqliteWriteRetry'
import { postgresqlSerializationFailureCode } from '@/platform/persistence/postgresqlSerializationRetry'
import { createLogger } from '@/util/log'
import type { ClaimedMaintenanceRun, MaintenanceRunStore } from './maintenanceRunStorePort'
import { MAINTENANCE_CATALOG_DIGEST } from './maintenanceCatalog'
import { runMaintenanceJob } from './maintenanceJobRunner'
import type { MaintenanceJobHandlers } from '@/platform/contracts/maintenanceJob'
import { installMaintenanceWorkerErrorBoundary } from './maintenanceWorkerErrorBoundary'
import { MAINTENANCE_PROTOCOL_VERSION, type MaintenanceWorkerEvent } from './maintenanceProtocol'
import {
  type MaintenanceWorkerEffectsContext,
  type MaintenanceWorkerEffectsDescriptor,
  type MaintenanceWorkerEffectsScope,
} from './maintenanceWorkerEffects'
import { readMaintenanceWorkerEffectsFrame } from './maintenanceWorkerEffectsProtocol'
import {
  routeMaintenanceWorkerRequest,
  type MaintenanceWorkerInitRequest,
} from './maintenanceWorkerMessageRouter'
import {
  createMaintenanceSliceDiagnostics,
  type MaintenanceSliceDiagnostics,
} from './maintenanceSliceDiagnostics'

declare const self: Worker

export interface MaintenanceWorkerObservers {
  statement(ms: number, sql?: string, cpuMs?: number): void
  transaction(ms: number): void
}

export interface MaintenanceWorkerGraph {
  readonly store: MaintenanceRunStore
  readonly handlers: MaintenanceJobHandlers
  readonly busyDeferralCounter: 'sqliteBusyDeferrals' | 'postgresqlTransientDeferrals'
  close(): Promise<void>
}

export type MaintenanceWorkerGraphFactory<Selection extends object> = (input: {
  readonly request: MaintenanceWorkerInitRequest
  readonly appHome: string
  readonly effects: Selection | undefined
  readonly observe: MaintenanceWorkerObservers
  /** Register immediately after open, so failed composition still closes after effects. */
  readonly registerConnectionClose: (close: () => Promise<void>) => void
}) => Promise<MaintenanceWorkerGraph>

export function runMaintenanceWorker<Selection extends object>({
  composeGraph,
  openEffectsScope,
}: {
  readonly composeGraph: MaintenanceWorkerGraphFactory<Selection>
  readonly openEffectsScope: (input: {
    readonly descriptor: MaintenanceWorkerEffectsDescriptor
    readonly context: Omit<MaintenanceWorkerEffectsContext, 'configurationJson'>
  }) => MaintenanceWorkerEffectsScope<Selection>
}): void {
  const LEASE_MS = 60 * 60 * 1_000
  const IDLE_POLL_MS = 1_000
  const HEARTBEAT_MS = 5_000
  const MAX_BUSY_BACKOFF_MS = 30_000
  const CLEANUP_COOLDOWN_MS = 25

  let graph: MaintenanceWorkerGraph | null = null
  let connectionClose: (() => Promise<void>) | null = null
  let store: MaintenanceRunStore | null = null
  let workerEffectsScope: MaintenanceWorkerEffectsScope<Selection> | null = null
  let workerEffects: Selection | null = null
  let appHome = ''
  let processing = false
  let draining = false
  let initialising = false
  let initialised = false
  let active: { runId: string; leaseToken: string } | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let heartbeatInFlight: Promise<void> | null = null
  let connectionClosing: Promise<void> | null = null
  let statementTimings: TimingHistogram | null = null
  let transactionTimings: TimingHistogram | null = null
  let sliceDiagnostics: MaintenanceSliceDiagnostics | null = null
  const maintenanceLog = createLogger('maintenanceWorker')

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
    const messages: string[] = []
    const seen = new Set<unknown>()
    let current = error
    while (!seen.has(current)) {
      seen.add(current)
      messages.push(current instanceof Error ? current.message : String(current))
      if (!(current instanceof Error) || current.cause === undefined) break
      current = current.cause
    }
    return messages.join(' <- ')
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

  function postgresqlRetryCode(error: unknown): '40001' | '40P01' | undefined {
    return postgresqlSerializationFailureCode(error)
  }

  function retryableLedgerError(
    error: unknown,
  ): 'sqlite-busy' | 'postgresql-transient' | undefined {
    if (isSqliteBusy(error)) return 'sqlite-busy'
    return postgresqlRetryCode(error) === undefined ? undefined : 'postgresql-transient'
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
        return { claimed: await store.claimNext(input), busyDeferrals }
      } catch (error) {
        if (retryableLedgerError(error) === undefined) throw error
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
        return { settled: await store.settle({ ...input, counters }), counters }
      } catch (error) {
        if (retryableLedgerError(error) === undefined) throw error
        await delay(busyBackoffMs(busyDeferrals))
        busyDeferrals += 1
      }
    }
  }

  function closeConnection(): Promise<void> {
    connectionClosing ??= (async () => {
      if (pollTimer !== null) clearInterval(pollTimer)
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
      pollTimer = null
      heartbeatTimer = null
      await heartbeatInFlight?.catch(() => undefined)
      heartbeatInFlight = null
      const currentClose = graph?.close ?? connectionClose
      const currentEffectsScope = workerEffectsScope
      graph = null
      connectionClose = null
      store = null
      initialised = false
      const closeFailures: unknown[] = []
      if (currentEffectsScope !== null) {
        try {
          await currentEffectsScope.dispose()
          if (workerEffectsScope === currentEffectsScope) {
            workerEffectsScope = null
            workerEffects = null
          }
        } catch (error) {
          // Keep the failed scope: another drain must not report a false release ACK.
          closeFailures.push(error)
        }
      }
      try {
        await currentClose?.()
      } catch (error) {
        closeFailures.push(error)
      }
      if (closeFailures.length === 1) throw closeFailures[0]
      if (closeFailures.length > 1)
        throw new AggregateError(
          closeFailures,
          'maintenance-worker-effects-and-database-close-failed',
        )
    })()
    return connectionClosing
  }

  async function drainIfReady(): Promise<void> {
    if (!draining || processing) return
    await closeConnection()
    emit({
      type: 'drained',
      version: MAINTENANCE_PROTOCOL_VERSION,
      at: Date.now(),
    })
  }

  async function processQueue(): Promise<void> {
    const currentGraph = graph
    const currentStore = store
    if (currentGraph === null || currentStore === null || processing || draining) {
      await drainIfReady()
      return
    }
    processing = true
    try {
      for (;;) {
        if (draining) break
        const now = Date.now()
        const leaseToken = ulid()
        const claim = await claimNextWithBusyBackoff(currentStore, {
          leaseToken,
          now,
          leaseMs: LEASE_MS,
        })
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
          sliceDiagnostics = createMaintenanceSliceDiagnostics({
            job,
            runId: claimed.row.id,
            slice: claimed.row.sliceNo + 1,
            attempt: claimed.row.attempt,
            startedAt: sliceStartedAt,
            log: maintenanceLog,
          })
          const result = await runMaintenanceJob({
            appHome,
            handlers: currentGraph.handlers,
            job,
            payload,
            ...(cursor === undefined ? {} : { cursor }),
          })
          const sliceMs = performance.now() - sliceStartedAt
          const sliceCounters = {
            ...result.counters,
            ...(claim.busyDeferrals === 0
              ? {}
              : { [currentGraph.busyDeferralCounter]: claim.busyDeferrals }),
            workerSliceCount: 1,
            workerSliceMsTotal: sliceMs,
            workerSliceMsMax: sliceMs,
            ...timingCounters('dbStatement', statementTimings),
            ...timingCounters('dbTransaction', transactionTimings),
          }
          const completedDiagnostics = sliceDiagnostics
          sliceDiagnostics = null
          completedDiagnostics.finish(transactionTimings, sliceMs)
          statementTimings = null
          transactionTimings = null
          const finishedAt = Date.now()
          const counters = addCounters(parseCounters(claimed.row.countersJson), sliceCounters)
          const continuation = result.continuation
          const outcome = continuation === undefined ? 'succeeded' : 'deferred'
          const settlement = await settleWithBusyBackoff(currentStore, {
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
          const failedDiagnostics = sliceDiagnostics
          sliceDiagnostics = null
          failedDiagnostics?.finish(transactionTimings)
          statementTimings = null
          transactionTimings = null
          const finishedAt = Date.now()
          const message = errorMessage(error)
          const retryable = retryableLedgerError(error)
          const busy = retryable !== undefined
          const backoff = Math.min(
            MAX_BUSY_BACKOFF_MS,
            250 * 2 ** Math.min(8, Math.max(0, claimed.row.attempt)),
          )
          const outcome = busy ? 'deferred' : 'failed'
          const errorCode =
            retryable === 'sqlite-busy'
              ? 'sqlite-busy'
              : retryable === 'postgresql-transient'
                ? 'postgresql-transient'
                : 'job-failed'
          const counters = addCounters(parseCounters(claimed.row.countersJson), {
            ...(retryable === 'sqlite-busy'
              ? { sqliteBusyDeferrals: 1 }
              : retryable === 'postgresql-transient'
                ? { postgresqlTransientDeferrals: 1 }
                : { workerFailures: 1 }),
          })
          const settlement = await settleWithBusyBackoff(currentStore, {
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

  async function initialise(
    parsed: MaintenanceWorkerInitRequest,
    effectsDescriptor?: MaintenanceWorkerEffectsDescriptor,
  ): Promise<void> {
    initialising = true
    try {
      if (parsed.catalogDigest !== MAINTENANCE_CATALOG_DIGEST) {
        throw new Error('maintenance-worker-catalog-digest-mismatch')
      }
      // A new idle generation must wait for the previous complete close ACK.
      if (connectionClosing !== null) {
        await connectionClosing
        connectionClosing = null
      }
      if (workerEffectsScope !== null)
        throw new Error('maintenance-worker-effects-previous-environment-not-released')
      appHome = parsed.appHome
      if (effectsDescriptor !== undefined) {
        const scope = openEffectsScope({
          descriptor: effectsDescriptor,
          context: { appHome, instanceRef: `aw-maintenance-worker:${ulid()}` },
        })
        workerEffectsScope = scope
        workerEffects = await scope.ready
      }
      graph = await composeGraph({
        request: parsed,
        appHome,
        effects: workerEffects ?? undefined,
        observe: {
          statement: (ms, sql, cpuMs) => {
            recordTiming(statementTimings, ms)
            sliceDiagnostics?.observeStatement(ms, sql, cpuMs)
          },
          transaction: (ms) => recordTiming(transactionTimings, ms),
        },
        registerConnectionClose: (close) => {
          connectionClose = close
        },
      })
      store = graph.store
      await store.recoverRunning(Date.now())
      initialised = true
    } finally {
      initialising = false
    }
    // A drain requested while this init was in flight settles here: the
    // generation never admits work, never arms its timers, and answers the
    // supervisor's pause instead of announcing a readiness it is about to drop.
    if (draining) {
      await drainIfReady()
      return
    }
    pollTimer = setInterval(() => void processQueue(), IDLE_POLL_MS)
    pollTimer.unref?.()
    heartbeatTimer = setInterval(() => {
      const at = Date.now()
      const current = active
      const currentStore = store
      if (current !== null && currentStore !== null && heartbeatInFlight === null) {
        const pending = currentStore
          .heartbeat({
            runId: current.runId,
            leaseToken: current.leaseToken,
            now: at,
            leaseMs: LEASE_MS,
          })
          .then(() => undefined)
          .catch((error: unknown) => {
            // The one-hour lease easily covers a skipped heartbeat. Foreground
            // SQLite contention and PostgreSQL serialization/deadlock retries
            // both keep the same fenced lease for the next heartbeat.
            if (retryableLedgerError(error) === undefined) {
              emit({
                type: 'degraded',
                version: MAINTENANCE_PROTOCOL_VERSION,
                at,
                error: errorMessage(error),
              })
            }
          })
          .finally(() => {
            if (heartbeatInFlight === pending) heartbeatInFlight = null
          })
        heartbeatInFlight = pending
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
      const frame = readMaintenanceWorkerEffectsFrame(event.data)
      const action = routeMaintenanceWorkerRequest(
        initialised ? 'ready' : initialising ? 'initialising' : 'idle',
        frame.request,
      )
      switch (action.kind) {
        case 'initialise':
          void initialise(action.request, frame.effects).catch(async (error: unknown) => {
            await closeConnection()
            emit({
              type: 'degraded',
              version: MAINTENANCE_PROTOCOL_VERSION,
              at: Date.now(),
              error: errorMessage(error),
            })
            // A drain requested while this init was failing still owes the
            // supervisor its receipt; without it pause waits out its timeout.
            await drainIfReady()
          })
          return
        case 'wake':
          void processQueue()
          return
        case 'drain':
          draining = true
          void drainIfReady()
          return
        case 'defer-drain':
          draining = true
          return
        case 'ignore':
          return
        case 'fail':
          // A misrouted frame is never a reason to tear down a live connection.
          throw new Error(action.error)
      }
    } catch (error) {
      emit({
        type: 'degraded',
        version: MAINTENANCE_PROTOCOL_VERSION,
        at: Date.now(),
        error: errorMessage(error),
      })
    }
  }
}
