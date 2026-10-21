// Development-only reloader. Bun --hot retains its state in globalThis;
// ordinary CLI starts never receive its process-local integrity preparation.
import type { StartOptions } from './start'
import {
  selectDaemonHostLifecycle,
  type DaemonHostLifecyclePort,
  type DaemonHostShutdownCallbacks,
} from '@/modules/system-operations/composition/daemonHostLifecycle'
import { Paths } from '@/util/paths'

export interface DevelopmentDaemonState {
  revision: number
  tail: Promise<void>
  current?: { stop(): Promise<void> }
  integrity: NonNullable<StartOptions['developmentIntegrity']>
}

export function createDevelopmentDaemonState(): DevelopmentDaemonState {
  return { revision: 0, tail: Promise.resolve(), integrity: {} }
}

/** Coalesce saves during boot/drain and finish the old session before replacing it. */
export function reloadDevelopmentDaemon(
  state: DevelopmentDaemonState,
  start: (options: StartOptions) => Promise<void>,
  createHost: () => DaemonHostLifecyclePort = () =>
    selectDaemonHostLifecycle(undefined, {
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
      void start({ daemonHost: host, developmentIntegrity: state.integrity }).catch((error) => {
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
