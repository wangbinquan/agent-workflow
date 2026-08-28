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

export interface MaintenanceWorkerSupervisorOptions {
  readonly dbPath: string
  readonly migrationsFolder: string
  readonly appHome: string
  readonly sqlite: {
    readonly synchronous: 'NORMAL' | 'FULL'
    readonly pageCacheMib: number
    readonly mmapMib: number
    readonly busyTimeoutMs?: number
  }
  readonly onDelta?: (runId: string, job: MaintenanceJobKey, delta: MaintenanceWorkerDelta) => void
  readonly onEvent?: (event: MaintenanceWorkerEvent) => void
  readonly workerFactory?: () => WorkerLike
  readonly now?: () => number
  readonly heartbeatTimeoutMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export interface MaintenanceWorkerSupervisor {
  wake(): void
  live(): MaintenanceWorkerLiveState
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
  let restartAttempt = 0
  let restartTimer: unknown | null = null
  let handshakeTimer: unknown | null = null
  let watchdogTimer: unknown | null = null
  let drainResolve: (() => void) | null = null
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
  const scheduleRestart = (reason: string): void => {
    if (stopped) return
    clearHandshake()
    clearWatchdog()
    worker?.terminate()
    worker = null
    live = { ...live, state: 'degraded', error: reason, active: null }
    if (restartTimer !== null) return
    if (restartAttempt >= 6) return
    const delay = Math.min(10_000, 250 * 2 ** restartAttempt)
    restartAttempt += 1
    restartTimer = setTimer(() => {
      restartTimer = null
      spawn()
    }, delay)
    ;(restartTimer as { unref?: () => void } | null)?.unref?.()
  }

  const scheduleWatchdog = (): void => {
    if (stopped || live.state !== 'ready' || watchdogTimer !== null) return
    watchdogTimer = setTimer(() => {
      watchdogTimer = null
      if (stopped || live.state !== 'ready') return
      const lastHeartbeatAt = live.lastHeartbeatAt
      if (lastHeartbeatAt !== null && now() - lastHeartbeatAt > heartbeatTimeoutMs) {
        scheduleRestart('maintenance worker heartbeat timed out')
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
        post({ type: 'wake', version: MAINTENANCE_PROTOCOL_VERSION })
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
        worker?.terminate()
        worker = null
        live = { state: 'stopped', lastHeartbeatAt: event.at, error: null, active: null }
        const resolve = drainResolve
        drainResolve = null
        resolve?.()
        return
      }
    }
  }

  function spawn(): void {
    if (stopped || worker !== null) return
    try {
      const next = factory()
      worker = next
      live = { ...live, state: 'starting', error: null, active: null }
      next.onmessage = (event) => {
        if (worker !== next) return
        handleEvent(event.data)
      }
      next.onerror = (event) => {
        if (worker !== next) return
        scheduleRestart(event.message || 'maintenance worker error')
      }
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
      handshakeTimer = setTimer(
        () => scheduleRestart('maintenance worker handshake timed out'),
        10_000,
      )
      ;(handshakeTimer as { unref?: () => void } | null)?.unref?.()
    } catch (error) {
      scheduleRestart(messageOf(error))
    }
  }

  spawn()
  return {
    wake() {
      if (stopped) return
      if (worker === null && restartTimer === null) {
        restartAttempt = Math.min(restartAttempt, 5)
        spawn()
      }
      if (live.state === 'ready') post({ type: 'wake', version: MAINTENANCE_PROTOCOL_VERSION })
    },
    live: () => live,
    drain(timeoutMs = 10_000) {
      if (stopped) return Promise.resolve()
      stopped = true
      if (restartTimer !== null) clearTimer(restartTimer)
      restartTimer = null
      clearHandshake()
      clearWatchdog()
      if (worker === null) {
        live = { ...live, state: 'stopped', active: null }
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
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
      })
    },
  }
}
