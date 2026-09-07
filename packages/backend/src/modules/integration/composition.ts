import type { DbClient } from '@/db/client'
import type { EventCenterCodeHostDeliveryDispatcher } from '@/services/webhook/dispatcherTypes'
import {
  createCodeHostEventDeliveryAdapter,
  createCodeHostEventRoutingAdapter,
} from './application/adapters/event-center-adapter'
import { createCodeHostEventResponseDirectory } from './infrastructure/codeHostEventResponseDirectory'
import type { CodeHostEventContinuationPort } from './application/ports/codeHostEventResponse'
import type { CodeHostEventResponseDirectoryPort } from './application/ports/codeHostEventResponse'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export {
  createRepositoryEndpointDiscovery,
  type RepositoryEndpointConnection,
  type RepositoryEndpointFetch,
} from './application/repositoryEndpointDiscovery'

export function createCodeHostWebhookRoutingDirectory(
  db: DbClient,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostEventRoutingAdapter(createCodeHostEventResponseDirectory(db), continuation)
}

export function createCodeHostWebhookRoutingDirectoryWithPersistence(
  directory: CodeHostEventResponseDirectoryPort,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostEventRoutingAdapter(directory, continuation)
}

export function createPostgresqlCodeHostWebhookRoutingDirectory(
  db: PostgresqlDatabaseClient,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostWebhookRoutingDirectoryWithPersistence(
    createCodeHostEventResponseDirectory(db),
    continuation,
  )
}

export function createCodeHostWebhookDeliveryConsumer(
  db: DbClient,
  dispatcher: EventCenterCodeHostDeliveryDispatcher,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostEventDeliveryAdapter(
    createCodeHostEventResponseDirectory(db),
    {
      dispatch: (input) => dispatcher.dispatchSubscription(input),
    },
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

export function createPostgresqlCodeHostWebhookDeliveryConsumer(
  db: PostgresqlDatabaseClient,
  dispatcher: EventCenterCodeHostDeliveryDispatcher,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostWebhookDeliveryConsumerWithPersistence(
    createCodeHostEventResponseDirectory(db),
    dispatcher,
    continuation,
  )
}
