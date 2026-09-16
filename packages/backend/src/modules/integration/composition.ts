import type { ProviderNeutralDatabase } from '@/db/query'
import type { EventCenterCodeHostDeliveryDispatcher } from '@/services/webhook/dispatcherTypes'
import {
  createCodeHostEventDeliveryAdapter,
  createCodeHostEventRoutingAdapter,
} from './application/adapters/event-center-adapter'
import { createCodeHostEventResponseDirectory } from './infrastructure/codeHostEventResponseDirectory'
import type { CodeHostEventContinuationPort } from './application/ports/codeHostEventResponse'
import type { CodeHostEventResponseDirectoryPort } from './application/ports/codeHostEventResponse'

export {
  createRepositoryEndpointDiscovery,
  type RepositoryEndpointConnection,
  type RepositoryEndpointFetch,
} from './application/repositoryEndpointDiscovery'

/** RFC-359 AC-1（plan §5gc）—— 同上，两个 provider 唯一的一份，走 `…WithPersistence` 那层。 */
export function createCodeHostWebhookRoutingDirectory(
  db: ProviderNeutralDatabase,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostWebhookRoutingDirectoryWithPersistence(
    createCodeHostEventResponseDirectory(db),
    continuation,
  )
}

export function createCodeHostWebhookRoutingDirectoryWithPersistence(
  directory: CodeHostEventResponseDirectoryPort,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostEventRoutingAdapter(directory, continuation)
}

/**
 * RFC-359 AC-1（plan §5gc）—— 两个 provider 唯一的一份。
 * 旁边那个 `createPostgresqlCodeHostWebhookDeliveryConsumer` 与这里**算的是同一件事**，
 * 只是它走 `…WithPersistence` 那层、而这里把同样三行**又抄了一遍**。
 * 现在这一份也改走那层：一处实现、一个名字。
 */
export function createCodeHostWebhookDeliveryConsumer(
  db: ProviderNeutralDatabase,
  dispatcher: EventCenterCodeHostDeliveryDispatcher,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostWebhookDeliveryConsumerWithPersistence(
    createCodeHostEventResponseDirectory(db),
    dispatcher,
    continuation,
  )
}

export function createCodeHostWebhookDeliveryConsumerWithPersistence(
  directory: CodeHostEventResponseDirectoryPort,
  dispatcher: EventCenterCodeHostDeliveryDispatcher,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostEventDeliveryAdapter(
    directory,
    { dispatch: (input) => dispatcher.dispatchSubscription(input) },
    continuation,
  )
}
