import { and, desc, eq, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  tasks,
  webhookDeliveries,
  webhookEndpoints,
  webhookMrControlEffects,
  webhookTriggerFires,
  webhookTriggers,
  webhookTriggerStreams,
} from '@/db/schema'
import type { WebhookDispatchPersistencePort } from '../application/ports/webhookDispatchPersistence'

export function createSqliteWebhookDispatchPersistence(
  db: DbClient,
): WebhookDispatchPersistencePort {
  return {
    async triggerEnabled(triggerId) {
      return (
        db
          .select({ enabled: webhookTriggers.enabled })
          .from(webhookTriggers)
          .where(eq(webhookTriggers.id, triggerId))
          .get()?.enabled ?? null
      )
    },

    async migrateTriggerTemplate(input) {
      const changed = db
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
        .get()
      if (changed !== undefined) return changed
      return (
        db.select().from(webhookTriggers).where(eq(webhookTriggers.id, input.triggerId)).get() ??
        null
      )
    },

    async recordFire(input) {
      db.insert(webhookTriggerFires)
        .values({
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
        .run()
    },

    async fireExists(deliveryId, triggerId) {
      return (
        db
          .select({ id: webhookTriggerFires.id })
          .from(webhookTriggerFires)
          .where(
            and(
              eq(webhookTriggerFires.deliveryId, deliveryId),
              eq(webhookTriggerFires.triggerId, triggerId),
            ),
          )
          .get() !== undefined
      )
    },

    async findTaskByOrigin(input) {
      const row = db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          input.eventDeliveryId === undefined
            ? eq(tasks.webhookFireId, input.fireId)
            : eq(tasks.eventDeliveryId, input.eventDeliveryId),
        )
        .get()
      return row?.id ?? null
    },

    async getTrigger(triggerId) {
      return (
        db.select().from(webhookTriggers).where(eq(webhookTriggers.id, triggerId)).get() ?? null
      )
    },

    async getTriggerStream(triggerId, streamKey) {
      return (
        db
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
          .get() ?? null
      )
    },

    async putTriggerStream(input) {
      db.insert(webhookTriggerStreams)
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
        .run()
    },

    async getDeliveryMrFact(deliveryId) {
      return (
        db
          .select({
            streamKey: webhookDeliveries.mrStreamKey,
            revision: webhookDeliveries.mrStreamRevision,
            stateAfter: webhookDeliveries.mrStateAfter,
          })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, deliveryId))
          .get() ?? null
      )
    },

    async findLatestLaunchedTask(triggerId, streamKey) {
      const latest = db
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
        .get()
      if (latest?.taskId == null) return null
      return (
        db
          .select({ id: tasks.id, status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, latest.taskId))
          .get() ?? null
      )
    },

    async markTriggerLaunchFailed(triggerId, error, now) {
      db.update(webhookTriggers)
        .set({
          lastStatus: 'failed',
          lastError: error,
          consecutiveFailures: sql`${webhookTriggers.consecutiveFailures} + 1`,
          updatedAt: now,
        })
        .where(eq(webhookTriggers.id, triggerId))
        .run()
    },

    async markTriggerLaunched(input) {
      db.update(webhookTriggers)
        .set({
          lastFiredAt: input.now,
          lastStatus: 'launched',
          lastError: null,
          lastTaskId: input.taskId,
          consecutiveFailures: 0,
          updatedAt: input.now,
        })
        .where(eq(webhookTriggers.id, input.triggerId))
        .run()
    },

    async listEnabledTriggers(endpointId) {
      return db
        .select()
        .from(webhookTriggers)
        .where(and(eq(webhookTriggers.endpointId, endpointId), eq(webhookTriggers.enabled, true)))
        .all()
    },

    async deliveryControlEffectId(deliveryId) {
      const delivery = db
        .select({ replayedFromDeliveryId: webhookDeliveries.replayedFromDeliveryId })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId))
        .get()
      const rootDeliveryId = delivery?.replayedFromDeliveryId ?? deliveryId
      return (
        db
          .select({ id: webhookMrControlEffects.id })
          .from(webhookMrControlEffects)
          .where(eq(webhookMrControlEffects.deliveryId, rootDeliveryId))
          .get()?.id ?? null
      )
    },

    async subscriptionEnvelope(deliveryId) {
      const delivery = db
        .select({
          endpointId: webhookDeliveries.endpointId,
          bodyJson: webhookDeliveries.bodyJson,
          gitlabEventHeader: webhookDeliveries.gitlabEventHeader,
          replayedFromDeliveryId: webhookDeliveries.replayedFromDeliveryId,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId))
        .get()
      if (delivery === undefined) return null
      const endpoint = db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, delivery.endpointId))
        .get()
      if (endpoint === undefined) return null
      return { endpoint, delivery }
    },
  }
}
