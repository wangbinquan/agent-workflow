import type {
  IncrementalObservationProjectionStore,
  IncrementalObservationWork,
} from '../ports/incrementalObservationProjection'
import type { ObservationExecutionLifetime } from './completeObservationExecution'
import { waitForExecutionActivation } from '@/platform/background/activation'

/** One daemon-owned consumer; HTTP queries never start this work. Each packet
 * is a scheduling budget only, and a nonempty queue is immediately drained. */
export function incrementalObservationWorker(input: {
  readonly store: IncrementalObservationProjectionStore
  readonly bootstrap: (signal: AbortSignal) => Promise<number>
  readonly dispatch: () => Promise<number>
  readonly prepare: (
    work: IncrementalObservationWork,
    signal: AbortSignal,
  ) => Promise<IncrementalObservationWork>
  readonly apply: (work: IncrementalObservationWork) => Promise<unknown>
  readonly failed: (error: unknown) => void
  readonly defer: (work: IncrementalObservationWork, error: unknown) => Promise<void>
  readonly wait?: (signal: AbortSignal, ms: number) => Promise<void>
  readonly executionMode?: 'native' | 'host'
}) {
  let controller: AbortController | null = null,
    running: Promise<void> | null = null
  let scheduling: AbortController | null = null
  let completion: Promise<void> | null = null
  const settlements = new Set<() => Promise<void>>()
  const idleWaiters = new Set<() => void>()
  const idle = () => {
    for (const done of idleWaiters) done()
    idleWaiters.clear()
  }
  const wait =
    input.wait ??
    ((signal, ms) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, ms)
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      }))
  async function run(
    signal: AbortSignal,
    wake: AbortSignal,
    execution?: ObservationExecutionLifetime,
  ) {
    const current = execution?.current.bind(execution)
    const dispatch = execution?.canDispatch?.bind(execution)
    const accepting = () =>
      !signal.aborted && !wake.aborted && (current?.() ?? true) && (dispatch?.() ?? true)
    while (accepting()) {
      try {
        const seeded = await input.bootstrap(signal)
        if (execution && !accepting()) break
        const dispatched = await input.dispatch()
        if (execution && !accepting()) break
        const pending = await input.store.pending(100)
        for (const work of pending) {
          signal.throwIfAborted()
          if (execution && !accepting()) break
          let claimed = work
          try {
            claimed = await input.prepare(work, signal)
            await input.apply(claimed)
          } catch (error) {
            if (signal.aborted) return
            if (execution) {
              const write = () => input.defer(claimed, error)
              settlements.add(write)
              await write()
              settlements.delete(write)
            } else await input.defer(claimed, error)
            input.failed(error)
          }
        }
        if (!seeded && !dispatched && !pending.length) {
          idle()
          await wait(wake, 250)
        }
      } catch (error) {
        if (signal.aborted) return
        input.failed(error)
        // Do not start a second work item while an original defer ACK is
        // unresolved. Loss drain retries just that same durable write.
        if (settlements.size) return
        // Durable pending rows remain intact after failure or daemon restart.
        if (accepting()) await wait(wake, 1000)
      }
    }
  }
  return {
    start(execution?: ObservationExecutionLifetime) {
      if (input.executionMode === 'host' && (!execution || !execution.current()))
        throw new Error('observation-projection-host-lifetime-required')
      if (settlements.size) throw new Error('observation-projection-unsettled-work')
      if (running) return
      controller = new AbortController()
      scheduling = new AbortController()
      const jobSignal = controller.signal,
        wakeSignal = scheduling.signal
      const work =
        execution?.whenActive === undefined
          ? run(jobSignal, wakeSignal, execution)
          : (async () => {
              if (await waitForExecutionActivation(execution.whenActive, wakeSignal))
                await run(jobSignal, wakeSignal, execution)
            })()
      running = work.finally(() => {
        idle()
        running = null
        controller = null
        scheduling = null
      })
      completion = running
      void running.catch(() => {})
    },
    async drain() {
      if (running) await new Promise<void>((resolve) => idleWaiters.add(resolve))
    },
    async stop() {
      scheduling?.abort()
      controller?.abort()
      await running
    },
    quiesce() {
      scheduling?.abort()
    },
    async drainAuthority() {
      if (scheduling && !scheduling.signal.aborted)
        throw new Error('observation-projection-drain-before-quiesce')
      await completion
      for (const write of settlements) {
        await write()
        settlements.delete(write)
      }
    },
  }
}
