import type {
  IncrementalObservationProjectionStore,
  IncrementalObservationWork,
} from '../ports/incrementalObservationProjection'

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
}) {
  let controller: AbortController | null = null,
    running: Promise<void> | null = null
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
  async function run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const seeded = await input.bootstrap(signal)
        const dispatched = await input.dispatch(),
          pending = await input.store.pending(100)
        for (const work of pending) {
          signal.throwIfAborted()
          let claimed = work
          try {
            claimed = await input.prepare(work, signal)
            await input.apply(claimed)
          } catch (error) {
            if (signal.aborted) return
            await input.defer(claimed, error)
            input.failed(error)
          }
        }
        if (!seeded && !dispatched && !pending.length) await wait(signal, 250)
      } catch (error) {
        if (signal.aborted) return
        input.failed(error)
        // Durable pending rows remain intact after failure or daemon restart.
        await wait(signal, 1000)
      }
    }
  }
  return {
    start() {
      if (running) return
      controller = new AbortController()
      running = run(controller.signal).finally(() => {
        running = null
        controller = null
      })
    },
    async stop() {
      controller?.abort()
      await running
    },
  }
}
