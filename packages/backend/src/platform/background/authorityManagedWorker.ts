import type {
  AuthorityManagedWorkerDefinition,
  BackgroundExecutionLifetime,
  BackgroundLifecycleContext,
} from './definitions'
import { waitForExecutionActivation } from './activation'

/** Only explicitly aware definitions can use this lifecycle. The scheduling
 * signal wakes the owner loop; admitted business calls receive no loss abort. */
export async function startAuthorityManagedWorker(input: {
  readonly definition: Readonly<AuthorityManagedWorkerDefinition>
  readonly daemonGeneration: string
  readonly lifetime: BackgroundExecutionLifetime
}) {
  const { definition, lifetime, daemonGeneration } = input
  if (definition.supportsExecutionLifetime !== true) {
    throw new Error('background-worker-execution-lifetime-not-supported')
  }
  const capturedCurrent = lifetime.current.bind(lifetime)
  const dispatch = lifetime.canDispatch?.bind(lifetime)
  const reportFailure = lifetime.reportFailure?.bind(lifetime)
  if (!capturedCurrent()) throw new Error('background-worker-execution-unavailable')
  const start = definition.start.bind(definition)
  const run = definition.run.bind(definition)
  const stopDefinition = definition.stop.bind(definition)
  const controller = new AbortController()
  let quiesced = false
  let stopping: Promise<void> | undefined
  const current = () => capturedCurrent() && !quiesced && (dispatch?.() ?? true)
  const context: BackgroundLifecycleContext = Object.freeze({
    signal: controller.signal,
    daemonGeneration,
    execution: Object.freeze({ current }),
  })
  const quiesce = (reason: string): Promise<void> => {
    quiesced = true
    controller.abort(reason)
    if (stopping !== undefined) return stopping
    const attempt = Promise.resolve().then(() => stopDefinition(reason))
    stopping = attempt
    void attempt.catch(() => {
      if (stopping === attempt) stopping = undefined
    })
    return attempt
  }
  try {
    await start(context)
  } catch (error) {
    try {
      await quiesce('start-failed')
    } catch (stopError) {
      throw new AggregateError([error, stopError], 'background worker start cleanup failed')
    }
    throw error
  }
  const done = Promise.resolve().then(async () => {
    if ((await waitForExecutionActivation(lifetime.whenActive, controller.signal)) && current())
      await run(context)
  })
  void done.catch((error) => reportFailure?.(error)).catch(() => {})
  return Object.freeze({
    async stop() {
      await quiesce('provider-session-paused')
      await done
    },
    quiesceAuthorityLoss: () => quiesce('authority-loss'),
    async drain() {
      if (!quiesced || stopping === undefined)
        throw new Error('background-worker-drain-before-quiesce')
      await stopping
      await done
    },
  })
}
