import { eq } from 'drizzle-orm'

import { webhookEndpoints, webhookTriggers } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { WebhookEndpointAdministrationPort } from '../application/ports/webhookEndpointAdministration'
import { isUniqueConstraintViolation } from './uniqueConstraintViolation'

export function createPostgresqlWebhookEndpointAdministration(
  db: PostgresqlDatabaseClient,
): WebhookEndpointAdministrationPort {
  return {
    async list() {
      return await db.select().from(webhookEndpoints)
    },
    async get(id) {
      return (
        (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get()) ?? null
      )
    },
    async getByUrlToken(urlToken) {
      return (
        (await db
          .select()
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.urlToken, urlToken))
          .get()) ?? null
      )
    },
    async tryCreate(record) {
      try {
        return (await db.insert(webhookEndpoints).values(record).returning().get()) ?? null
      } catch (error) {
        if (isUniqueConstraintViolation(error)) return null
        throw error
      }
    },
    async update(id, patch) {
      return (
        (await db
          .update(webhookEndpoints)
          .set(patch)
          .where(eq(webhookEndpoints.id, id))
          .returning()
          .get()) ?? null
      )
    },
    async hasTriggerReferences(id) {
      return (
        (await db
          .select({ id: webhookTriggers.id })
          .from(webhookTriggers)
          .where(eq(webhookTriggers.endpointId, id))
          .limit(1)
          .get()) !== undefined
      )
    },
    async delete(id) {
      return (
        (await db
          .delete(webhookEndpoints)
          .where(eq(webhookEndpoints.id, id))
          .returning({ id: webhookEndpoints.id })
          .get()) !== undefined
      )
    },
  }
}
