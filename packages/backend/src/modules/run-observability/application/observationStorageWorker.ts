import type { ObservationExecutionLifetime } from './completeObservationExecution'
import { waitForExecutionActivation } from '@/platform/background/activation'

/** Maintenance has its own retry loop. A failed cleanup never stops or acknowledges source work. */
export function observationStorageWorker(input: {
  collect: () => Promise<number | { removed: number; scanned: number }>
  sample: () => Promise<void>
  failed: (error: unknown) => Promise<void>
  cancelSample?: () => void
  resumeSample?: () => void
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => () => void
  executionMode?: 'native' | 'host'
}) {
  const now = input.now ?? Date.now,
    schedule =
      input.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        return () => clearTimeout(timer)
      })
  let nextSample = 0
  let stopped = false,
    cancel: (() => void) | undefined,
    pending: Promise<void> | undefined
  let current: (() => boolean) | undefined
  let activation: { readonly control: AbortController; readonly done: Promise<void> } | undefined
  const settlements = new Set<() => Promise<void>>()
  const accepting = () => !stopped && (current?.() ?? true)
  function tick() {
    if (!accepting() || pending) return
    cancel = undefined
    const startedAt = now()
    let nextDelay = 60000
    pending = (async () => {
      const result = await input.collect(),
        active = typeof result === 'number' ? result > 0 : result.removed > 0 || result.scanned > 0
      // Empty sweeps and failures must not turn a quiet database into a write
      // workload. Productive passes yield at least 19x their elapsed time, so
      // catch-up cannot monopolize the request-serving SQLite connection.
      if (active) nextDelay = Math.max(1000, (now() - startedAt) * 19)
      if ((!current || accepting()) && now() >= nextSample) {
        await input.sample()
        nextSample = now() + 60000
      }
    })()
      .catch(async (error) => {
        if (!accepting() && error instanceof Error && error.name === 'AbortError') return
        nextDelay = 60000
        try {
          if (current) {
            const write = () => input.failed(error)
            settlements.add(write)
            await write()
            settlements.delete(write)
          } else await input.failed(error)
        } catch {
          /* Durable state is retried after the database recovers. */
        }
      })
      .finally(() => {
        pending = undefined
        if (accepting() && !settlements.size) cancel = schedule(tick, nextDelay)
      })
  }
  return {
    start(execution?: ObservationExecutionLifetime) {
      if (input.executionMode === 'host' && (!execution || !execution.current()))
        throw new Error('observation-storage-host-lifetime-required')
      if (settlements.size) throw new Error('observation-storage-unsettled-work')
      if (cancel || pending) return
      const controlCurrent = execution?.current.bind(execution),
        dispatch = execution?.canDispatch?.bind(execution)
      current = execution ? () => controlCurrent!() && (dispatch?.() ?? true) : undefined
      stopped = false
      input.resumeSample?.()
      if (execution?.whenActive === undefined) tick()
      else {
        const control = new AbortController()
        const done = waitForExecutionActivation(execution.whenActive, control.signal).then(
          (active) => {
            if (active && accepting()) tick()
          },
        )
        activation = { control, done }
        void done.catch(() => {})
      }
    },
    async drain() {
      await pending
    },
    async stop() {
      stopped = true
      input.cancelSample?.()
      activation?.control.abort()
      cancel?.()
      cancel = undefined
      await Promise.all([pending, activation?.done])
    },
    quiesce() {
      stopped = true
      input.cancelSample?.()
      activation?.control.abort()
      cancel?.()
      cancel = undefined
    },
    async drainAuthority() {
      if (!stopped) throw new Error('observation-storage-drain-before-quiesce')
      await Promise.all([pending, activation?.done])
      for (const write of settlements) {
        await write()
        settlements.delete(write)
      }
    },
  }
}
