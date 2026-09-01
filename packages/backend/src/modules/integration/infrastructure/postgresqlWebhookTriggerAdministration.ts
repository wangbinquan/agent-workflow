import { and, desc, eq } from 'drizzle-orm'

import {
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggers,
  webhookTriggerStreams,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { WebhookTriggerAdministrationPort } from '../application/ports/webhookTriggerAdministration'

export function createPostgresqlWebhookTriggerAdministration(
  db: PostgresqlDatabaseClient,
): WebhookTriggerAdministrationPort {
  return {
    async list() {
      return await db.select().from(webhookTriggers).orderBy(desc(webhookTriggers.createdAt))
    },
    async get(id) {
      return (
        (await db.select().from(webhookTriggers).where(eq(webhookTriggers.id, id)).get()) ?? null
      )
    },
    async endpointExists(endpointId) {
      return (
        (await db
          .select({ id: webhookEndpoints.id })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, endpointId))
          .get()) !== undefined
      )
    },
    async create(record) {
      const row = await db.insert(webhookTriggers).values(record).returning().get()
      if (row === undefined) throw new Error('webhook trigger insert was not visible')
      return row
    },
    async update(input) {
      const expected = input.expectedLaunchConfiguration
      return (
        (await db
          .update(webhookTriggers)
          .set(input.patch)
          .where(
            expected === undefined
              ? eq(webhookTriggers.id, input.triggerId)
              : and(
                  eq(webhookTriggers.id, input.triggerId),
                  eq(webhookTriggers.templateSyntaxVersion, expected.templateSyntaxVersion),
                  eq(webhookTriggers.launchRefId, expected.launchRefId),
                  eq(webhookTriggers.launchPayload, expected.launchPayload),
                  eq(webhookTriggers.eventTypes, expected.eventTypes),
                  eq(webhookTriggers.autoRegisterRepos, expected.autoRegisterRepos),
                  eq(webhookTriggers.cancelOnMrTerminal, expected.cancelOnMrTerminal),
                ),
          )
          .returning()
          .get()) ?? null
      )
    },
    async delete(triggerId) {
      await db.delete(webhookTriggers).where(eq(webhookTriggers.id, triggerId))
    },
    async listFires(triggerId, limit) {
      return await db
        .select()
        .from(webhookTriggerFires)
        .where(eq(webhookTriggerFires.triggerId, triggerId))
        .orderBy(desc(webhookTriggerFires.firedAt))
        .limit(limit)
    },
    async resetStream(input) {
      await db
        .update(webhookTriggerStreams)
        .set({ consecutiveFires: 0, resetAt: input.resetAt, resetBy: input.resetBy })
        .where(
          and(
            eq(webhookTriggerStreams.triggerId, input.triggerId),
            eq(webhookTriggerStreams.streamKey, input.streamKey),
          ),
        )
    },
  }
}
