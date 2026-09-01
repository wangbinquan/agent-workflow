import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { webhookEndpoints, webhookTriggers } from '@/db/schema'
import type { WebhookEndpointAdministrationPort } from '../application/ports/webhookEndpointAdministration'
import { isUniqueConstraintViolation } from './uniqueConstraintViolation'

export function createSqliteWebhookEndpointAdministration(
  db: DbClient,
): WebhookEndpointAdministrationPort {
  return {
    async list() {
      return db.select().from(webhookEndpoints).all()
    },
    async get(id) {
      return db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get() ?? null
    },
    async getByUrlToken(urlToken) {
      return (
        (
          await db
            .select()
            .from(webhookEndpoints)
            .where(eq(webhookEndpoints.urlToken, urlToken))
            .limit(1)
        )[0] ?? null
      )
    },
    async tryCreate(record) {
      try {
        return db.insert(webhookEndpoints).values(record).returning().get() ?? null
      } catch (error) {
        if (isUniqueConstraintViolation(error)) return null
        throw error
      }
    },
    async update(id, patch) {
      return (
        db
          .update(webhookEndpoints)
          .set(patch)
          .where(eq(webhookEndpoints.id, id))
          .returning()
          .get() ?? null
      )
    },
    async hasTriggerReferences(id) {
      return (
        db
          .select({ id: webhookTriggers.id })
          .from(webhookTriggers)
          .where(eq(webhookTriggers.endpointId, id))
          .limit(1)
          .get() !== undefined
      )
    },
    async delete(id) {
      return (
        db
          .delete(webhookEndpoints)
          .where(eq(webhookEndpoints.id, id))
          .returning({ id: webhookEndpoints.id })
          .get() !== undefined
      )
    },
  }
}
