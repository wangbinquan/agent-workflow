import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { WebhookEndpointServiceDeps } from '@/services/webhookEndpoints'
import type { WebhookEndpointAdministrationPort } from '../application/ports/webhookEndpointAdministration'
import { createPostgresqlWebhookEndpointAdministration } from '../infrastructure/postgresqlWebhookEndpointAdministration'
import { createSqliteWebhookEndpointAdministration } from '../infrastructure/sqliteWebhookEndpointAdministration'

export function composeWebhookEndpointAdministration(
  administration: WebhookEndpointAdministrationPort,
): WebhookEndpointAdministrationPort {
  return administration
}

export function composeSqliteWebhookEndpointServiceDependencies(input: {
  readonly db: DbClient
  readonly configPath: string
  readonly secretBox: SecretBox
}): WebhookEndpointServiceDeps {
  return {
    administration: createSqliteWebhookEndpointAdministration(input.db),
    configPath: input.configPath,
    secretBox: input.secretBox,
  }
}

export function composePostgresqlWebhookEndpointServiceDependencies(input: {
  readonly db: PostgresqlDatabaseClient
  readonly configPath: string
  readonly secretBox: SecretBox
}): WebhookEndpointServiceDeps {
  return {
    administration: createPostgresqlWebhookEndpointAdministration(input.db),
    configPath: input.configPath,
    secretBox: input.secretBox,
  }
}
