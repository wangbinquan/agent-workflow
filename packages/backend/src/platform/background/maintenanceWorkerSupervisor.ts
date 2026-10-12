import type { MaintenanceJobKey, MaintenanceWorkerState } from '@agent-workflow/shared'

import type { MaintenanceWorkerDelta, MaintenanceWorkerEvent } from './maintenanceProtocol'
import {
  MAINTENANCE_PROTOCOL_VERSION,
  MaintenanceWorkerEventSchema,
  type MaintenanceWorkerRequest,
} from './maintenanceProtocol'
import { MAINTENANCE_CATALOG_DIGEST } from './maintenanceCatalog'
import type { MaintenanceWorkerInitRequest } from './maintenanceWorkerMessageRouter'
import type { MaintenanceWorkerEffectsDescriptor } from './maintenanceWorkerEffects'
import { createMaintenanceWorkerEffectsInit } from './maintenanceWorkerEffectsProtocol'

declare const AW_COMPILED_BUILD: boolean | undefined

interface WorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => unknown) | null
  addEventListener?(type: 'close', listener: (event: { readonly code?: number }) => void): void
  postMessage(message: unknown): void
  terminate(): void
}

export interface MaintenanceWorkerLiveState {
  readonly state: MaintenanceWorkerState
  readonly lastHeartbeatAt: number | null
  readonly error: string | null
  readonly active: null | {
    readonly runId: string
    readonly job: MaintenanceJobKey
    readonly startedAt: number
  }
}

interface MaintenanceWorkerSupervisorCommonOptions {
  readonly appHome: string
  readonly onDelta?: (runId: string, job: MaintenanceJobKey, delta: MaintenanceWorkerDelta) => void
  readonly onEvent?: (event: MaintenanceWorkerEvent) => void
  readonly workerFactory?: () => WorkerLike
  readonly effectsBootstrap?: MaintenanceWorkerEffectsDescriptor
  readonly now?: () => number
  readonly heartbeatTimeoutMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

/**
 * init 帧里**连库参数**那一半；协议头（`type` / `version` / `catalogDigest` / `appHome`）由监工
 * 自己补——那是它的身份，不该让装配方拼。
 *
 * RFC-359 AC-10 第十一波：这里原来是 `MaintenanceWorkerSupervisorOptions` 上一个按
 * `provider` 字面量判别的联合，监工体内因此问一次 `options.provider === 'postgresql'`，
 * 决定发哪一种 init 帧。两种帧的字段互不相同（`MaintenanceWorkerInitSchema` 是 protocol 里的
 * **strict** 联合），所以这不是「能力差异」而是**两种线格式**——把它做成 traits 或能力查询都不对。
 *
 * 处方与 §5fc 的维护服务同类：**交答案**。装配方本来就知道自己在装哪个 provider，直接把这一半
 * 帧交出来，监工只负责补协议头再 `post`。于是监工体内一个 provider 名都不问。
 *
 * 注意 `sqlite.busyTimeoutMs` 变成**必填**：原来监工里写 `options.sqlite.busyTimeoutMs ?? 50`，
 * 那是「没写就静默当 50」——本 RFC 要消灭的正是这种落进 else 的默认，只不过它穿的是 `??`。
 * 装配方本来就知道自己要多少，写出来。
 */
export type MaintenanceWorkerDatabaseInit =
  | Readonly<{
      dbPath: string
      migrationsFolder: string
      sqlite: Readonly<{
        synchronous: 'NORMAL' | 'FULL'
        pageCacheMib: number
        mmapMib: number
        busyTimeoutMs: number
      }>
    }>
  | Readonly<{
      provider: 'postgresql'
      generationId: string
      database: Readonly<{
        provider: 'postgresql'
        urlEnv: string
        poolMax: number
        connectTimeoutMs: number
        statementTimeoutMs: number
        idleTimeoutMs: number
      }>
    }>

export type MaintenanceWorkerSupervisorOptions = MaintenanceWorkerSupervisorCommonOptions &
  Readonly<{ databaseInit: MaintenanceWorkerDatabaseInit }>

export interface MaintenanceWorkerSupervisor {
  wake(): void
  live(): MaintenanceWorkerLiveState
  pause(timeoutMs?: number): Promise<void>
  resume(): Promise<void>
  stop(timeoutMs?: number): Promise<void>
  /** RFC-338 compatibility name for the permanent stop operation. */
  drain(timeoutMs?: number): Promise<void>
}

export interface ColdMaintenanceWorkerSupervisor extends MaintenanceWorkerSupervisor {
  /** Create the first Worker only here, and wait for its actual catalog handshake. */
  start(): Promise<void>
  /** Close wake/restart admission synchronously and request the same Worker's drain. */
  quiesce(): void
  /** A timeout rejects the caller; only the protocol's drained event settles this receipt. */
  awaitDrained(timeoutMs?: number): Promise<void>
}

// In source execution an absolute file URL is reliable. In a standalone Bun
// executable the Worker remains a separately bundled entry and MUST be opened
// by its relative entry name: resolving it through new URL(...).href produces
// an absolute /$bunfs/root URL that Bun 1.3 cannot map back to that entry. Keep
// both forms explicit; otherwise every release binary degrades with
// ModuleNotFound even though source-level Worker tests pass.
const MAINTENANCE_WORKER_ENTRY =
  typeof AW_COMPILED_BUILD === 'boolean' && AW_COMPILED_BUILD
    ? './platform/background/maintenanceWorker.ts'
    : new URL('./maintenanceWorker.ts', import.meta.url).href

const DEFAULT_FACTORY = (): WorkerLike =>
  new Worker(MAINTENANCE_WORKER_ENTRY) as unknown as WorkerLike

const FAILURE_DRAIN_TIMEOUT_MS = 10_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function startMaintenanceWorkerSupervisor(
  options: MaintenanceWorkerSupervisorOptions,
): MaintenanceWorkerSupervisor {
  return createSupervisor(options, false)
}

export function createColdMaintenanceWorkerSupervisor(
  options: MaintenanceWorkerSupervisorOptions,
): ColdMaintenanceWorkerSupervisor {
  return createSupervisor(options, true)
}

function createSupervisor(
  options: MaintenanceWorkerSupervisorOptions,
  cold: false,
): MaintenanceWorkerSupervisor
function createSupervisor(
  options: MaintenanceWorkerSupervisorOptions,
  cold: true,
): ColdMaintenanceWorkerSupervisor
function createSupervisor(
  options: MaintenanceWorkerSupervisorOptions,
  cold: boolean,
): MaintenanceWorkerSupervisor | ColdMaintenanceWorkerSupervisor {
  const now = options.now ?? Date.now
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000
  const watchdogIntervalMs = Math.max(250, Math.min(5_000, Math.floor(heartbeatTimeoutMs / 3)))
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const factory = options.workerFactory ?? DEFAULT_FACTORY

  let worker: WorkerLike | null = null
  let stopped = false
  let paused = cold
  let restartAttempt = 0
  let restartTimer: unknown | null = null
  let handshakeTimer: unknown | null = null
  let watchdogTimer: unknown | null = null
  let failureDrainTimer: unknown | null = null
  let restartAfterDrainReason: string | null = null
  let drainResolve: (() => void) | null = null
  let lifecycleDrain: Promise<void> | null = null
  let live: MaintenanceWorkerLiveState = {
    state: cold ? 'stopped' : 'starting',
    lastHeartbeatAt: null,
    error: null,
    active: null,
  }

  interface ColdWorkerReceipt {
    readonly worker: WorkerLike
    readonly ready: Promise<void>
    readonly drained: Promise<void>
    readonly resolveReady: () => void
    readonly rejectReady: (error: Error) => void
    readonly resolveDrained: () => void
    readySettled: boolean
    drainRequested: boolean
  }
  let coldReceipt: ColdWorkerReceipt | null = null
  let coldStart: Promise<void> | null = null
  let coldStartAttempt: { quiesced: boolean } | null = null
  let coldStarted = false
  const outstandingColdReceipts = new Set<ColdWorkerReceipt>()

  const rejectColdReady = (reason: string): void => {
    const receipt = coldReceipt
    if (receipt === null || receipt.readySettled) return
    receipt.readySettled = true
    receipt.rejectReady(new Error(reason))
  }

  const post = (request: MaintenanceWorkerRequest): void => worker?.postMessage(request)
  const clearHandshake = (): void => {
    if (handshakeTimer !== null) clearTimer(handshakeTimer)
    handshakeTimer = null
  }
  const clearWatchdog = (): void => {
    if (watchdogTimer !== null) clearTimer(watchdogTimer)
    watchdogTimer = null
  }
  const clearFailureDrain = (): void => {
    if (failureDrainTimer !== null) clearTimer(failureDrainTimer)
    failureDrainTimer = null
  }
  const quiesce = (): void => {
    paused = true
    if (coldStartAttempt !== null) coldStartAttempt.quiesced = true
    if (restartTimer !== null) clearTimer(restartTimer)
    restartTimer = null
    clearHandshake()
    clearWatchdog()
    clearFailureDrain()
    restartAfterDrainReason = null
    rejectColdReady('maintenance worker quiesced before ready')
    const receipt = coldReceipt
    if (receipt === null || worker !== receipt.worker || receipt.drainRequested) return
    receipt.drainRequested = true
    try {
      post({ type: 'drain', version: MAINTENANCE_PROTOCOL_VERSION })
    } catch (error) {
      // Keep both the Worker and its receipt so a later quiesce can retry the frame.
      receipt.drainRequested = false
      live = { ...live, state: 'degraded', error: messageOf(error) }
    }
  }
  const awaitDrained = (timeoutMs = 10_000): Promise<void> => {
    const receipts = [...outstandingColdReceipts]
    if (receipts.length === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimer(() => {
        reject(new Error('maintenance worker actual drain timed out'))
      }, timeoutMs)
      void Promise.all(receipts.map((receipt) => receipt.drained))
        .then(() => {
          clearTimer(timeout)
          resolve()
        })
        .catch(reject)
    })
  }
  const scheduleSpawn = (): void => {
    if (cold) return
    if (stopped || paused || worker !== null || restartTimer !== null) return
    if (restartAttempt >= 6) return
    const delay = Math.min(10_000, 250 * 2 ** restartAttempt)
    restartAttempt += 1
    restartTimer = setTimer(() => {
      restartTimer = null
      spawn()
    }, delay)
    ;(restartTimer as { unref?: () => void } | null)?.unref?.()
  }
  const forceStopFailedWorker = (reason: string): void => {
    clearFailureDrain()
    restartAfterDrainReason = null
    worker?.terminate()
    worker = null
    live = { ...live, state: 'degraded', error: reason, active: null }
    scheduleSpawn()
  }
  const scheduleRestart = (reason: string, force = false): void => {
    if (cold) {
      rejectColdReady(reason)
      live = { ...live, state: 'degraded', error: reason }
      quiesce()
      return
    }
    if (stopped || paused) return
    clearHandshake()
    clearWatchdog()
    live = { ...live, state: 'degraded', error: reason, active: null }
    if (worker === null) {
      scheduleSpawn()
      return
    }
    if (force) {
      forceStopFailedWorker(reason)
      return
    }
    if (restartAfterDrainReason !== null) return

    // A maintenance Worker owns a live bun:sqlite connection. Forcefully
    // terminating that thread while SQLite statements are unwinding can take
    // the request-serving daemon down with it. Error events are cancelable, so
    // keep this generation alive just long enough to finish its bounded slice,
    // close the connection, and emit `drained`; only the timeout fallback uses
    // terminate(), matching the already-safe explicit shutdown path below.
    const failedWorker = worker
    restartAfterDrainReason = reason
    post({ type: 'drain', version: MAINTENANCE_PROTOCOL_VERSION })
    failureDrainTimer = setTimer(() => {
      // A cleared timeout may already be queued. Fence it to the generation
      // that requested the drain so it can never terminate a healthy
      // replacement Worker.
      if (worker === failedWorker && restartAfterDrainReason === reason) {
        forceStopFailedWorker(reason)
      }
    }, FAILURE_DRAIN_TIMEOUT_MS)
    ;(failureDrainTimer as { unref?: () => void } | null)?.unref?.()
  }

  const scheduleWatchdog = (): void => {
    if (stopped || paused || live.state !== 'ready' || watchdogTimer !== null) return
    watchdogTimer = setTimer(() => {
      watchdogTimer = null
      if (stopped || paused || live.state !== 'ready') return
      const lastHeartbeatAt = live.lastHeartbeatAt
      if (lastHeartbeatAt !== null && now() - lastHeartbeatAt > heartbeatTimeoutMs) {
        // A Worker that cannot answer its heartbeat also cannot be trusted to
        // process a drain request. Preserve the forceful watchdog fallback.
        scheduleRestart('maintenance worker heartbeat timed out', true)
        return
      }
      scheduleWatchdog()
    }, watchdogIntervalMs)
    ;(watchdogTimer as { unref?: () => void } | null)?.unref?.()
  }

  const handleEvent = (raw: unknown): void => {
    let event: MaintenanceWorkerEvent
    try {
      event = MaintenanceWorkerEventSchema.parse(raw)
    } catch (error) {
      scheduleRestart(`maintenance worker emitted an invalid event: ${messageOf(error)}`)
      return
    }
    options.onEvent?.(event)
    switch (event.type) {
      case 'ready':
        if (event.catalogDigest !== MAINTENANCE_CATALOG_DIGEST) {
          scheduleRestart('maintenance worker catalog digest mismatch')
          return
        }
        clearHandshake()
        restartAttempt = 0
        live = { state: 'ready', lastHeartbeatAt: event.at, error: null, active: null }
        if (coldReceipt !== null && !coldReceipt.readySettled && !stopped && !paused) {
          coldReceipt.readySettled = true
          coldReceipt.resolveReady()
        }
        scheduleWatchdog()
        // A generation that finished its handshake after pause/stop already
        // requested a drain. Waking it would admit a slice this supervisor is
        // waiting to see finish.
        if (!stopped && !paused) post({ type: 'wake', version: MAINTENANCE_PROTOCOL_VERSION })
        return
      case 'heartbeat':
        live = { ...live, lastHeartbeatAt: event.at }
        return
      case 'active':
        live = {
          ...live,
          state: 'ready',
          error: null,
          active: { runId: event.runId, job: event.job, startedAt: event.startedAt },
        }
        return
      case 'completed':
        if (live.active?.runId === event.runId) live = { ...live, active: null }
        options.onDelta?.(event.runId, event.job, event.delta)
        return
      case 'degraded':
        scheduleRestart(event.error)
        return
      case 'drained': {
        clearHandshake()
        clearWatchdog()
        clearFailureDrain()
        const restartReason = restartAfterDrainReason
        restartAfterDrainReason = null
        if (coldReceipt !== null && coldReceipt.worker === worker) {
          rejectColdReady('maintenance worker drained before ready')
          outstandingColdReceipts.delete(coldReceipt)
          coldReceipt.resolveDrained()
        }
        worker?.terminate()
        worker = null
        if (!stopped && !paused && restartReason !== null) {
          live = {
            state: 'degraded',
            lastHeartbeatAt: event.at,
            error: restartReason,
            active: null,
          }
          scheduleSpawn()
          return
        }
        live = { state: 'stopped', lastHeartbeatAt: event.at, error: null, active: null }
        const resolve = drainResolve
        drainResolve = null
        resolve?.()
        return
      }
    }
  }

  function spawn(): void {
    if (stopped || paused || worker !== null) return
    try {
      const next = factory()
      worker = next
      if (cold) {
        let resolveReady!: () => void
        let rejectReady!: (error: Error) => void
        let resolveDrained!: () => void
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve
          rejectReady = reject
        })
        // quiesce/error can reject before the start caller attaches its await.
        void ready.catch(() => undefined)
        const drained = new Promise<void>((resolve) => {
          resolveDrained = resolve
        })
        coldReceipt = {
          worker: next,
          ready,
          drained,
          resolveReady,
          rejectReady,
          resolveDrained,
          readySettled: false,
          drainRequested: false,
        }
        outstandingColdReceipts.add(coldReceipt)
      }
      live = { ...live, state: 'starting', error: null, active: null }
      next.onmessage = (event) => {
        if (worker !== next) return
        handleEvent(event.data)
      }
      next.onerror = (event) => {
        // A Worker ErrorEvent is cancelable. Merely observing it does not stop
        // the default propagation into the daemon process; under Bun that
        // turns a recoverable Worker failure into a daemon-wide exit before
        // this supervisor can restart from the durable lease/cursor. Cancel
        // first, including for a late event from a terminated generation.
        event.preventDefault()
        if (worker !== next) return true
        const reason =
          event.message ||
          (event.error instanceof Error ? event.error.message : '') ||
          'maintenance worker error'
        // Let the cancelable ErrorEvent finish before terminating this Worker.
        // Bun 1.3 otherwise still has a window where the Worker exception can
        // win the race and abort the owning daemon.
        const failureTimer = setTimer(() => {
          if (worker === next) scheduleRestart(reason)
        }, 0)
        ;(failureTimer as { unref?: () => void } | null)?.unref?.()
        return true
      }
      next.addEventListener?.('close', (event) => {
        // Bun 1.3.14 dispatches Worker close on the parent thread after the
        // Worker has released its native resources. A fatal Worker exit can
        // bypass both the protocol-level `degraded` event and the cancelable
        // ErrorEvent, so this is the final generation-fenced recovery edge.
        if (worker !== next) return
        clearHandshake()
        clearWatchdog()
        clearFailureDrain()
        const pendingRestartReason = restartAfterDrainReason
        restartAfterDrainReason = null
        if (cold) rejectColdReady('maintenance worker closed before ready')
        worker = null

        if (stopped || paused) {
          live = { ...live, state: 'stopped', error: null, active: null }
          const resolve = drainResolve
          drainResolve = null
          resolve?.()
          return
        }

        const code = typeof event.code === 'number' ? ` (code=${event.code})` : ''
        live = {
          ...live,
          state: 'degraded',
          error: pendingRestartReason ?? `maintenance worker closed unexpectedly${code}`,
          active: null,
        }
        scheduleSpawn()
      })
      const init: MaintenanceWorkerInitRequest = {
        type: 'init',
        version: MAINTENANCE_PROTOCOL_VERSION,
        catalogDigest: MAINTENANCE_CATALOG_DIGEST,
        appHome: options.appHome,
        ...options.databaseInit,
      }
      if (options.effectsBootstrap === undefined) post(init)
      else next.postMessage(createMaintenanceWorkerEffectsInit(init, options.effectsBootstrap))
      if (cold && (stopped || paused || coldReceipt?.readySettled)) return
      handshakeTimer = setTimer(
        () => scheduleRestart('maintenance worker handshake timed out', true),
        10_000,
      )
      ;(handshakeTimer as { unref?: () => void } | null)?.unref?.()
    } catch (error) {
      scheduleRestart(messageOf(error))
    }
  }

  if (!cold) spawn()

  const drainWorker = (timeoutMs: number): Promise<void> => {
    if (lifecycleDrain !== null) return lifecycleDrain
    if (restartTimer !== null) clearTimer(restartTimer)
    restartTimer = null
    clearHandshake()
    clearWatchdog()
    clearFailureDrain()
    restartAfterDrainReason = null
    if (worker === null) {
      live = { ...live, state: 'stopped', active: null }
      return Promise.resolve()
    }
    const pending = new Promise<void>((resolve) => {
      const drainingWorker = worker
      let timeout: unknown | null = null
      drainResolve = () => {
        if (timeout !== null) clearTimer(timeout)
        resolve()
      }
      const onTimeout = (): void => {
        if (cold && worker !== drainingWorker) return
        worker?.terminate()
        worker = null
        live = {
          state: 'stopped',
          lastHeartbeatAt: live.lastHeartbeatAt,
          error: 'maintenance worker drain timed out',
          active: null,
        }
        const finish = drainResolve
        drainResolve = null
        finish?.()
      }
      // A synchronous test Worker may ACK postMessage. Arm first in the cold
      // path so a stale normal-pause timeout cannot terminate a later Worker.
      if (cold) timeout = setTimer(onTimeout, timeoutMs)
      post({ type: 'drain', version: MAINTENANCE_PROTOCOL_VERSION })
      if (!cold) timeout = setTimer(onTimeout, timeoutMs)
      ;(timeout as { unref?: () => void } | null)?.unref?.()
    }).finally(() => {
      if (lifecycleDrain === pending) lifecycleDrain = null
    })
    lifecycleDrain = pending
    return pending
  }

  const start = (): Promise<void> => {
    if (stopped) return Promise.reject(new Error('maintenance worker supervisor stopped'))
    if (coldStart !== null) return coldStart
    if (!paused && worker !== null && live.state === 'ready') return Promise.resolve()
    coldStarted = true
    const attempt = { quiesced: false }
    coldStartAttempt = attempt
    const pending = (async () => {
      // The old ready state must stay fenced while its actual ACK is pending,
      // including after a rejected wait. Only then may a fresh Worker start.
      await awaitDrained()
      if (stopped || attempt.quiesced) throw new Error('maintenance worker start quiesced')
      paused = false
      spawn()
      const receipt = coldReceipt
      if (receipt === null || worker !== receipt.worker) {
        throw new Error(live.error ?? 'maintenance worker failed to start')
      }
      // The synchronous factory may have fenced the attempt before this new
      // receipt existed. Request its actual drain before awaiting readiness.
      if (stopped || paused || attempt.quiesced) {
        quiesce()
        throw new Error('maintenance worker start quiesced')
      }
      await receipt.ready
      if (stopped || paused || attempt.quiesced || worker !== receipt.worker) {
        throw new Error('maintenance worker start quiesced')
      }
    })()
      .catch((error: unknown) => {
        quiesce()
        throw error
      })
      .finally(() => {
        if (coldStart === pending) coldStart = null
        if (coldStartAttempt === attempt) coldStartAttempt = null
      })
    coldStart = pending
    return pending
  }

  const supervisor: MaintenanceWorkerSupervisor = {
    wake() {
      if (stopped || paused) return
      if (!cold && worker === null && restartTimer === null) {
        restartAttempt = Math.min(restartAttempt, 5)
        spawn()
      }
      if (live.state === 'ready') post({ type: 'wake', version: MAINTENANCE_PROTOCOL_VERSION })
    },
    live: () => live,
    pause(timeoutMs = 10_000) {
      if (coldStartAttempt !== null) coldStartAttempt.quiesced = true
      if (stopped || paused) return lifecycleDrain ?? Promise.resolve()
      paused = true
      if (cold) rejectColdReady('maintenance worker paused before ready')
      return drainWorker(timeoutMs)
    },
    async resume() {
      if (stopped || !paused) return
      if (cold) {
        // Publish the cold attempt before any normal-pause ACK wait so loss
        // during that wait cannot be forgotten by a later deferred start.
        if (coldStarted) await start()
        return
      }
      await lifecycleDrain
      if (stopped || !paused) return
      paused = false
      live = { state: 'starting', lastHeartbeatAt: live.lastHeartbeatAt, error: null, active: null }
      spawn()
    },
    stop(timeoutMs = 10_000) {
      if (coldStartAttempt !== null) coldStartAttempt.quiesced = true
      if (stopped) return lifecycleDrain ?? Promise.resolve()
      stopped = true
      paused = false
      if (cold) rejectColdReady('maintenance worker stopped before ready')
      return drainWorker(timeoutMs)
    },
    drain(timeoutMs = 10_000) {
      if (coldStartAttempt !== null) coldStartAttempt.quiesced = true
      if (stopped) return lifecycleDrain ?? Promise.resolve()
      stopped = true
      paused = false
      if (cold) rejectColdReady('maintenance worker stopped before ready')
      return drainWorker(timeoutMs)
    },
  }
  return cold ? { ...supervisor, start, quiesce, awaitDrained } : supervisor
}
