import type { SecretBox } from '@/auth/secretBox'
import type { EventCenterModule } from '@/modules/event-center/composition'
import type { MrTerminalControl } from '../public/mrTerminalControl'
import {
  supportsEventCenterCodeHostDelivery,
  type WebhookDispatcher,
} from '@/services/webhook/dispatcherTypes'
import { createVerifiedWebhookIngress } from '../application/verifiedWebhookIngress'
import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  AcceptedVerifiedDelivery,
  VerifiedWebhookDeliveryInput,
} from '../application/acceptVerifiedWebhookDelivery'
import type { WebhookDeliveryPersistencePort } from '../application/ports/webhookDeliveryPersistence'
import type { WebhookDeliveryQueries } from '../application/ports/webhookDeliveryQueries'
import type { WebhookEndpointAdministrationPort } from '../application/ports/webhookEndpointAdministration'
import { createVerifiedWebhookDeliveryPersistence } from '../infrastructure/verifiedWebhookDeliveryPersistence'
import { createWebhookDeliveryPersistence } from '../infrastructure/webhookDeliveryPersistence'
import { createWebhookDeliveryQueries } from '../infrastructure/webhookDeliveryQueries'
import { createWebhookEndpointAdministration } from '../infrastructure/webhookEndpointAdministration'

export interface WebhookIngressPersistence {
  readonly endpoints: Pick<WebhookEndpointAdministrationPort, 'get' | 'getByUrlToken'>
  readonly deliveries: WebhookDeliveryPersistencePort
  acceptVerifiedDelivery(input: VerifiedWebhookDeliveryInput): Promise<AcceptedVerifiedDelivery>
}

/** Provider-neutral audit/replay seam; transports never select or inspect a database provider. */
export interface WebhookDeliveryRuntime extends WebhookIngressPersistence {
  readonly queries: WebhookDeliveryQueries
}

export function composeWebhookIngressPersistence(
  persistence: WebhookIngressPersistence,
): WebhookIngressPersistence {
  return persistence
}

/** RFC-359 W4-D2：端点管理 / 投递持久化 / 已验证投递接收都是中立实现，两个 provider 装同一份。 */
export function composeWebhookIngressPersistenceFor(
  db: ProviderNeutralDatabase,
): WebhookIngressPersistence {
  const verified = createVerifiedWebhookDeliveryPersistence(db)
  return composeWebhookIngressPersistence({
    endpoints: createWebhookEndpointAdministration(db),
    deliveries: createWebhookDeliveryPersistence(db),
    acceptVerifiedDelivery: (input) => verified.accept(input),
  })
}

export function composeWebhookDeliveryRuntimeFor(
  db: ProviderNeutralDatabase,
): WebhookDeliveryRuntime {
  const ingress = composeWebhookIngressPersistenceFor(db)
  return Object.freeze({
    ...ingress,
    queries: createWebhookDeliveryQueries(db),
  })
}

/** Bootstrap binds the existing transport availability gate and downstream workers. */
export function composeWebhookIngressTransport(input: {
  readonly webhookIngressPersistence: WebhookIngressPersistence
  readonly secretBox?: SecretBox
  readonly digitalEmployeeEventCenter?: EventCenterModule
  readonly webhookDispatcher?: WebhookDispatcher
  readonly webhookTerminalControl?: MrTerminalControl
}) {
  const eventCenter = input.digitalEmployeeEventCenter
  const enabled =
    !!input.secretBox &&
    !!input.webhookDispatcher &&
    supportsEventCenterCodeHostDelivery(input.webhookDispatcher) &&
    eventCenter !== undefined
  return Object.freeze({
    webhookIngressPersistence: input.webhookIngressPersistence,
    secretBox: input.secretBox,
    verifiedIngress:
      !enabled || eventCenter === undefined
        ? undefined
        : createVerifiedWebhookIngress({
            persistence: {
              accept: (command) => input.webhookIngressPersistence.acceptVerifiedDelivery(command),
            },
            audit: input.webhookIngressPersistence.deliveries,
            events: {
              observe: async (observation) => await eventCenter.commands.observe(observation),
              notify: (deliveryId) => eventCenter.worker.runOneNotification(deliveryId),
              nudge: () =>
                eventCenter.observerControl.nudgeSource({ id: 'code-host.activity', revision: 1 }),
            },
            wakeTerminalControl: (effectId) => input.webhookTerminalControl?.wake(effectId),
            now: () => Date.now(),
          }),
  })
}
