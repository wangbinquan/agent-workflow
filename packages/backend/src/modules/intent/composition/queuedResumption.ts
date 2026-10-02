import {
  createQueuedIntentResumption,
  type QueuedIntentResumptionDependencies,
} from '../application/queuedResumption'
import {
  createQueuedIntentNotifications,
  type QueuedIntentNotifications,
} from '../application/queuedNotifications'

export function composeIntentQueuedNotifications(): QueuedIntentNotifications {
  return createQueuedIntentNotifications()
}

/** The daemon selects the reader; Intent owns the queued admission lifetime. */
export function composeIntentQueuedResumption(
  input: Omit<QueuedIntentResumptionDependencies, 'readConfiguration'> & {
    readonly configuration: { read: QueuedIntentResumptionDependencies['readConfiguration'] }
    readonly notifications?: QueuedIntentNotifications
  },
) {
  const resumption = createQueuedIntentResumption({
    readConfiguration: () => input.configuration.read(),
    resume: (sessionIds, config) => input.resume(sessionIds, config),
    onError: (error) => input.onError(error),
  })
  input.notifications?.connect(resumption.enqueue)
  return Object.freeze({
    enqueue: resumption.enqueue,
    runtimeFactory: Object.freeze({
      id: 'intent-queued-resumption',
      start: resumption.start,
    }),
  })
}
