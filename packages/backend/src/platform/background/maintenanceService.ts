import {
  MaintenanceJobKeySchema,
  type Config,
  type MaintenanceJobClass,
  type MaintenanceJobKey,
  type MaintenanceStatus,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'

import { openDb } from '@/db/client'
import { retryableSqliteWriteErrorCode } from '@/db/sqliteWriteRetry'
import type { MaintenanceRunStore } from './maintenanceRunStorePort'
import { createSqliteMaintenanceRunStore } from '@/platform/persistence/sqlite/systemMaintenanceOperations'
import { isDbSnapshotInProgress } from '@/platform/persistence/sqlite/systemProviderBackup'
import { registerConfigAppliedListener } from '@/services/configAppliedListeners'
import { startMaintenanceTicker, type MaintenanceTickerHandle } from '@/services/maintenanceTicker'
import { createLogger } from '@/util/log'
import { FIXED_MAINTENANCE_JOB_SPECS, maintenanceJobSpec } from './maintenanceCatalog'
import { parseMaintenanceJobPayload } from './maintenanceJobPayload'
import type { MaintenanceWorkerDelta, MaintenanceWorkerEvent } from './maintenanceProtocol'
import { startMaintenanceScheduleCoordinator, type CleanupSlot } from './maintenanceSchedule'
import {
  startMaintenanceWorkerSupervisor,
  type MaintenanceWorkerSupervisor,
} from './maintenanceWorkerSupervisor'
import { postgresqlSerializationFailureCode } from '@/db/postgresqlSerializationRetry'

const log = createLogger('maintenance-service')
const CHECKPOINT_SUPERVISOR_MS = 60_000
const ADMISSION_MAX_RETRY_DELAY_MS = 30_000
const ADMISSION_BUSY_TIMEOUT_MS = 5
const EVENT_LOOP_SAMPLE_MS = 50
const EVENT_LOOP_WINDOW_MS = 30_000

interface MaintenanceServiceCommonOptions {
  readonly appHome: string
  readonly configPath: string
  readonly loadConfig: () => Config
  readonly onLifecycleDelta?: (
    delta: Extract<MaintenanceWorkerDelta, { kind: 'lifecycle-alerts' }>,
  ) => void
  readonly onIntentQueued?: (sessionIds: readonly string[]) => void
}

export interface MaintenancePayloadSources {
  readonly activeTaskIds: () => Promise<readonly string[]> | readonly string[]
  readonly activeIntentApplyJournalIds: () => Promise<readonly string[]> | readonly string[]
  readonly activeResourceBundleApplyIds: () => Promise<readonly string[]> | readonly string[]
  /** Capture before HTTP admission opens; later scans would misclassify fresh turns as boot orphans. */
  readonly bootIntentTurnIds: () => Promise<readonly string[]> | readonly string[]
}

export type MaintenanceServiceOptions = MaintenanceServiceCommonOptions &
  (
    | Readonly<{
        provider?: 'sqlite'
        dbPath: string
        migrationsFolder: string
        generationId?: never
        database?: never
        store?: never
        payloadSources: MaintenancePayloadSources
      }>
    | Readonly<{
        provider: 'postgresql'
        dbPath?: never
        migrationsFolder?: never
        generationId: string
        database: {
          readonly provider: 'postgresql'
          readonly urlEnv: string
          readonly poolMax: number
          readonly connectTimeoutMs: number
          readonly statementTimeoutMs: number
          readonly idleTimeoutMs: number
        }
        /** Dedicated admission adapter composed from the verified live
         * PostgreSQL generation. The Worker opens its own bounded pool. */
        store: MaintenanceRunStore
        payloadSources: MaintenancePayloadSources
      }>
  )

export interface MaintenanceService {
  readonly status: () => MaintenanceStatus
  readonly reconfigure: () => void
  readonly runSoon: (job: MaintenanceJobKey) => void
  /** Fence new durable admissions and drain the active Worker slice. */
  readonly pause: () => Promise<void>
  /** Start a fresh Worker generation and replay admissions deferred by pause. */
  readonly resume: () => Promise<void>
  readonly stop: () => Promise<void>
}

interface MaintenanceAdmissionInput {
  readonly job: MaintenanceJobKey
  readonly jobClass: MaintenanceJobClass
  readonly slot: CleanupSlot
  readonly payload?: unknown
}

interface MaintenanceAdmissionTimerApi {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

interface MaintenanceAdmissionController {
  admit(input: MaintenanceAdmissionInput): void
  pause(): Promise<void>
  resume(): void
  stop(): Promise<void>
}

/**
 * Keeps a schedule slot alive across transient SQLite writer contention without
 * ever waiting on the request-serving connection. One retry chain exists per
 * exact job/slot and backs off to a 30 second ceiling until admission succeeds
 * or the daemon stops.
 */
export function createMaintenanceAdmissionController(options: {
  readonly store: Pick<MaintenanceRunStore, 'enqueue'>
  readonly payloadFor: (job: MaintenanceJobKey) => Promise<unknown> | unknown
  readonly wake: () => void
  readonly now?: () => number
  readonly makeId?: () => string
  readonly timers?: MaintenanceAdmissionTimerApi
  readonly onDeferred?: (input: {
    job: MaintenanceJobKey
    attempt: number
    delayMs: number
    contentionCode: string
  }) => void
  readonly classifyRetryable?: (error: unknown) => string | undefined
  readonly onAdmitted?: () => void
  readonly onFailed?: (input: { job: MaintenanceJobKey; error: unknown }) => void
}): MaintenanceAdmissionController {
  const now = options.now ?? Date.now
  const makeId = options.makeId ?? ulid
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  }
  interface PendingAdmission {
    readonly input: MaintenanceAdmissionInput
    payload: Readonly<Record<string, unknown>> | null
    attempt: number
    handle: ReturnType<typeof setTimeout> | null
  }
  const pending = new Map<string, PendingAdmission>()
  const inFlight = new Set<Promise<void>>()
  let paused = false
  let stopped = false

  const classifyRetryable =
    options.classifyRetryable ?? ((error: unknown) => retryableSqliteWriteErrorCode(error))

  const track = (promise: Promise<void>): void => {
    inFlight.add(promise)
    void promise.finally(() => inFlight.delete(promise))
  }

  const tryAdmission = async (key: string, entry: PendingAdmission): Promise<void> => {
    if (stopped || paused || pending.get(key) !== entry || entry.payload === null) return
    try {
      const receipt = await options.store.enqueue({
        id: makeId(),
        jobKey: entry.input.job,
        jobClass: entry.input.jobClass,
        slotKey: entry.input.slot.slotKey,
        cycleKey: entry.input.slot.cycleKey,
        payload: entry.payload,
        scheduledAt: entry.input.slot.scheduledAt,
        now: now(),
      })
      if (pending.get(key) === entry) pending.delete(key)
      options.onAdmitted?.()
      if (!paused && !stopped && (receipt.inserted || receipt.coalesced)) options.wake()
    } catch (error) {
      const contentionCode = classifyRetryable(error)
      if (contentionCode === undefined) {
        if (pending.get(key) === entry) pending.delete(key)
        options.onFailed?.({ job: entry.input.job, error })
        return
      }
      const delayMs = Math.min(ADMISSION_MAX_RETRY_DELAY_MS, 250 * 2 ** Math.min(entry.attempt, 7))
      entry.attempt += 1
      options.onDeferred?.({
        job: entry.input.job,
        attempt: entry.attempt,
        delayMs,
        contentionCode,
      })
      if (paused || stopped || pending.get(key) !== entry) return
      const handle = timers.setTimeout(() => {
        entry.handle = null
        track(tryAdmission(key, entry))
      }, delayMs)
      handle.unref?.()
      entry.handle = handle
    }
  }

  return {
    admit(input) {
      if (stopped) return
      const key = `${input.job}\u0000${input.slot.slotKey}`
      if (pending.has(key)) return
      const entry: PendingAdmission = { input, payload: null, attempt: 0, handle: null }
      pending.set(key, entry)
      const resolution = Promise.resolve(
        input.payload === undefined ? options.payloadFor(input.job) : input.payload,
      )
        .then(
          (value) =>
            parseMaintenanceJobPayload(input.job, value) as Readonly<Record<string, unknown>>,
        )
        .then(async (payload) => {
          if (pending.get(key) !== entry || stopped) return
          entry.payload = payload
          await tryAdmission(key, entry)
        })
        .catch((error: unknown) => {
          if (pending.get(key) === entry) pending.delete(key)
          options.onFailed?.({ job: input.job, error })
        })
      track(resolution)
    },
    async pause() {
      if (stopped || paused) {
        await Promise.allSettled([...inFlight])
        return
      }
      paused = true
      for (const entry of pending.values()) {
        if (entry.handle !== null) timers.clearTimeout(entry.handle)
        entry.handle = null
      }
      await Promise.allSettled([...inFlight])
    },
    resume() {
      if (stopped || !paused) return
      paused = false
      for (const [key, entry] of pending) {
        if (entry.payload !== null && entry.handle === null) track(tryAdmission(key, entry))
      }
    },
    async stop() {
      if (stopped) {
        await Promise.allSettled([...inFlight])
        return
      }
      stopped = true
      paused = false
      for (const entry of pending.values()) {
        if (entry.handle !== null) timers.clearTimeout(entry.handle)
      }
      pending.clear()
      await Promise.allSettled([...inFlight])
    },
  }
}

function parseCounters(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      ),
    )
  } catch {
    return {}
  }
}

function fixedSlot(job: MaintenanceJobKey, intervalMs: number, now: number): CleanupSlot {
  const scheduledAt = Math.floor(now / intervalMs) * intervalMs
  return {
    scheduledAt,
    slotKey: `fixed:${Math.floor(scheduledAt / intervalMs)}`,
    cycleKey: `fixed:${job}:${Math.floor(scheduledAt / intervalMs)}`,
  }
}

function postgresqlRetryableCode(error: unknown): string | undefined {
  return postgresqlSerializationFailureCode(error)
}

export function startMaintenanceService(options: MaintenanceServiceOptions): MaintenanceService {
  let currentConfig = options.loadConfig()
  let stopped = false
  let paused = false
  let pausePromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null
  let lastCheckpointSucceededAt = Date.now()
  const eventLoopSamples: Array<{ at: number; gapMs: number }> = []
  let previousEventLoopSampleAt = performance.now()
  const eventLoopTimer = setInterval(() => {
    const monotonicNow = performance.now()
    const wallNow = Date.now()
    eventLoopSamples.push({ at: wallNow, gapMs: monotonicNow - previousEventLoopSampleAt })
    previousEventLoopSampleAt = monotonicNow
    const cutoff = wallNow - EVENT_LOOP_WINDOW_MS
    while (eventLoopSamples[0] !== undefined && eventLoopSamples[0].at < cutoff) {
      eventLoopSamples.shift()
    }
  }, EVENT_LOOP_SAMPLE_MS)
  eventLoopTimer.unref?.()

  // SQLite keeps the RFC-338 short-wait admission connection; PostgreSQL
  // receives an async store already composed from the verified generation.
  // Neither path borrows the foreground request connection for Worker bodies.
  let admissionDb: ReturnType<typeof openDb> | null = null
  let store: MaintenanceRunStore
  let payloadSources: MaintenancePayloadSources
  if (options.provider === 'postgresql') {
    store = options.store
    payloadSources = options.payloadSources
  } else {
    // Main-thread admission uses its own short-wait connection. A contended
    // durable INSERT may defer a slot by one supervisor tick, but can never sit
    // on the HTTP event loop for the primary connection's historical 5 seconds.
    admissionDb = openDb({
      path: options.dbPath,
      migrationsFolder: options.migrationsFolder,
      skipMigrations: true,
      skipIntegrityCheck: true,
      journalMode: 'preserve',
      synchronous: currentConfig.sqliteSynchronous,
      pageCacheMib: Math.min(16, currentConfig.sqlitePageCacheMib),
      mmapMib: currentConfig.sqliteMmapMib,
      // Daily mode admits every heavy job at one wall-clock instant. Keep each
      // INSERT wait tiny so a contended 12-job cycle cannot add up to a visible
      // main-event-loop pause; the admission controller retries every slot.
      busyTimeoutMs: ADMISSION_BUSY_TIMEOUT_MS,
      slowQueryMs: 0,
    })
    store = createSqliteMaintenanceRunStore(admissionDb)
    payloadSources = options.payloadSources
  }
  const bootIntentTurnIds = Promise.resolve(payloadSources.bootIntentTurnIds())

  let projection: Awaited<ReturnType<MaintenanceRunStore['readProjection']>> = {
    active: null,
    last: null,
    backlog: [],
  }
  let projectionRefresh: Promise<void> | null = null
  const refreshProjection = (): void => {
    if (projectionRefresh !== null || stopped) return
    const pending = store
      .readProjection()
      .then((value) => {
        projection = value
      })
      .catch((error: unknown) => {
        log.warn('maintenance status projection refresh failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        if (projectionRefresh === pending) projectionRefresh = null
      })
    projectionRefresh = pending
  }
  refreshProjection()

  const consumeDelta = (
    _runId: string,
    _job: MaintenanceJobKey,
    delta: MaintenanceWorkerDelta,
  ): void => {
    if (delta.kind === 'lifecycle-alerts') options.onLifecycleDelta?.(delta)
    else if (delta.kind === 'intent-queued') options.onIntentQueued?.(delta.sessionIds)
  }
  const observeWorkerEvent = (event: MaintenanceWorkerEvent): void => {
    if (event.type === 'active' || event.type === 'completed') refreshProjection()
    if (
      event.type === 'completed' &&
      event.job === 'walCheckpoint' &&
      event.outcome === 'succeeded'
    ) {
      lastCheckpointSucceededAt = event.finishedAt
    }
    if (event.type === 'degraded') log.error('maintenance worker degraded', { error: event.error })
    if (event.type === 'completed' && event.outcome === 'failed') {
      log.warn('maintenance job failed', {
        job: event.job,
        runId: event.runId,
        errorCode: event.errorCode,
        error: event.errorMessage,
      })
    }
  }

  const supervisor: MaintenanceWorkerSupervisor =
    options.provider === 'postgresql'
      ? startMaintenanceWorkerSupervisor({
          provider: 'postgresql',
          generationId: options.generationId,
          database: options.database,
          appHome: options.appHome,
          onDelta: consumeDelta,
          onEvent: observeWorkerEvent,
        })
      : startMaintenanceWorkerSupervisor({
          dbPath: options.dbPath,
          migrationsFolder: options.migrationsFolder,
          appHome: options.appHome,
          sqlite: {
            synchronous: currentConfig.sqliteSynchronous,
            pageCacheMib: currentConfig.sqlitePageCacheMib,
            mmapMib: currentConfig.sqliteMmapMib,
            busyTimeoutMs: 50,
          },
          onDelta: consumeDelta,
          onEvent: observeWorkerEvent,
        })

  const payloadFor = async (
    job: MaintenanceJobKey,
    scope?: { all: true } | { since: number },
  ): Promise<unknown> => {
    const config = currentConfig
    switch (job) {
      case 'worktreeGc':
        return {
          worktreeAutoGc: config.worktreeAutoGc,
          ...(config.gitCloneTimeoutMs === undefined
            ? {}
            : { gitCloneTimeoutMs: config.gitCloneTimeoutMs }),
          activeTaskIds: await payloadSources.activeTaskIds(),
        }
      case 'workspaceRecovery':
        return { activeTaskIds: await payloadSources.activeTaskIds() }
      case 'webhookDeliveryGc':
        return {
          bodyRetentionDays: config.webhookDeliveryBodyRetentionDays,
          rowRetentionDays: config.webhookDeliveryRowRetentionDays,
        }
      case 'eventsArchive':
        return { eventsArchiveThresholds: config.eventsArchiveThresholds }
      case 'retentionSweep':
        return {
          eventStreamRetentionDays: config.eventStreamRetentionDays,
          webhookTriggerFiresRetentionDays: config.webhookTriggerFiresRetentionDays,
        }
      case 'taskArchive':
        return config.taskArchive
      case 'backupPrune':
        return {
          retentionCount: config.backupRetentionCount,
          retentionDays: config.backupRetentionDays,
          maxTotalBytes: config.backupMaxTotalBytes,
          protectedKeepCount: config.backupProtectedKeepCount,
        }
      case 'pluginGenerationGc':
      case 'developmentUploadGc':
      case 'developmentRetentionSweep':
      case 'employeeInputGc':
      case 'humanGateRecovery':
      case 'walCheckpoint':
        return {}
      case 'intentScratchGc':
        return { retentionHours: config.intentBuilderScratchRetentionHours ?? 24 }
      case 'tokenAuditGc':
        return { retentionDays: config.tokenAuditRetentionDays ?? 90 }
      case 'intentRecovery':
        return {
          activeIntentApplyJournalIds: await payloadSources.activeIntentApplyJournalIds(),
          activeBundleApplyIds: await payloadSources.activeResourceBundleApplyIds(),
          recoverTurnIds: [],
          recoverTurns: false,
        }
      case 'lifecycleInvariants':
        return { scope: scope ?? { since: Date.now() - 2 * 60 * 60_000 } }
      case 'stuckTaskDetector':
        return {}
    }
  }

  const admission = createMaintenanceAdmissionController({
    store,
    payloadFor,
    wake: supervisor.wake,
    classifyRetryable:
      options.provider === 'postgresql' ? postgresqlRetryableCode : retryableSqliteWriteErrorCode,
    onAdmitted: refreshProjection,
    onDeferred: ({ job, attempt, delayMs, contentionCode }) => {
      log.warn('maintenance admission deferred', { job, attempt, delayMs, contentionCode })
    },
    onFailed: ({ job, error }) => {
      log.error('maintenance admission failed', {
        job,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const admit = admission.admit

  const scheduleCoordinator = startMaintenanceScheduleCoordinator({
    schedule: () => currentConfig.maintenanceSchedule,
    admit: ({ job, jobClass, slot }) => admit({ job, jobClass, slot }),
  })

  const fixedTickers: MaintenanceTickerHandle[] = []
  const bootTimers: Array<ReturnType<typeof setTimeout>> = []
  for (const spec of FIXED_MAINTENANCE_JOB_SPECS) {
    const intervalMs = 'intervalMs' in spec ? spec.intervalMs : undefined
    const phaseOffsetMs = 'phaseOffsetMs' in spec ? spec.phaseOffsetMs : undefined
    if ('bootDelayMs' in spec && spec.bootDelayMs !== undefined) {
      const timer = setTimeout(() => {
        const at = Date.now()
        const payload =
          spec.key === 'lifecycleInvariants'
            ? payloadFor(spec.key, { all: true })
            : spec.key === 'intentRecovery'
              ? Promise.all([payloadFor(spec.key), bootIntentTurnIds]).then(
                  ([base, bootIntentTurnIds]) => ({
                    ...(base as Record<string, unknown>),
                    recoverTurnIds: bootIntentTurnIds,
                  }),
                )
              : undefined
        admit({
          job: spec.key,
          jobClass: spec.class,
          slot: {
            scheduledAt: at,
            slotKey: `boot:${at}`,
            cycleKey: `boot:${at}`,
          },
          ...(payload === undefined ? {} : { payload }),
        })
      }, spec.bootDelayMs)
      timer.unref?.()
      bootTimers.push(timer)
    }
    if (intervalMs === undefined || phaseOffsetMs === undefined) continue
    fixedTickers.push(
      startMaintenanceTicker({
        job: spec.key,
        intervalMs,
        phaseOffsetMs,
        onTick: () => {
          const at = Date.now()
          admit({
            job: spec.key,
            jobClass: spec.class,
            slot: fixedSlot(spec.key, intervalMs, at),
            ...(spec.key === 'lifecycleInvariants'
              ? { payload: payloadFor(spec.key, { since: at - 2 * 60 * 60_000 }) }
              : {}),
          })
        },
      }),
    )
  }

  const checkpointTimer = setInterval(() => {
    try {
      const intervalMs = currentConfig.walCheckpointIntervalMs
      if (intervalMs <= 0 || Date.now() - lastCheckpointSucceededAt < intervalMs) return
      if (options.provider !== 'postgresql' && isDbSnapshotInProgress()) return
      const at = Date.now()
      admit({
        job: 'walCheckpoint',
        jobClass: 'checkpoint',
        slot: {
          scheduledAt: at,
          slotKey: `checkpoint:${at}`,
          cycleKey: `checkpoint:${Math.floor(at / Math.max(1, intervalMs))}`,
        },
      })
    } catch (error) {
      log.warn('wal checkpoint supervisor failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, CHECKPOINT_SUPERVISOR_MS)
  checkpointTimer.unref?.()

  const unregisterConfig = registerConfigAppliedListener(options.configPath, (config) => {
    const previousSchedule = currentConfig.maintenanceSchedule
    currentConfig = config
    const nextSchedule = config.maintenanceSchedule
    const scheduleChanged =
      previousSchedule.kind !== nextSchedule.kind ||
      (previousSchedule.kind === 'daily' &&
        nextSchedule.kind === 'daily' &&
        (previousSchedule.at !== nextSchedule.at ||
          previousSchedule.timezone !== nextSchedule.timezone))
    if (scheduleChanged) scheduleCoordinator.reconfigure()
  })

  const runSoon = (job: MaintenanceJobKey): void => {
    const spec = maintenanceJobSpec(job)
    const at = Date.now()
    admit({
      job,
      jobClass: spec.class,
      slot: {
        scheduledAt: at,
        slotKey: `immediate:${at}:${ulid()}`,
        cycleKey: `immediate:${job}:${at}`,
      },
    })
  }

  const pause = (): Promise<void> => {
    if (stopped || paused) return pausePromise ?? Promise.resolve()
    paused = true
    const pending = Promise.all([admission.pause(), supervisor.pause()])
      .then(() => undefined)
      .finally(() => {
        if (pausePromise === pending) pausePromise = null
      })
    pausePromise = pending
    return pending
  }

  const resume = async (): Promise<void> => {
    if (stopped || !paused) return
    await pausePromise
    if (stopped || !paused) return
    await supervisor.resume()
    admission.resume()
    paused = false
  }

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise
    stopped = true
    paused = false
    const pending = (async () => {
      unregisterConfig()
      scheduleCoordinator.stop()
      for (const ticker of fixedTickers) ticker.stop()
      for (const timer of bootTimers) clearTimeout(timer)
      clearInterval(checkpointTimer)
      clearInterval(eventLoopTimer)
      await Promise.all([admission.stop(), supervisor.stop()])
      await projectionRefresh?.catch(() => undefined)
      ;(admissionDb as unknown as { $client?: { close(): void } } | null)?.$client?.close()
    })()
    stopPromise = pending
    return pending
  }

  return {
    reconfigure: scheduleCoordinator.reconfigure,
    runSoon,
    pause,
    resume,
    status() {
      const worker = supervisor.live()
      refreshProjection()
      const activeRow =
        worker.active !== null && projection.active?.id === worker.active.runId
          ? projection.active
          : null
      const lastJob =
        projection.last === null
          ? null
          : MaintenanceJobKeySchema.safeParse(projection.last.jobKey).success
            ? MaintenanceJobKeySchema.parse(projection.last.jobKey)
            : null
      return {
        version: 1,
        worker: {
          state: worker.state,
          lastHeartbeatAt: worker.lastHeartbeatAt,
          error: worker.error,
        },
        eventLoop: {
          samplePeriodMs: EVENT_LOOP_SAMPLE_MS,
          windowMs: EVENT_LOOP_WINDOW_MS,
          sampleCount: eventLoopSamples.length,
          maxGapMs: eventLoopSamples.reduce(
            (maximum, sample) => Math.max(maximum, sample.gapMs),
            0,
          ),
        },
        schedule: currentConfig.maintenanceSchedule,
        nextRunAt: scheduleCoordinator.nextRunAt(),
        active:
          worker.active === null
            ? null
            : {
                runId: worker.active.runId,
                cycleKey: activeRow?.cycleKey ?? null,
                job: worker.active.job,
                startedAt: worker.active.startedAt,
                counters: activeRow === null ? {} : parseCounters(activeRow.countersJson),
              },
        last:
          projection.last === null || lastJob === null || projection.last.finishedAt === null
            ? null
            : {
                runId: projection.last.id,
                job: lastJob,
                outcome: projection.last.state === 'succeeded' ? 'succeeded' : 'failed',
                finishedAt: projection.last.finishedAt,
                counters: parseCounters(projection.last.countersJson),
                ...(projection.last.errorCode === null
                  ? {}
                  : { errorCode: projection.last.errorCode }),
                ...(projection.last.errorMessage === null
                  ? {}
                  : { errorMessage: projection.last.errorMessage }),
              },
        backlog: projection.backlog.flatMap((row) => {
          const parsed = MaintenanceJobKeySchema.safeParse(row.jobKey)
          if (!parsed.success) return []
          return [
            {
              runId: row.id,
              job: parsed.data,
              state: row.state as 'pending' | 'deferred' | 'failed',
              since: row.createdAt,
            },
          ]
        }),
      }
    },
    stop,
  }
}
