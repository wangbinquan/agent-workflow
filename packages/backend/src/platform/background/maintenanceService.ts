import {
  MaintenanceJobKeySchema,
  type Config,
  type MaintenanceJobClass,
  type MaintenanceJobKey,
  type MaintenanceStatus,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'

import { retryableSqliteWriteErrorCode } from '@/platform/persistence/sqliteWriteRetry'
import type { MaintenanceRunStore } from './maintenanceRunStorePort'
import { registerConfigAppliedListener } from '@/services/configAppliedListeners'
import { startMaintenanceTicker, type MaintenanceTickerHandle } from '@/services/maintenanceTicker'
import { createLogger } from '@/util/log'
import { FIXED_MAINTENANCE_JOB_SPECS, maintenanceJobSpec } from './maintenanceCatalog'
import { parseMaintenanceJobPayload } from './maintenanceJobPayload'
import type { MaintenanceWorkerDelta, MaintenanceWorkerEvent } from './maintenanceProtocol'
import { startMaintenanceScheduleCoordinator, type CleanupSlot } from './maintenanceSchedule'
import type {
  ColdMaintenanceWorkerSupervisor,
  MaintenanceWorkerSupervisor,
} from './maintenanceWorkerSupervisor'
import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import type { DatabaseProvider } from '@/platform/persistence/schemaContract'

const log = createLogger('maintenance-service')
const CHECKPOINT_SUPERVISOR_MS = 60_000
const ADMISSION_MAX_RETRY_DELAY_MS = 30_000
const EVENT_LOOP_SAMPLE_MS = 50
const EVENT_LOOP_WINDOW_MS = 30_000
/**
 * 只记真正的冻结：正常运行的间隔是采样周期上下几毫秒，一秒是三个数量级之外。
 *
 * 做归因时可以用 `AGENT_WORKFLOW_EVENT_LOOP_STALL_LOG_MS` 临时调低——一次大迁移里的
 * 亚秒级停顿默认不会留下任何痕迹，而 `/api/maintenance/status` 只给滚动窗口的最大值，
 * 事后无从对齐。取值被夹在 [采样周期×2, 60s]，写错也不会把日志刷成噪声。
 */
const EVENT_LOOP_STALL_LOG_MS = eventLoopStallLogThreshold(process.env)

export function eventLoopStallLogThreshold(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = Number(env.AGENT_WORKFLOW_EVENT_LOOP_STALL_LOG_MS)
  if (!Number.isFinite(raw)) return 1_000
  return Math.min(60_000, Math.max(EVENT_LOOP_SAMPLE_MS * 2, Math.round(raw)))
}

interface MaintenanceServiceCommonOptions {
  readonly appHome: string
  readonly configPath: string
  readonly loadConfig: () => Config
  /**
   * 「此刻是否正在对这个库做**文件级**快照」——正在做就别发 WAL checkpoint，两者会抢同一份文件。
   *
   * RFC-359 AC-10：原来写成 `options.provider !== 'postgresql' && isDbSnapshotInProgress()`，
   * 并且让这个中立的后台服务直接 import 了 `platform/persistence/sqlite/systemProviderBackup`。
   * 答案由**装配方**给（它本来就知道自己在装哪个 provider）：
   * SQLite 侧给 `isDbSnapshotInProgress`，外部服务器侧给 `() => false`——它的存储在服务端，
   * 根本没有「本地文件快照」这回事，所以恒为 false 与原行为逐字一致（PG 原本就从不因此跳过）。
   */
  readonly fileSnapshotInFlight: () => boolean
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

/**
 * 装配方交出的「准入存储从哪来」。SQLite 侧自带一条**短等待**本地连接（见调用点）并负责
 * 关闭；外部服务器侧直接给已验证代上组好的 store，没有本地连接可关，`close` 省略。
 */
export interface MaintenanceAdmissionStore {
  readonly store: MaintenanceRunStore
  readonly close?: () => void
}

/**
 * RFC-359 AC-10：这里原来是一个**按 provider 字面量判别的联合**，服务体内因此问了两次
 * `options.provider === 'postgresql'`——一次决定准入存储怎么来，一次决定 Worker 监工怎么起。
 * 判别联合确实能把字段收窄出来，但「谁来装」这件事本来就该由**装配方**回答一次，而不是
 * 把两套装配参数一起塞进来、让服务自己挑。
 *
 * 改成交答案：`openAdmissionStore` / `startSupervisor` 两个工厂由装配方给（两个调用点本来
 * 就各自知道自己在装哪个 provider）。`provider` 字段保留，但只作 traits 查表用
 * （`databaseProviderTraits(...).classifyRetryable`），不再有任何分支读它。
 *
 * 顺带这是这个服务的**第一个注入接缝**：此前它直接 `import` 监工，既没法替身也没法断言，
 * 这正是它零覆盖的原因——加接缝和消分叉本来就是同一件事。
 */
export type MaintenanceServiceOptions = MaintenanceServiceCommonOptions &
  Readonly<{
    provider: DatabaseProvider
    payloadSources: MaintenancePayloadSources
    openAdmissionStore: (config: Config) => MaintenanceAdmissionStore
    startSupervisor: (
      config: Config,
      handlers: {
        readonly onDelta: (
          runId: string,
          job: MaintenanceJobKey,
          delta: MaintenanceWorkerDelta,
        ) => void
        readonly onEvent: (event: MaintenanceWorkerEvent) => void
      },
    ) => MaintenanceWorkerSupervisor
  }>

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

/** A captured owner lifetime; the platform does not interpret its authority. */
export interface MaintenanceExecutionLifetime {
  readonly current: () => boolean
}

export type ColdMaintenanceServiceOptions = Omit<MaintenanceServiceOptions, 'startSupervisor'> &
  Readonly<{
    createSupervisor: (
      config: Config,
      handlers: Parameters<MaintenanceServiceOptions['startSupervisor']>[1],
    ) => ColdMaintenanceWorkerSupervisor
  }>

export interface ColdMaintenanceService extends MaintenanceService {
  readonly start: (lifetime: MaintenanceExecutionLifetime) => Promise<void>
  readonly quiesce: (lifetime: MaintenanceExecutionLifetime) => Promise<void>
  readonly awaitDrained: (
    lifetime: MaintenanceExecutionLifetime,
    timeoutMs?: number,
  ) => Promise<void>
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
  readonly initiallyPaused?: boolean
  readonly current?: () => boolean
  /** Cold owner activation rebuilds deferred payloads from the current live configuration. */
  readonly revalidatePayloadFor?: (input: MaintenanceAdmissionInput) => Promise<unknown> | unknown
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
  let paused = options.initiallyPaused ?? false
  let stopped = false
  const current = options.current ?? (() => true)
  const revalidatePayloadFor = options.revalidatePayloadFor

  const classifyRetryable =
    options.classifyRetryable ?? ((error: unknown) => retryableSqliteWriteErrorCode(error))

  const track = (promise: Promise<void>): void => {
    inFlight.add(promise)
    void promise.finally(() => inFlight.delete(promise))
  }

  const tryAdmission = async (key: string, entry: PendingAdmission): Promise<void> => {
    if (stopped || paused || !current() || pending.get(key) !== entry || entry.payload === null)
      return
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
      if (!paused && !stopped && current() && (receipt.inserted || receipt.coalesced))
        options.wake()
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
      if (paused || stopped || !current() || pending.get(key) !== entry) return
      const handle = timers.setTimeout(() => {
        entry.handle = null
        track(tryAdmission(key, entry))
      }, delayMs)
      handle.unref?.()
      entry.handle = handle
    }
  }

  const resolvePayload = (key: string, entry: PendingAdmission, revalidate = false): void => {
    const input = entry.input
    const resolution = Promise.resolve(
      revalidate && revalidatePayloadFor !== undefined
        ? revalidatePayloadFor(input)
        : input.payload === undefined
          ? options.payloadFor(input.job)
          : input.payload,
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
  }

  return {
    admit(input) {
      if (stopped) return
      const key = `${input.job}\u0000${input.slot.slotKey}`
      if (pending.has(key)) return
      const entry: PendingAdmission = { input, payload: null, attempt: 0, handle: null }
      pending.set(key, entry)
      resolvePayload(key, entry)
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
        if (entry.payload === null || entry.handle !== null) continue
        if (revalidatePayloadFor === undefined) track(tryAdmission(key, entry))
        else resolvePayload(key, entry, true)
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

export function startMaintenanceService(options: MaintenanceServiceOptions): MaintenanceService {
  return createMaintenanceService(options, false)
}

export function createColdMaintenanceService(
  options: ColdMaintenanceServiceOptions,
): ColdMaintenanceService {
  return createMaintenanceService(options, true)
}

function createMaintenanceService(
  options: MaintenanceServiceOptions,
  cold: false,
): MaintenanceService
function createMaintenanceService(
  options: ColdMaintenanceServiceOptions,
  cold: true,
): ColdMaintenanceService
function createMaintenanceService(
  options: MaintenanceServiceOptions | ColdMaintenanceServiceOptions,
  cold: boolean,
): MaintenanceService | ColdMaintenanceService {
  const coldFactory = cold ? (options as ColdMaintenanceServiceOptions).createSupervisor : null
  if (cold && typeof coldFactory !== 'function') {
    throw new Error('cold maintenance requires a complete cold supervisor factory')
  }
  let currentConfig = options.loadConfig()
  let stopped = false
  let paused = cold
  let pausePromise: Promise<void> | null = null
  let coldPauseRequested = false
  let coldPauseSequence = 0
  let stopPromise: Promise<void> | null = null
  let lastCheckpointSucceededAt = Date.now()
  const eventLoopSamples: Array<{ at: number; gapMs: number }> = []
  let previousEventLoopSampleAt = performance.now()
  let previousHeapUsed = process.memoryUsage().heapUsed
  let eventLoopTimer: ReturnType<typeof setInterval> | null = null
  const startEventLoopSampling = (): void => {
    if (eventLoopTimer !== null) return
    if (cold) {
      previousEventLoopSampleAt = performance.now()
      previousHeapUsed = process.memoryUsage().heapUsed
    }
    eventLoopTimer = setInterval(() => {
      const monotonicNow = performance.now()
      const wallNow = Date.now()
      const gapMs = monotonicNow - previousEventLoopSampleAt
      // RFC-349 —— 卡顿要留下时间戳，否则只有一个跨窗口的 max，事后无法与任何日志对齐。
      // 一次大迁移里追一段多秒级冻结，缺的正是「它发生在哪一刻」：`/api/maintenance/status`
      // 只给滚动窗口的最大值，而 daemon 自己一声不吭。超过一秒才记，正常运行一条都不会有。
      // 堆用量一并记：**阻塞式计算**与**一次大 GC** 在延迟上长得一模一样，只有堆的走向
      // 能把它们分开——GC 停顿之后堆会掉一大块，阻塞计算之后不会。
      const heapUsed = process.memoryUsage().heapUsed
      if (gapMs >= EVENT_LOOP_STALL_LOG_MS) {
        log.warn('event loop stalled', {
          gapMs: Math.round(gapMs),
          heapMib: Math.round(heapUsed / 1024 / 1024),
          heapDeltaMib: Math.round((heapUsed - previousHeapUsed) / 1024 / 1024),
        })
      }
      previousHeapUsed = heapUsed
      eventLoopSamples.push({ at: wallNow, gapMs })
      previousEventLoopSampleAt = monotonicNow
      const cutoff = wallNow - EVENT_LOOP_WINDOW_MS
      while (eventLoopSamples[0] !== undefined && eventLoopSamples[0].at < cutoff) {
        eventLoopSamples.shift()
      }
    }, EVENT_LOOP_SAMPLE_MS)
    eventLoopTimer.unref?.()
  }
  if (!cold) startEventLoopSampling()

  // 准入存储由装配方交出：SQLite 侧是一条自带的短等待本地连接（绝不借用前台请求连接），
  // 外部服务器侧是已验证代上组好的 store。服务这边只拿 store 和一个可选的关闭钩子。
  const admissionStore = options.openAdmissionStore(currentConfig)
  const store = admissionStore.store
  const closeAdmissionStore = admissionStore.close
  const payloadSources = options.payloadSources
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

  const handlers = { onDelta: consumeDelta, onEvent: observeWorkerEvent }
  let supervisor: MaintenanceWorkerSupervisor | null = cold
    ? null
    : (options as MaintenanceServiceOptions).startSupervisor(currentConfig, handlers)

  interface ColdServiceFrame {
    readonly lifetime: MaintenanceExecutionLifetime
    readonly current: () => boolean
    supervisor: ColdMaintenanceWorkerSupervisor | null
    readonly supervisors: ColdMaintenanceWorkerSupervisor[]
    start: Promise<void> | null
    resume: Promise<void> | null
    ownerStarted: boolean
    admissionTail: Promise<void> | null
    quiesced: boolean
    activated: boolean
    selectedOnce: boolean
  }
  const coldFrames = new WeakMap<MaintenanceExecutionLifetime, ColdServiceFrame>()
  const pendingColdFrames = new Set<ColdServiceFrame>()
  let activeColdFrame: ColdServiceFrame | null = null
  let lastSelectedColdFrame: ColdServiceFrame | null = null
  const acceptingExecution = (): boolean =>
    !stopped &&
    !paused &&
    (!cold ||
      (activeColdFrame !== null &&
        activeColdFrame.activated &&
        activeColdFrame.current() &&
        activeColdFrame.supervisor?.live().state === 'ready'))

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
    wake: () => supervisor?.wake(),
    ...(cold
      ? {
          initiallyPaused: true,
          current: acceptingExecution,
          revalidatePayloadFor: (input: MaintenanceAdmissionInput) => {
            if (input.job === 'intentRecovery' && input.slot.slotKey.startsWith('boot:')) {
              return Promise.all([payloadFor(input.job), bootIntentTurnIds]).then(
                ([base, turnIds]) => ({
                  ...(base as Record<string, unknown>),
                  recoverTurnIds: turnIds,
                }),
              )
            }
            if (input.job === 'lifecycleInvariants') {
              return payloadFor(
                input.job,
                input.slot.slotKey.startsWith('boot:')
                  ? { all: true }
                  : { since: input.slot.scheduledAt - 2 * 60 * 60_000 },
              )
            }
            return payloadFor(input.job)
          },
        }
      : {}),
    // Per-provider retryable classification lives in the traits table: a new
    // provider must declare its own codes instead of inheriting SQLite's.
    // RFC-359 AC-10：`provider` 现在是必填的，所以这里不再有 `?? 'sqlite'` 兜底——
    // 少写一个 provider 是编译错，不是静默当成 SQLite。
    classifyRetryable: databaseProviderTraits(options.provider).classifyRetryable,
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

  let scheduleCoordinator: ReturnType<typeof startMaintenanceScheduleCoordinator> | null = null
  const fixedTickers: MaintenanceTickerHandle[] = []
  const bootTimers: Array<ReturnType<typeof setTimeout>> = []
  const issuedBootJobs = new Set<MaintenanceJobKey>()
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  const startExecutionSchedules = (): void => {
    if (scheduleCoordinator !== null) return
    scheduleCoordinator = startMaintenanceScheduleCoordinator({
      schedule: () => currentConfig.maintenanceSchedule,
      admit: ({ job, jobClass, slot }) => {
        if (!cold || acceptingExecution()) admit({ job, jobClass, slot })
      },
    })
    for (const spec of FIXED_MAINTENANCE_JOB_SPECS) {
      const intervalMs = 'intervalMs' in spec ? spec.intervalMs : undefined
      const phaseOffsetMs = 'phaseOffsetMs' in spec ? spec.phaseOffsetMs : undefined
      if (
        'bootDelayMs' in spec &&
        spec.bootDelayMs !== undefined &&
        (!cold || !issuedBootJobs.has(spec.key))
      ) {
        const timer = setTimeout(() => {
          if (cold && !acceptingExecution()) return
          if (cold) issuedBootJobs.add(spec.key)
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
            if (cold && !acceptingExecution()) return
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

    checkpointTimer = setInterval(() => {
      if (cold && !acceptingExecution()) return
      try {
        const intervalMs = currentConfig.walCheckpointIntervalMs
        if (intervalMs <= 0 || Date.now() - lastCheckpointSucceededAt < intervalMs) return
        if (options.fileSnapshotInFlight()) return
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
  }
  if (!cold) startExecutionSchedules()

  const stopExecutionTimers = (): void => {
    scheduleCoordinator?.stop()
    scheduleCoordinator = null
    for (const ticker of fixedTickers) ticker.stop()
    fixedTickers.length = 0
    for (const timer of bootTimers) clearTimeout(timer)
    bootTimers.length = 0
    if (checkpointTimer !== null) clearInterval(checkpointTimer)
    checkpointTimer = null
    if (eventLoopTimer !== null) clearInterval(eventLoopTimer)
    eventLoopTimer = null
  }

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
    if (scheduleChanged) scheduleCoordinator?.reconfigure()
  })

  const runSoon = (job: MaintenanceJobKey): void => {
    if (cold && !acceptingExecution()) throw new Error('maintenance execution is not ready')
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
    if (cold) stopExecutionTimers()
    const pending = Promise.all([admission.pause(), supervisor?.pause()])
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
    const frame = activeColdFrame
    const owner = supervisor
    if (cold && (frame === null || frame.quiesced || !frame.current())) {
      throw new Error('maintenance execution lifetime is not current')
    }
    await owner?.resume()
    if (
      stopped ||
      (cold && (frame === null || activeColdFrame !== frame || frame.quiesced || !frame.current()))
    ) {
      if (cold) frame?.supervisor?.quiesce()
      return
    }
    if (cold) paused = false
    admission.resume()
    paused = false
    if (cold) {
      startEventLoopSampling()
      startExecutionSchedules()
    }
  }

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise
    stopped = true
    paused = false
    const pending = (async () => {
      unregisterConfig()
      stopExecutionTimers()
      await Promise.all([
        admission.stop(),
        ...(cold
          ? [...pendingColdFrames].map((frame) => frame.supervisor?.stop())
          : [supervisor?.stop()]),
      ])
      if (cold) {
        await Promise.all(
          [...pendingColdFrames].flatMap((frame) => [
            frame.start?.catch(() => undefined),
            frame.resume?.catch(() => undefined),
          ]),
        )
      }
      await projectionRefresh?.catch(() => undefined)
      closeAdmissionStore?.call(admissionStore)
    })()
    stopPromise = pending
    return pending
  }

  const service: MaintenanceService = {
    reconfigure: () => scheduleCoordinator?.reconfigure(),
    runSoon,
    pause,
    resume,
    status() {
      const worker = supervisor?.live() ?? {
        state: 'stopped' as const,
        lastHeartbeatAt: null,
        error: null,
        active: null,
      }
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
        nextRunAt: scheduleCoordinator?.nextRunAt() ?? null,
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
  if (!cold) return service

  const captureSupervisor = (
    candidate: ColdMaintenanceWorkerSupervisor,
  ): ColdMaintenanceWorkerSupervisor => {
    for (const method of [
      'wake',
      'live',
      'pause',
      'resume',
      'stop',
      'drain',
      'start',
      'quiesce',
      'awaitDrained',
    ] as const) {
      if (typeof candidate[method] !== 'function') {
        throw new Error(`cold maintenance supervisor is missing ${method}`)
      }
    }
    // Preserve the actual factory object's receiver and original methods across awaits.
    return {
      wake: candidate.wake.bind(candidate),
      live: candidate.live.bind(candidate),
      pause: candidate.pause.bind(candidate),
      resume: candidate.resume.bind(candidate),
      stop: candidate.stop.bind(candidate),
      drain: candidate.drain.bind(candidate),
      start: candidate.start.bind(candidate),
      quiesce: candidate.quiesce.bind(candidate),
      awaitDrained: candidate.awaitDrained.bind(candidate),
    }
  }
  const releaseDrainedOwners = (
    frame: ColdServiceFrame,
    owners: readonly ColdMaintenanceWorkerSupervisor[],
  ): void => {
    // Only an actual ACK permits releasing these closures. Keep the WeakMap
    // identity so a superseded lifetime still cannot restart after retirement.
    for (const owner of owners) {
      const index = frame.supervisors.indexOf(owner)
      if (index >= 0) frame.supervisors.splice(index, 1)
      if (frame.supervisor === owner) {
        frame.supervisor = null
        frame.ownerStarted = false
      }
      if (supervisor === owner) supervisor = null
    }
    if (
      frame.quiesced &&
      frame.start === null &&
      frame.resume === null &&
      frame.supervisors.length === 0
    ) {
      pendingColdFrames.delete(frame)
      if (activeColdFrame === frame) activeColdFrame = null
    }
  }
  const fenceFrame = (frame: ColdServiceFrame): void => {
    frame.quiesced = true
    frame.activated = false
    if (activeColdFrame === frame) {
      paused = true
      stopExecutionTimers()
      frame.admissionTail = admission.pause()
    }
    frame.supervisor?.quiesce()
  }
  const assertCanActivate = (frame: ColdServiceFrame): void => {
    if (!frame.current() || stopped || frame.quiesced || lastSelectedColdFrame !== frame) {
      throw new Error('maintenance execution start quiesced')
    }
    if (coldPauseRequested) throw new Error('maintenance execution start paused')
  }
  const activateFrame = (frame: ColdServiceFrame): void => {
    assertCanActivate(frame)
    frame.activated = true
    paused = false
    admission.resume()
    assertCanActivate(frame)
    startEventLoopSampling()
    startExecutionSchedules()
  }
  const pauseCold = (): Promise<void> => {
    if (stopped) return pausePromise ?? Promise.resolve()
    // Initial cold `paused` also means "not started". Record ordinary pause
    // separately so a pending start cannot silently overwrite this request.
    coldPauseRequested = true
    coldPauseSequence += 1
    paused = true
    stopExecutionTimers()
    const frame = lastSelectedColdFrame
    if (frame !== null) frame.activated = false
    if (pausePromise !== null) return pausePromise
    const admissionTail = admission.pause()
    if (frame !== null) frame.admissionTail = admissionTail
    // A successor awaiting a prior loss ACK must not normally pause/force-stop
    // that prior owner. Only the selected frame owns this ordinary operation.
    const pending = Promise.all([admissionTail, frame?.supervisor?.pause()])
      .then(() => undefined)
      .finally(() => {
        if (pausePromise === pending) pausePromise = null
      })
    pausePromise = pending
    return pending
  }
  const resumeCold = (): Promise<void> => {
    if (stopped || (!paused && !coldPauseRequested)) return Promise.resolve()
    const frame = lastSelectedColdFrame
    const sequence = coldPauseSequence
    if (frame === null) {
      // There is no lifetime to activate; ordinary resume only clears its
      // pause intent. The first Worker still requires explicit start(current).
      return (async () => {
        await pausePromise
        if (!stopped && coldPauseSequence === sequence) coldPauseRequested = false
      })()
    }
    if (frame.resume !== null) return frame.resume
    const starting = frame.start
    const pending = (async () => {
      await pausePromise
      await starting?.catch(() => undefined)
      if (stopped || coldPauseSequence !== sequence) return
      const current = frame.current()
      if (stopped || coldPauseSequence !== sequence) return
      // Explicit resume clears the ordinary pause intent even if this old
      // lifetime has lost authority. It does not grant that owner activation;
      // a current successor still enters through start and the actual ACK.
      coldPauseRequested = false
      if (!current || frame.quiesced || lastSelectedColdFrame !== frame) {
        throw new Error('maintenance execution lifetime is not current')
      }
      const owner = frame.supervisor
      if (owner === null) {
        // Call the internal start, not the public pending-resume facade.
        await startFrame(frame.lifetime)
        return
      }
      activeColdFrame = frame
      supervisor = owner
      if (frame.ownerStarted) await owner.resume()
      else {
        frame.ownerStarted = true
        await owner.start()
      }
      if (stopped || coldPauseSequence !== sequence || coldPauseRequested) return
      if (!frame.current() || frame.quiesced || lastSelectedColdFrame !== frame) {
        throw new Error('maintenance execution lifetime is not current')
      }
      activateFrame(frame)
    })()
      .catch((error: unknown) => {
        if (!frame.current() || stopped || frame.quiesced || lastSelectedColdFrame !== frame) {
          fenceFrame(frame)
        } else {
          frame.activated = false
          paused = true
          stopExecutionTimers()
          frame.admissionTail = admission.pause()
        }
        throw error
      })
      .finally(() => {
        if (frame.resume === pending) frame.resume = null
      })
    frame.resume = pending
    return pending
  }
  const quiesce = (lifetime: MaintenanceExecutionLifetime): Promise<void> => {
    const frame = coldFrames.get(lifetime)
    if (frame !== undefined) fenceFrame(frame)
    return Promise.resolve()
  }
  const awaitDrained = (
    lifetime: MaintenanceExecutionLifetime,
    timeoutMs = 10_000,
  ): Promise<void> => {
    const frame = coldFrames.get(lifetime)
    if (frame === undefined) return Promise.resolve()
    if (!frame.quiesced) {
      return Promise.reject(new Error('maintenance execution must quiesce before drain'))
    }
    const actualDrain = (async () => {
      // A pending start may still own a Worker. Wait for that tail before taking
      // the complete list; start checks the synchronous quiesce fence before creation.
      await frame.start?.catch(() => undefined)
      await frame.resume?.catch(() => undefined)
      const admissionTail = frame.admissionTail
      await admissionTail
      const owners = [...frame.supervisors]
      await Promise.all(owners.map((owner) => owner.awaitDrained(timeoutMs)))
      if (frame.admissionTail === admissionTail) frame.admissionTail = null
      releaseDrainedOwners(frame, owners)
    })()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('maintenance execution actual drain timed out')),
        timeoutMs,
      )
      void actualDrain.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
  const startFrame = (lifetime: MaintenanceExecutionLifetime): Promise<void> => {
    if (stopped) return Promise.reject(new Error('maintenance service stopped'))
    let frame = coldFrames.get(lifetime)
    if (frame === undefined) {
      const current = lifetime.current
      if (typeof current !== 'function') {
        return Promise.reject(new Error('maintenance execution lifetime is missing current'))
      }
      frame = {
        lifetime,
        current: () => current.call(lifetime),
        supervisor: null,
        supervisors: [],
        start: null,
        resume: null,
        ownerStarted: false,
        admissionTail: null,
        quiesced: false,
        activated: false,
        selectedOnce: false,
      }
      coldFrames.set(lifetime, frame)
    }
    if (frame.start !== null) return frame.start
    if (frame.selectedOnce && lastSelectedColdFrame !== frame) {
      return Promise.reject(new Error('maintenance execution lifetime has been superseded'))
    }
    if (coldPauseRequested) {
      return Promise.reject(new Error('maintenance execution start paused'))
    }
    if (frame.activated && !frame.quiesced && frame.current()) return Promise.resolve()
    if (!frame.current()) {
      return Promise.reject(new Error('maintenance execution lifetime is not current'))
    }
    const selected = frame
    pendingColdFrames.add(selected)
    selected.selectedOnce = true
    lastSelectedColdFrame = selected
    const priorFrames = [...pendingColdFrames].filter((prior) => prior !== selected)
    const previousSupervisor = selected.supervisor
    if (previousSupervisor !== null) fenceFrame(selected)
    selected.quiesced = false
    const pending = (async () => {
      for (const prior of priorFrames) fenceFrame(prior)
      for (const prior of priorFrames) {
        await awaitDrained(prior.lifetime)
      }
      await selected.admissionTail
      await previousSupervisor?.awaitDrained()
      if (previousSupervisor !== null) releaseDrainedOwners(selected, [previousSupervisor])
      assertCanActivate(selected)
      const owner = captureSupervisor(coldFactory!.call(options, currentConfig, handlers))
      selected.supervisor = owner
      selected.supervisors.push(owner)
      activeColdFrame = selected
      supervisor = owner
      // A synchronous factory can reenter pause/quiesce/stop before returning
      // this complete owner. Handle that fence before invoking its start.
      if (
        !selected.current() ||
        stopped ||
        selected.quiesced ||
        lastSelectedColdFrame !== selected
      ) {
        fenceFrame(selected)
        if (stopped) await owner.stop()
        throw new Error('maintenance execution start quiesced')
      }
      if (coldPauseRequested) {
        await owner.pause()
        throw new Error('maintenance execution start paused')
      }
      selected.ownerStarted = true
      await owner.start()
      activateFrame(selected)
    })()
      .catch((error: unknown) => {
        if (!selected.current() || stopped || selected.quiesced || !coldPauseRequested) {
          fenceFrame(selected)
        } else selected.activated = false
        throw error
      })
      .finally(() => {
        if (selected.start === pending) selected.start = null
      })
    selected.start = pending
    return pending
  }
  const start = (lifetime: MaintenanceExecutionLifetime): Promise<void> => {
    if (stopped) return Promise.reject(new Error('maintenance service stopped'))
    return coldFrames.get(lifetime)?.resume ?? startFrame(lifetime)
  }
  return { ...service, pause: pauseCold, resume: resumeCold, start, quiesce, awaitDrained }
}
