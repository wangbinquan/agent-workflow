// RFC-359 W4-B4 —— webhook 派发持久化：一份实现，两个 provider 共用。

import { createTaskTriggerQueries } from '@/modules/task-execution/public/queries'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, desc, eq, sql } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WebhookDispatchPersistencePort } from '../application/ports/webhookDispatchPersistence'

export function createWebhookDispatchPersistence(
  db: PersistenceDb,
): WebhookDispatchPersistencePort {
  return {
    async triggerEnabled(triggerId) {
      const { webhookTriggers } = tablesOf(db)
      return (
        (
          await db
            .select({ enabled: webhookTriggers.enabled })
            .from(webhookTriggers)
            .where(eq(webhookTriggers.id, triggerId))
            .limit(1)
        )[0]?.enabled ?? null
      )
    },

    async migrateTriggerTemplate(input) {
      const { webhookTriggers } = tablesOf(db)
      const changed = (
        await db
          .update(webhookTriggers)
          .set({
            launchPayload: input.launchPayload,
            templateSyntaxVersion: 2,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(webhookTriggers.id, input.triggerId),
              eq(webhookTriggers.templateSyntaxVersion, 1),
              eq(webhookTriggers.launchPayload, input.expectedLaunchPayload),
            ),
          )
          .returning()
      )[0]
      if (changed !== undefined) return changed
      return (
        (
          await db
            .select()
            .from(webhookTriggers)
            .where(eq(webhookTriggers.id, input.triggerId))
            .limit(1)
        )[0] ?? null
      )
    },

    async recordFire(input) {
      const { webhookTriggerFires } = tablesOf(db)
      await insertOne(db, webhookTriggerFires, {
        id: input.fireId,
        deliveryId: input.deliveryId,
        triggerId: input.triggerId,
        streamKey: input.streamKey,
        outcome: input.outcome,
        supersededTaskId: input.supersededTaskId ?? null,
        taskId: input.taskId ?? null,
        employeeCaseId: input.employeeCaseId ?? null,
        error: input.error ?? null,
      })
    },

    async fireExists(deliveryId, triggerId) {
      const { webhookTriggerFires } = tablesOf(db)
      return (
        (
          await db
            .select({ id: webhookTriggerFires.id })
            .from(webhookTriggerFires)
            .where(
              and(
                eq(webhookTriggerFires.deliveryId, deliveryId),
                eq(webhookTriggerFires.triggerId, triggerId),
              ),
            )
            .limit(1)
        ).length > 0
      )
    },

    async findTaskByOrigin(input) {
      return createTaskTriggerQueries(db).findByOrigin(input)
    },

    async getTrigger(triggerId) {
      const { webhookTriggers } = tablesOf(db)
      return (
        (
          await db.select().from(webhookTriggers).where(eq(webhookTriggers.id, triggerId)).limit(1)
        )[0] ?? null
      )
    },

    async getTriggerStream(triggerId, streamKey) {
      const { webhookTriggerStreams } = tablesOf(db)
      return (
        (
          await db
            .select({
              consecutiveFires: webhookTriggerStreams.consecutiveFires,
              lastFireAt: webhookTriggerStreams.lastFireAt,
            })
            .from(webhookTriggerStreams)
            .where(
              and(
                eq(webhookTriggerStreams.triggerId, triggerId),
                eq(webhookTriggerStreams.streamKey, streamKey),
              ),
            )
            .limit(1)
        )[0] ?? null
      )
    },

    async putTriggerStream(input) {
      const { webhookTriggerStreams } = tablesOf(db)
      await db
        .insert(webhookTriggerStreams)
        .values({
          triggerId: input.triggerId,
          streamKey: input.streamKey,
          consecutiveFires: input.consecutiveFires,
          lastFireAt: input.lastFireAt ?? null,
        })
        .onConflictDoUpdate({
          target: [webhookTriggerStreams.triggerId, webhookTriggerStreams.streamKey],
          set: {
            consecutiveFires: input.consecutiveFires,
            ...(input.lastFireAt === undefined ? {} : { lastFireAt: input.lastFireAt }),
          },
        })
    },

    async getDeliveryMrFact(deliveryId) {
      const { webhookDeliveries } = tablesOf(db)
      return (
        (
          await db
            .select({
              streamKey: webhookDeliveries.mrStreamKey,
              revision: webhookDeliveries.mrStreamRevision,
              stateAfter: webhookDeliveries.mrStateAfter,
            })
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.id, deliveryId))
            .limit(1)
        )[0] ?? null
      )
    },

    async findLatestLaunchedTask(triggerId, streamKey) {
      const { webhookTriggerFires } = tablesOf(db)
      const latest = (
        await db
          .select({ taskId: webhookTriggerFires.taskId })
          .from(webhookTriggerFires)
          .where(
            and(
              eq(webhookTriggerFires.triggerId, triggerId),
              eq(webhookTriggerFires.streamKey, streamKey),
              eq(webhookTriggerFires.outcome, 'launched'),
            ),
          )
          .orderBy(desc(webhookTriggerFires.firedAt))
          .limit(1)
      )[0]
      if (latest?.taskId == null) return null
      return createTaskTriggerQueries(db).status(latest.taskId)
    },

    async markTriggerLaunchFailed(triggerId, error, now) {
      const { webhookTriggers } = tablesOf(db)
      await db
        .update(webhookTriggers)
        .set({
          lastStatus: 'failed',
          lastError: error,
          consecutiveFailures: sql`${webhookTriggers.consecutiveFailures} + 1`,
          updatedAt: now,
        })
        .where(eq(webhookTriggers.id, triggerId))
    },

    async markTriggerLaunched(input) {
      const { webhookTriggers } = tablesOf(db)
      await db
        .update(webhookTriggers)
        .set({
          lastFiredAt: input.now,
          lastStatus: 'launched',
          lastError: null,
          lastTaskId: input.taskId,
          consecutiveFailures: 0,
          updatedAt: input.now,
        })
        .where(eq(webhookTriggers.id, input.triggerId))
    },

    async listEnabledTriggers(endpointId) {
      const { webhookTriggers } = tablesOf(db)
      return await db
        .select()
        .from(webhookTriggers)
        .where(and(eq(webhookTriggers.endpointId, endpointId), eq(webhookTriggers.enabled, true)))
    },

    async deliveryControlEffectId(deliveryId) {
      const { webhookDeliveries, webhookMrControlEffects } = tablesOf(db)
      const delivery = (
        await db
          .select({ replayedFromDeliveryId: webhookDeliveries.replayedFromDeliveryId })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, deliveryId))
          .limit(1)
      )[0]
      const rootDeliveryId = delivery?.replayedFromDeliveryId ?? deliveryId
      return (
        (
          await db
            .select({ id: webhookMrControlEffects.id })
            .from(webhookMrControlEffects)
            .where(eq(webhookMrControlEffects.deliveryId, rootDeliveryId))
            .limit(1)
        )[0]?.id ?? null
      )
    },

    async subscriptionEnvelope(deliveryId) {
      const { webhookDeliveries, webhookEndpoints } = tablesOf(db)
      const delivery = (
        await db
          .select({
            endpointId: webhookDeliveries.endpointId,
            bodyJson: webhookDeliveries.bodyJson,
            gitlabEventHeader: webhookDeliveries.gitlabEventHeader,
            replayedFromDeliveryId: webhookDeliveries.replayedFromDeliveryId,
          })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, deliveryId))
          .limit(1)
      )[0]
      if (delivery === undefined) return null
      const endpoint = (
        await db
          .select()
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, delivery.endpointId))
          .limit(1)
      )[0]
      if (endpoint === undefined) return null
      return { endpoint, delivery }
    },
  }
}
