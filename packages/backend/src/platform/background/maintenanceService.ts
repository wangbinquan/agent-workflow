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
import {
  createMaintenanceRunStore,
  type MaintenanceRunStore,
} from '@/platform/persistence/sqlite/maintenanceRunStore'
import { isDbSnapshotInProgress } from '@/services/backup'
import { activeResourceBundleApplyIds } from '@/services/bundle/apply'
import { registerConfigAppliedListener } from '@/services/configAppliedListeners'
import { activeIntentApplyJournalIds } from '@/services/intent/applyChangeset'
import { listIntentTurnIdsForBootRecovery } from '@/services/intent/maintenance'
import { startMaintenanceTicker, type MaintenanceTickerHandle } from '@/services/maintenanceTicker'
import { activeTaskIdsSnapshot } from '@/services/task'
import { createLogger } from '@/util/log'
import { FIXED_MAINTENANCE_JOB_SPECS, maintenanceJobSpec } from './maintenanceCatalog'
import { parseMaintenanceJobPayload } from './maintenanceJobPayload'
import type { MaintenanceWorkerDelta, MaintenanceWorkerEvent } from './maintenanceProtocol'
import { startMaintenanceScheduleCoordinator, type CleanupSlot } from './maintenanceSchedule'
import {
  startMaintenanceWorkerSupervisor,
  type MaintenanceWorkerSupervisor,
} from './maintenanceWorkerSupervisor'

const log = createLogger('maintenance-service')
const CHECKPOINT_SUPERVISOR_MS = 60_000
const ADMISSION_MAX_RETRY_DELAY_MS = 30_000
const ADMISSION_BUSY_TIMEOUT_MS = 5
const EVENT_LOOP_SAMPLE_MS = 50
const EVENT_LOOP_WINDOW_MS = 30_000

export interface MaintenanceServiceOptions {
  readonly dbPath: string
  readonly migrationsFolder: string
  readonly appHome: string
  readonly configPath: string
  readonly loadConfig: () => Config
  readonly onLifecycleDelta?: (
    delta: Extract<MaintenanceWorkerDelta, { kind: 'lifecycle-alerts' }>,
  ) => void
  readonly onIntentQueued?: (sessionIds: readonly string[]) => void
}

export interface MaintenanceService {
  readonly status: () => MaintenanceStatus
  readonly reconfigure: () => void
  readonly runSoon: (job: MaintenanceJobKey) => void
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
  stop(): void
}

/**
 * Keeps a schedule slot alive across transient SQLite writer contention without
 * ever waiting on the request-serving connection. One retry chain exists per
 * exact job/slot and backs off to a 30 second ceiling until admission succeeds
 * or the daemon stops.
 */
export function createMaintenanceAdmissionController(options: {
  readonly store: Pick<MaintenanceRunStore, 'enqueue'>
  readonly payloadFor: (job: MaintenanceJobKey) => unknown
  readonly wake: () => void
  readonly now?: () => number
  readonly makeId?: () => string
  readonly timers?: MaintenanceAdmissionTimerApi
  readonly onDeferred?: (input: {
    job: MaintenanceJobKey
    attempt: number
    delayMs: number
    sqliteCode: string
  }) => void
  readonly onFailed?: (input: { job: MaintenanceJobKey; error: unknown }) => void
}): MaintenanceAdmissionController {
  const now = options.now ?? Date.now
  const makeId = options.makeId ?? ulid
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  }
  const pending = new Map<string, ReturnType<typeof setTimeout> | null>()
  let stopped = false

  const tryAdmission = (
    input: MaintenanceAdmissionInput,
    payload: Readonly<Record<string, unknown>>,
    key: string,
    attempt: number,
  ): void => {
    if (stopped) return
    try {
      const receipt = options.store.enqueue({
        id: makeId(),
        jobKey: input.job,
        jobClass: input.jobClass,
        slotKey: input.slot.slotKey,
        cycleKey: input.slot.cycleKey,
        payload,
        scheduledAt: input.slot.scheduledAt,
        now: now(),
      })
      pending.delete(key)
      if (receipt.inserted || receipt.coalesced) options.wake()
    } catch (error) {
      const sqliteCode = retryableSqliteWriteErrorCode(error)
      if (sqliteCode === undefined) {
        pending.delete(key)
        options.onFailed?.({ job: input.job, error })
        return
      }
      const delayMs = Math.min(ADMISSION_MAX_RETRY_DELAY_MS, 250 * 2 ** Math.min(attempt, 7))
      options.onDeferred?.({ job: input.job, attempt: attempt + 1, delayMs, sqliteCode })
      const handle = timers.setTimeout(() => {
        pending.set(key, null)
        tryAdmission(input, payload, key, attempt + 1)
      }, delayMs)
      handle.unref?.()
      pending.set(key, handle)
    }
  }

  return {
    admit(input) {
      if (stopped) return
      const key = `${input.job}\u0000${input.slot.slotKey}`
      if (pending.has(key)) return
      try {
        const payload = parseMaintenanceJobPayload(
          input.job,
          input.payload ?? options.payloadFor(input.job),
        ) as Readonly<Record<string, unknown>>
        pending.set(key, null)
        tryAdmission(input, payload, key, 0)
      } catch (error) {
        options.onFailed?.({ job: input.job, error })
      }
    },
    stop() {
      stopped = true
      for (const handle of pending.values()) {
        if (handle !== null) timers.clearTimeout(handle)
      }
      pending.clear()
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

export function startMaintenanceService(options: MaintenanceServiceOptions): MaintenanceService {
  let currentConfig = options.loadConfig()
  let stopped = false
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

  // Main-thread admission uses its own short-wait connection. A contended
  // durable INSERT may defer a slot by one supervisor tick, but can never sit
  // on the HTTP event loop for the primary connection's historical 5 seconds.
  const admissionDb = openDb({
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
  const store = createMaintenanceRunStore(admissionDb)
  // Snapshot before startMaintenanceService returns and before HTTP can accept
  // a new intent turn. The Worker may execute later, so a live scan there would
  // misclassify this daemon's fresh work as an orphan from the previous boot.
  const bootIntentTurnIds = listIntentTurnIdsForBootRecovery(admissionDb)

  const consumeDelta = (
    _runId: string,
    _job: MaintenanceJobKey,
    delta: MaintenanceWorkerDelta,
  ): void => {
    if (delta.kind === 'lifecycle-alerts') options.onLifecycleDelta?.(delta)
    else if (delta.kind === 'intent-queued') options.onIntentQueued?.(delta.sessionIds)
  }
  const observeWorkerEvent = (event: MaintenanceWorkerEvent): void => {
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

  const supervisor: MaintenanceWorkerSupervisor = startMaintenanceWorkerSupervisor({
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

  const payloadFor = (
    job: MaintenanceJobKey,
    scope?: { all: true } | { since: number },
  ): unknown => {
    const config = currentConfig
    switch (job) {
      case 'worktreeGc':
        return {
          worktreeAutoGc: config.worktreeAutoGc,
          ...(config.gitCloneTimeoutMs === undefined
            ? {}
            : { gitCloneTimeoutMs: config.gitCloneTimeoutMs }),
          activeTaskIds: activeTaskIdsSnapshot(),
        }
      case 'workspaceRecovery':
        return { activeTaskIds: activeTaskIdsSnapshot() }
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
          activeIntentApplyJournalIds: activeIntentApplyJournalIds(),
          activeBundleApplyIds: activeResourceBundleApplyIds(),
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
    onDeferred: ({ job, attempt, delayMs, sqliteCode }) => {
      log.warn('maintenance admission deferred', { job, attempt, delayMs, sqliteCode })
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
        admit({
          job: spec.key,
          jobClass: spec.class,
          slot: {
            scheduledAt: at,
            slotKey: `boot:${at}`,
            cycleKey: `boot:${at}`,
          },
          ...(spec.key === 'lifecycleInvariants'
            ? { payload: payloadFor(spec.key, { all: true }) }
            : spec.key === 'intentRecovery'
              ? {
                  payload: {
                    ...(payloadFor(spec.key) as Record<string, unknown>),
                    recoverTurnIds: bootIntentTurnIds,
                  },
                }
              : {}),
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
      if (isDbSnapshotInProgress()) return
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

  return {
    reconfigure: scheduleCoordinator.reconfigure,
    runSoon,
    status() {
      const worker = supervisor.live()
      const projection = store.readProjection()
      const activeRow = worker.active === null ? null : store.read(worker.active.runId)
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
    async stop() {
      if (stopped) return
      stopped = true
      unregisterConfig()
      scheduleCoordinator.stop()
      for (const ticker of fixedTickers) ticker.stop()
      for (const timer of bootTimers) clearTimeout(timer)
      clearInterval(checkpointTimer)
      clearInterval(eventLoopTimer)
      admission.stop()
      await supervisor.drain()
      ;(admissionDb as unknown as { $client: { close(): void } }).$client.close()
    },
  }
}
