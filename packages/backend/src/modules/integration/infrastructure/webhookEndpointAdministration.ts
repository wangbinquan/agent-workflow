// RFC-359 W4-B4 —— webhook 端点管理：一份实现，两个 provider 共用。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { webhookEndpoints, webhookTriggers } from '@/db/schema'
import type { WebhookEndpointAdministrationPort } from '../application/ports/webhookEndpointAdministration'
import { isUniqueConstraintViolation } from './uniqueConstraintViolation'

export function createWebhookEndpointAdministration(
  db: ProviderNeutralDatabase,
): WebhookEndpointAdministrationPort {
  return {
    async list() {
      return await db.select().from(webhookEndpoints)
    },
    async get(id) {
      return (
        (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).limit(1))[0] ??
        null
      )
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
        return (await db.insert(webhookEndpoints).values(record).returning())[0] ?? null
      } catch (error) {
        if (isUniqueConstraintViolation(error)) return null
        throw error
      }
    },
    async update(id, patch) {
      return (
        (
          await db
            .update(webhookEndpoints)
            .set(patch)
            .where(eq(webhookEndpoints.id, id))
            .returning()
        )[0] ?? null
      )
    },
    async hasTriggerReferences(id) {
      return (
        (
          await db
            .select({ id: webhookTriggers.id })
            .from(webhookTriggers)
            .where(eq(webhookTriggers.endpointId, id))
            .limit(1)
        ).length > 0
      )
    },
    async delete(id) {
      return (
        (
          await db
            .delete(webhookEndpoints)
            .where(eq(webhookEndpoints.id, id))
            .returning({ id: webhookEndpoints.id })
        ).length > 0
      )
    },
  }
}
