import type { CrewStationEventIngress } from './crewstationEvents'
import type { SecretBox } from '@/auth/secretBox'
import type { EventCenterModule } from '@/modules/event-center/composition'
import type { MrTerminalControl } from '../public/participants'
import {
  supportsEventCenterCodeHostDelivery,
  type WebhookDispatcher,
} from '../application/ports/webhookDispatcher'
import { createCodeHostWebhookReceiver } from '../application/receiveCodeHostWebhook'
import {
  createWebhookDeliveryReplay,
  type WebhookDeliveryReplay,
} from '../application/replayWebhookDelivery'
import {
  createWebhookRateLimiters,
  type WebhookRateLimiters,
} from '../application/webhookRateLimiter'
import { createVerifiedWebhookIngress } from '../application/verifiedWebhookIngress'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WebhookDeliveryRuntime } from '../application/ports/webhookDeliveryRuntime'
import type { WebhookIngressPersistence } from '../application/ports/webhookIngressPersistence'
import { createVerifiedWebhookDeliveryPersistence } from '../infrastructure/verifiedWebhookDeliveryPersistence'
import { createWebhookDeliveryPersistence } from '../infrastructure/webhookDeliveryPersistence'
import { createWebhookDeliveryQueries } from '../infrastructure/webhookDeliveryQueries'
import { createWebhookEndpointAdministration } from '../infrastructure/webhookEndpointAdministration'

export type { WebhookDeliveryRuntime }

export function composeWebhookIngressPersistence(
  persistence: WebhookIngressPersistence,
): WebhookIngressPersistence {
  return persistence
}

/** RFC-359 W4-D2：端点管理 / 投递持久化 / 已验证投递接收都是中立实现，两个 provider 装同一份。 */
export function composeWebhookIngressPersistenceFor(db: PersistenceDb): WebhookIngressPersistence {
  const verified = createVerifiedWebhookDeliveryPersistence(db)
  return composeWebhookIngressPersistence({
    endpoints: createWebhookEndpointAdministration(db),
    deliveries: createWebhookDeliveryPersistence(db),
    acceptVerifiedDelivery: (input) => verified.accept(input),
  })
}

export function composeWebhookDeliveryRuntimeFor(db: PersistenceDb): WebhookDeliveryRuntime {
  const ingress = composeWebhookIngressPersistenceFor(db)
  return Object.freeze({
    ...ingress,
    queries: createWebhookDeliveryQueries(db),
  })
}

/**
 * Bootstrap binds the existing transport availability gate and downstream
 * workers. RFC-370 v3 V8: a hosted deployment (one that supplies the
 * CrewStation event ingress) receives code-host events only through
 * CrewStation, so it has no direct webhook ingress at all.
 */
export function composeWebhookIngressTransport(input: {
  readonly webhookIngressPersistence: WebhookIngressPersistence
  readonly crewStationEvents?: CrewStationEventIngress
  readonly secretBox?: SecretBox
  readonly digitalEmployeeEventCenter?: EventCenterModule
  readonly webhookDispatcher?: WebhookDispatcher
  readonly webhookTerminalControl?: MrTerminalControl
  /** RFC-437：入站接收的限流器；缺省按两档默认速率新建（用例注入假时钟时传入）。 */
  readonly limiters?: WebhookRateLimiters
}) {
  const eventCenter = input.digitalEmployeeEventCenter
  const enabled =
    input.crewStationEvents === undefined &&
    !!input.secretBox &&
    !!input.webhookDispatcher &&
    supportsEventCenterCodeHostDelivery(input.webhookDispatcher) &&
    eventCenter !== undefined
  const verifiedIngress =
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
        })
  const secretBox = input.secretBox
  return Object.freeze({
    webhookIngressPersistence: input.webhookIngressPersistence,
    crewStationEvents: input.crewStationEvents,
    secretBox,
    verifiedIngress,
    // RFC-437：入站接收用例。装配缺件（无密钥箱或无已验证接收）时不构造，绑定随之不挂载入站面——
    // 对齐 OIDC 的自我跳过惯例：管理面会以显式错误提示，而不是留一个必 500 的公开路由。
    receiver:
      secretBox === undefined || verifiedIngress === undefined
        ? undefined
        : createCodeHostWebhookReceiver({
            persistence: input.webhookIngressPersistence,
            unseal: (secretEnc) => secretBox.unseal(secretEnc),
            verifiedIngress,
            limiters: input.limiters ?? createWebhookRateLimiters(),
          }),
  })
}

/**
 * RFC-437：投递重放的可用性与原路由同一条件——事件中心与分发器都已接线，且分发器支持事件中心投递；
 * 不看密钥箱与托管事件入口。不可用时返回 undefined，绑定报 409 `webhook-ingress-unavailable`。
 */
export function composeWebhookDeliveryReplay(input: {
  readonly webhookDeliveryRuntime: WebhookDeliveryRuntime
  readonly digitalEmployeeEventCenter?: EventCenterModule
  readonly webhookDispatcher?: WebhookDispatcher
  readonly webhookTerminalControl?: MrTerminalControl
}): WebhookDeliveryReplay | undefined {
  const eventCenter = input.digitalEmployeeEventCenter
  if (
    eventCenter === undefined ||
    input.webhookDispatcher === undefined ||
    !supportsEventCenterCodeHostDelivery(input.webhookDispatcher)
  ) {
    return undefined
  }
  return createWebhookDeliveryReplay({
    runtime: input.webhookDeliveryRuntime,
    events: {
      observe: async (observation) => await eventCenter.commands.observe(observation),
      notify: (deliveryId) => eventCenter.worker.runOneNotification(deliveryId),
    },
    wakeTerminalControl: (effectId) => input.webhookTerminalControl?.wake(effectId),
    now: () => Date.now(),
  })
}
