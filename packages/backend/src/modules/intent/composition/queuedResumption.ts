import {
  createQueuedIntentResumption,
  type QueuedIntentResumptionDependencies,
} from '../application/queuedResumption'
import {
  createQueuedIntentNotifications,
  type QueuedIntentNotifications,
} from '../application/queuedNotifications'
import type { IntentTurnExecutionLifecycle } from '../application/ports/intentExecution'

export function composeIntentQueuedNotifications(): QueuedIntentNotifications {
  return createQueuedIntentNotifications()
}

/** The daemon selects the reader; Intent owns the queued admission lifetime. */
export function composeIntentQueuedResumption(
  input: Omit<QueuedIntentResumptionDependencies, 'readConfiguration'> & {
    readonly configuration: { read: QueuedIntentResumptionDependencies['readConfiguration'] }
    readonly notifications?: QueuedIntentNotifications
    readonly execution?: IntentTurnExecutionLifecycle
  },
) {
  const resumption = createQueuedIntentResumption({
    readConfiguration: () => input.configuration.read(),
    resume: (sessionIds, config) => input.resume(sessionIds, config),
    onError: (error) => input.onError(error),
  })
  input.notifications?.connect(resumption.enqueue)
  const combine = (
    queue: ReturnType<typeof resumption.start>,
    turns?: ReturnType<IntentTurnExecutionLifecycle['start']>,
  ) =>
    Object.freeze({
      stop() {
        queue.stop()
        turns?.stop()
      },
      async drain() {
        await queue.drain()
        await turns?.drain()
      },
    })
  return Object.freeze({
    enqueue: resumption.enqueue,
    runtimeFactory: Object.freeze({
      id: 'intent-queued-resumption',
      start: () => combine(resumption.start(), input.execution?.start({ current: () => true })),
      startAuthority: (
        authority: Parameters<typeof resumption.startAuthority>[0] & {
          readonly reportFailure?: (error: unknown) => void
        },
      ) => combine(resumption.startAuthority(authority), input.execution?.start(authority)),
    }),
  })
}
