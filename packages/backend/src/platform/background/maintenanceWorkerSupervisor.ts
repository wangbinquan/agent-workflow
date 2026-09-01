import type { MaintenanceJobKey, MaintenanceWorkerState } from '@agent-workflow/shared'

import type { MaintenanceWorkerDelta, MaintenanceWorkerEvent } from './maintenanceProtocol'
import {
  MAINTENANCE_PROTOCOL_VERSION,
  MaintenanceWorkerEventSchema,
  type MaintenanceWorkerRequest,
} from './maintenanceProtocol'
import { MAINTENANCE_CATALOG_DIGEST } from './maintenanceCatalog'

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
  readonly now?: () => number
  readonly heartbeatTimeoutMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export type MaintenanceWorkerSupervisorOptions = MaintenanceWorkerSupervisorCommonOptions &
  (
    | Readonly<{
        provider?: 'sqlite'
        dbPath: string
        migrationsFolder: string
        sqlite: {
          readonly synchronous: 'NORMAL' | 'FULL'
          readonly pageCacheMib: number
          readonly mmapMib: number
          readonly busyTimeoutMs?: number
        }
        generationId?: never
        database?: never
      }>
    | Readonly<{
        provider: 'postgresql'
        dbPath?: never
        migrationsFolder?: never
        sqlite?: never
        generationId: string
        database: {
          readonly provider: 'postgresql'
          readonly urlEnv: string
          readonly poolMax: number
          readonly connectTimeoutMs: number
          readonly statementTimeoutMs: number
          readonly idleTimeoutMs: number
        }
      }>
  )

export interface MaintenanceWorkerSupervisor {
  wake(): void
  live(): MaintenanceWorkerLiveState
  pause(timeoutMs?: number): Promise<void>
  resume(): Promise<void>
  stop(timeoutMs?: number): Promise<void>
  /** RFC-338 compatibility name for the permanent stop operation. */
  drain(timeoutMs?: number): Promise<void>
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
  const now = options.now ?? Date.now
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000
  const watchdogIntervalMs = Math.max(250, Math.min(5_000, Math.floor(heartbeatTimeoutMs / 3)))
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const factory = options.workerFactory ?? DEFAULT_FACTORY

  let worker: WorkerLike | null = null
  let stopped = false
  let paused = false
  let restartAttempt = 0
  let restartTimer: unknown | null = null
  let handshakeTimer: unknown | null = null
  let watchdogTimer: unknown | null = null
  let failureDrainTimer: unknown | null = null
  let restartAfterDrainReason: string | null = null
  let drainResolve: (() => void) | null = null
  let lifecycleDrain: Promise<void> | null = null
  let live: MaintenanceWorkerLiveState = {
    state: 'starting',
    lastHeartbeatAt: null,
    error: null,
    active: null,
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
  const scheduleSpawn = (): void => {
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
      if (options.provider === 'postgresql') {
        post({
          type: 'init',
          version: MAINTENANCE_PROTOCOL_VERSION,
          catalogDigest: MAINTENANCE_CATALOG_DIGEST,
          provider: 'postgresql',
          generationId: options.generationId,
          appHome: options.appHome,
          database: options.database,
        })
      } else {
        post({
          type: 'init',
          version: MAINTENANCE_PROTOCOL_VERSION,
          catalogDigest: MAINTENANCE_CATALOG_DIGEST,
          dbPath: options.dbPath,
          migrationsFolder: options.migrationsFolder,
          appHome: options.appHome,
          sqlite: {
            synchronous: options.sqlite.synchronous,
            pageCacheMib: options.sqlite.pageCacheMib,
            mmapMib: options.sqlite.mmapMib,
            busyTimeoutMs: options.sqlite.busyTimeoutMs ?? 50,
          },
        })
      }
      handshakeTimer = setTimer(
        () => scheduleRestart('maintenance worker handshake timed out', true),
        10_000,
      )
      ;(handshakeTimer as { unref?: () => void } | null)?.unref?.()
    } catch (error) {
      scheduleRestart(messageOf(error))
    }
  }

  spawn()

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
      let timeout: unknown | null = null
      drainResolve = () => {
        if (timeout !== null) clearTimer(timeout)
        resolve()
      }
      post({ type: 'drain', version: MAINTENANCE_PROTOCOL_VERSION })
      timeout = setTimer(() => {
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
      }, timeoutMs)
      ;(timeout as { unref?: () => void } | null)?.unref?.()
    }).finally(() => {
      if (lifecycleDrain === pending) lifecycleDrain = null
    })
    lifecycleDrain = pending
    return pending
  }

  return {
    wake() {
      if (stopped || paused) return
      if (worker === null && restartTimer === null) {
        restartAttempt = Math.min(restartAttempt, 5)
        spawn()
      }
      if (live.state === 'ready') post({ type: 'wake', version: MAINTENANCE_PROTOCOL_VERSION })
    },
    live: () => live,
    pause(timeoutMs = 10_000) {
      if (stopped || paused) return lifecycleDrain ?? Promise.resolve()
      paused = true
      return drainWorker(timeoutMs)
    },
    async resume() {
      if (stopped || !paused) return
      await lifecycleDrain
      if (stopped || !paused) return
      paused = false
      live = { state: 'starting', lastHeartbeatAt: live.lastHeartbeatAt, error: null, active: null }
      spawn()
    },
    stop(timeoutMs = 10_000) {
      if (stopped) return lifecycleDrain ?? Promise.resolve()
      stopped = true
      paused = false
      return drainWorker(timeoutMs)
    },
    drain(timeoutMs = 10_000) {
      if (stopped) return lifecycleDrain ?? Promise.resolve()
      stopped = true
      paused = false
      return drainWorker(timeoutMs)
    },
  }
}
