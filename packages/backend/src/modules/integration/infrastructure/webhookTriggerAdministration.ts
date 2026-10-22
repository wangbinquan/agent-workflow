// RFC-359 W4-B4 —— webhook 触发器管理：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, desc, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WebhookTriggerAdministrationPort } from '../application/ports/webhookTriggerAdministration'

export function createWebhookTriggerAdministration(
  db: PersistenceDb,
): WebhookTriggerAdministrationPort {
  return {
    async list() {
      const { webhookTriggers } = tablesOf(db)
      return await db.select().from(webhookTriggers).orderBy(desc(webhookTriggers.createdAt))
    },
    async get(id) {
      const { webhookTriggers } = tablesOf(db)
      return (
        (await db.select().from(webhookTriggers).where(eq(webhookTriggers.id, id)).limit(1))[0] ??
        null
      )
    },
    async endpointExists(endpointId) {
      const { webhookEndpoints } = tablesOf(db)
      return (
        (
          await db
            .select({ id: webhookEndpoints.id })
            .from(webhookEndpoints)
            .where(eq(webhookEndpoints.id, endpointId))
            .limit(1)
        ).length > 0
      )
    },
    async create(record) {
      const { webhookTriggers } = tablesOf(db)
      const row = (await db.insert(webhookTriggers).values(record).returning())[0]
      if (row === undefined) throw new Error('webhook trigger insert was not visible')
      return row
    },
    async update(input) {
      const expected = input.expectedLaunchConfiguration
      const { webhookTriggers } = tablesOf(db)
      return (
        (
          await db
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
        )[0] ?? null
      )
    },
    async delete(triggerId) {
      const { webhookTriggers } = tablesOf(db)
      await db.delete(webhookTriggers).where(eq(webhookTriggers.id, triggerId))
    },
    async listFires(triggerId, limit) {
      const { webhookTriggerFires } = tablesOf(db)
      return await db
        .select()
        .from(webhookTriggerFires)
        .where(eq(webhookTriggerFires.triggerId, triggerId))
        .orderBy(desc(webhookTriggerFires.firedAt))
        .limit(limit)
    },
    async resetStream(input) {
      const { webhookTriggerStreams } = tablesOf(db)
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
