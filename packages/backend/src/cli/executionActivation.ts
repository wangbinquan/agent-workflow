// RFC-370 v2 §3.2 — the daemon's background set starts when the instance first
// holds execution authority. A standalone authority is active from start, so
// its factories are returned unchanged and start exactly as before. A hosted
// standby instance serves HTTP only; its background handles start on
// activation, and an activation failure is reported so the instance exits and
// restarts as standby (crash-only).
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import type {
  DaemonProviderRuntimeHandle,
  DaemonProviderRuntimeHandleFactory,
} from './daemonProviderRuntimeSession'

export function startOnExecutionActive(
  authority: Pick<ExecutionAuthorityPort, 'current' | 'whenActive'>,
  factory: DaemonProviderRuntimeHandleFactory,
  onActivationFailure: (error: unknown) => void,
): DaemonProviderRuntimeHandleFactory {
  if (authority.current().kind === 'active') return factory
  return Object.freeze({
    id: factory.id,
    start(input) {
      let phase: 'waiting' | 'starting' | 'started' | 'stopped' = 'waiting'
      let handle: DaemonProviderRuntimeHandle | undefined
      const starting = authority.whenActive().then(async () => {
        if (phase !== 'waiting') return
        phase = 'starting'
        try {
          handle = await factory.start(input)
          if (phase === 'starting') phase = 'started'
        } catch (error) {
          onActivationFailure(error)
        }
      })
      return Object.freeze({
        async stop() {
          const previous = phase
          phase = 'stopped'
          // A handle still waiting for authority never started; one that is
          // starting finishes before it is stopped.
          if (previous === 'starting') await starting
          await handle?.stop()
        },
        async drain() {
          if (phase === 'starting') await starting
          await handle?.drain()
        },
      } satisfies DaemonProviderRuntimeHandle)
    },
  } satisfies DaemonProviderRuntimeHandleFactory)
}

/**
 * Requests to leave the process because execution authority was lost or the
 * background set failed to activate. The daemon host subscribes once it runs;
 * a request made before that is delivered on subscription.
 */
export function createExecutionExitRequests(): {
  readonly request: (reason: string) => void
  readonly subscribe: (requestExit: (reason: string) => void) => void
} {
  let deliver: ((reason: string) => void) | undefined
  const pending: string[] = []
  return Object.freeze({
    request(reason: string) {
      if (deliver === undefined) pending.push(reason)
      else deliver(reason)
    },
    subscribe(requestExit: (reason: string) => void) {
      deliver = requestExit
      for (const reason of pending.splice(0)) requestExit(reason)
    },
  })
}
