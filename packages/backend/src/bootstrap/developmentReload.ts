// Development-only reloader. Bun --hot retains its state in globalThis;
// ordinary CLI starts never receive its process-local integrity preparation.
import {
  createNativeDaemonHostLifecycle,
  type DaemonHostLifecyclePort,
  type DaemonHostShutdownCallbacks,
} from '@/modules/system-operations/composition/daemonHostLifecycle'
import { Paths } from '@/platform/configuration/installationPaths'

export interface DevelopmentOverlay {
  readonly daemonHost: DaemonHostLifecyclePort
  readonly developmentIntegrity: { validatedDatabase?: string }
  /** The port the previous source generation listened on; absent for the first one. */
  readonly listenPort?: number
}

export interface DevelopmentDaemonState {
  revision: number
  tail: Promise<void>
  current?: { stop(): Promise<void> }
  integrity: DevelopmentOverlay['developmentIntegrity']
  /** Where the last generation that became ready listened. A failed start does not forget it. */
  listenPort?: number
}

/**
 * The port a daemon start binds. A configured port is somebody's choice and is bound as is. With
 * none configured (0) the port is ephemeral, and a development reload then listens where its
 * previous generation did, so the daemon keeps one address for the whole session — unless another
 * process has taken that port since, in which case any free port still starts the daemon.
 *
 * Without this every source reload moved to a new ephemeral port, and whatever had read the address
 * once was left pointing at a closed one: Vite resolves its `/api` proxy from `.daemon.info` when it
 * starts, so every request answered 500 after the first backend save (2026-11-26).
 */
export function developmentListenPort(input: {
  /** 0: nothing configures a port. */
  readonly configured: number
  readonly previous: number | undefined
  readonly isFree: (port: number) => boolean
}): number {
  if (input.configured !== 0 || input.previous === undefined) return input.configured
  return input.isFree(input.previous) ? input.previous : 0
}

/**
 * Whether the port can be bound on this host right now, found out by binding it. The caller binds
 * for real in its very next statement, in the same process: a port another process takes in between
 * fails that bind with an explicit error, and the reload after it finds the port taken and moves on.
 */
export function portIsFree(hostname: string, port: number): boolean {
  try {
    Bun.listen({ hostname, port, socket: { data() {} } }).stop(true)
    return true
  } catch {
    return false
  }
}

export function createDevelopmentDaemonState(): DevelopmentDaemonState {
  return { revision: 0, tail: Promise.resolve(), integrity: {} }
}

/** Coalesce saves during boot/drain and finish the old session before replacing it. */
export function reloadDevelopmentDaemon(
  state: DevelopmentDaemonState,
  start: (development: DevelopmentOverlay) => Promise<void>,
  createHost: () => DaemonHostLifecyclePort = () =>
    createNativeDaemonHostLifecycle({
      infoPath: Paths.daemonInfo,
      controlPath: Paths.controlFile,
      pid: process.pid,
      devWatch: true,
    }),
): Promise<void> {
  const revision = ++state.revision
  const next = state.tail
    .catch(() => undefined)
    .then(async () => {
      if (revision !== state.revision) return
      await state.current?.stop()
      state.current = undefined
      if (revision !== state.revision) return

      const ready = Promise.withResolvers<void>()
      const stopped = Promise.withResolvers<void>()
      void stopped.promise.catch(() => undefined)
      const native = createHost()
      let callbacks: DaemonHostShutdownCallbacks | undefined
      let reloading = false
      const generation = {
        async stop(): Promise<void> {
          if (callbacks === undefined) throw new Error('development-daemon-not-ready')
          reloading = true
          void Promise.resolve(callbacks.onShutdown('source-reload')).catch(stopped.reject)
          await stopped.promise
        },
      }
      const host: DaemonHostLifecyclePort = {
        readCurrent: () => native.readCurrent(),
        withdrawReady: () => native.withdrawReady(),
        announceReady: (url) => native.announceReady(url),
        async publishReady(info) {
          await native.publishReady(info)
          state.listenPort = info.port
          ready.resolve()
        },
        subscribeShutdown(input) {
          callbacks = input
          return native.subscribeShutdown(input)
        },
        terminate(code) {
          if (!reloading) return native.terminate(code)
          if (code === 0) stopped.resolve()
          else stopped.reject(new Error(`development-daemon-stop-failed: ${code}`))
          // The retired CLI invocation remains parked without a live listener,
          // worker, control channel or signal subscription. Only the new one runs.
          return new Promise<never>(() => {})
        },
      }
      state.current = generation
      void start({
        daemonHost: host,
        developmentIntegrity: state.integrity,
        ...(state.listenPort === undefined ? {} : { listenPort: state.listenPort }),
      }).catch((error) => {
        state.integrity.validatedDatabase = undefined
        if (state.current === generation) state.current = undefined
        ready.reject(error)
        stopped.reject(error)
      })
      await ready.promise
      console.info(`[dev] source generation ${revision} ready`)
    })
  state.tail = next
  return next
}
