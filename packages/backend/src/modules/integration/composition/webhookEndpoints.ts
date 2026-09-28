import type { SecretBox } from '@/auth/secretBox'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { WebhookEndpointServiceDeps } from '@/services/webhookEndpoints'
import type { WebhookEndpointAdministrationPort } from '../application/ports/webhookEndpointAdministration'
import type { WebhookConfigurationQuery } from '../application/ports/webhookConfiguration'
import { createWebhookEndpointAdministration } from '../infrastructure/webhookEndpointAdministration'

export function composeWebhookEndpointAdministration(
  administration: WebhookEndpointAdministrationPort,
): WebhookEndpointAdministrationPort {
  return administration
}

/**
 * RFC-359：此前是两个**函数体逐字相同**的孪生，唯一差别是形参上 `db` 的声明类型——
 * 而 `createWebhookEndpointAdministration` 本来就收中立客户端。收成一份（plan §5ds）。
 */
export function composeWebhookEndpointServiceDependencies(input: {
  readonly db: ProviderNeutralDatabase
  readonly configuration: WebhookConfigurationQuery
  readonly secretBox: SecretBox
}): WebhookEndpointServiceDeps {
  return {
    administration: createWebhookEndpointAdministration(input.db),
    configuration: input.configuration,
    secretBox: input.secretBox,
  }
}
