import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { EventCenterCodeHostDeliveryDispatcher } from './application/ports/webhookDispatcher'
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
// RFC-450：代码平台连接服务、两个路由合同与两组请求实现。
export {
  codeHostNodeRequests,
  codeHostRequests,
  composeCodeHostConnectionAdministration,
  composeCodeHostConnectionProbe,
  composeCodeHostConnections,
} from './composition/codeHostConnections'

/** RFC-359 AC-1（plan §5gc）—— 同上，两个 provider 唯一的一份，走 `…WithPersistence` 那层。 */
export function createCodeHostWebhookRoutingDirectory(
  db: PersistenceDb,
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
  db: PersistenceDb,
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

export { schemaContribution } from './composition/schema'

export { createWebhookFireRetentionPhase } from './infrastructure/retentionPhase'

// RFC-399 B1: bootstrap's maintenance job table takes these handlers via composition.
export { createIntegrationMaintenanceJobHandlers } from './application/maintenanceJobs'

// RFC-437: the code-host webhook HTTP bindings live in this module's inbound/http; server.ts mounts them here.
export { mountWebhookIngressRoutes } from './inbound/http/webhookIngressRoutes'
export { mountWebhookDeliveryRoutes } from './inbound/http/webhookDeliveryRoutes'
export { mountWebhookEndpointRoutes } from './inbound/http/webhookEndpointRoutes'
export { mountWebhookTriggerRoutes } from './inbound/http/webhookTriggerRoutes'
// RFC-438: the scheduled-task binding moved here too.
export { mountScheduledTaskRoutes } from './inbound/http/scheduledTaskRoutes'
