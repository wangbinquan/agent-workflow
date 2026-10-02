import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import {
  createQueuedIntentResumption,
  type QueuedIntentResumptionDependencies,
} from '../application/queuedResumption'

/** The daemon selects the reader; Intent owns the queued admission lifetime. */
export function composeIntentQueuedResumption(
  input: Omit<QueuedIntentResumptionDependencies, 'readConfiguration'> & {
    readonly configuration: ApplicationConfigurationQueries
  },
) {
  const resumption = createQueuedIntentResumption({
    readConfiguration: () => input.configuration.read(),
    resume: (sessionIds, config) => input.resume(sessionIds, config),
    onError: (error) => input.onError(error),
  })
  return Object.freeze({
    enqueue: resumption.enqueue,
    runtimeFactory: Object.freeze({
      id: 'intent-queued-resumption',
      start: resumption.start,
    }),
  })
}
