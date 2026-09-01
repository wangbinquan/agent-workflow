import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { webhookDeliveries, webhookEndpoints, webhookMrControlEffects } from '@/db/schema'
import type {
  WebhookDeliveryGcCursorV1,
  WebhookDeliveryPersistencePort,
} from '../application/ports/webhookDeliveryPersistence'
import { truncateDeliveryBody } from '../domain/webhookDelivery'
import { isUniqueConstraintViolation } from './uniqueConstraintViolation'

function gcCursor(
  value: WebhookDeliveryGcCursorV1 | null,
  now: number,
  retention: { readonly bodyRetentionMs: number; readonly rowRetentionMs: number },
): WebhookDeliveryGcCursorV1 {
  if (value === null) {
    return {
      version: 1,
      phase: 'bodies',
      bodyCutoff: now - retention.bodyRetentionMs,
      rowCutoff: now - retention.rowRetentionMs,
    }
  }
  if (
    value.version !== 1 ||
    (value.phase !== 'bodies' && value.phase !== 'rows') ||
    !Number.isSafeInteger(value.bodyCutoff) ||
    !Number.isSafeInteger(value.rowCutoff)
  ) {
    throw new Error('maintenance-webhook-delivery-cursor-invalid')
  }
  return value
}

/** SQLite mechanism for the provider-neutral delivery persistence contract. */
export function createSqliteWebhookDeliveryPersistence(
  db: DbClient,
): WebhookDeliveryPersistencePort {
  return {
    async insert(input) {
      const id = ulid()
      try {
        await db.insert(webhookDeliveries).values({
          id,
          endpointId: input.endpointId,
          eventUuid: input.eventUuid,
          gitlabEventHeader: input.gitlabEventHeader ?? null,
          objectKind: input.objectKind ?? null,
          eventType: input.eventType ?? null,
          repoPath: input.repoPath ?? null,
          streamHint: input.streamHint ?? null,
          status: input.status,
          statusReason: input.statusReason ?? null,
          bodyJson:
            input.bodyJson === undefined || input.bodyJson === null
              ? null
              : truncateDeliveryBody(input.bodyJson),
          replayedFromDeliveryId: input.replayedFromDeliveryId ?? null,
        })
        return { kind: 'inserted', deliveryId: id }
      } catch (error) {
        if (!isUniqueConstraintViolation(error) || input.eventUuid === null) throw error
        const existing = (
          await db
            .select({
              id: webhookDeliveries.id,
              attemptCount: webhookDeliveries.attemptCount,
            })
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.endpointId, input.endpointId),
                eq(webhookDeliveries.eventUuid, input.eventUuid),
                notInArray(webhookDeliveries.status, ['rejected', 'failed']),
              ),
            )
            .limit(1)
        )[0]
        if (existing === undefined) throw error
        const attemptCount = existing.attemptCount + 1
        await db
          .update(webhookDeliveries)
          .set({ attemptCount })
          .where(eq(webhookDeliveries.id, existing.id))
        return { kind: 'duplicate', deliveryId: existing.id, attemptCount }
      }
    },

    async mark(input) {
      await db
        .update(webhookDeliveries)
        .set({ status: input.status, statusReason: input.reason ?? null })
        .where(eq(webhookDeliveries.id, input.deliveryId))
    },

    async recoverInterrupted() {
      const controlledIds = db
        .select({ id: webhookMrControlEffects.deliveryId })
        .from(webhookMrControlEffects)
        .all()
        .map((row) => row.id)
      if (controlledIds.length > 0) {
        db.update(webhookDeliveries)
          .set({ status: 'matched', statusReason: 'terminal-control-accepted' })
          .where(
            and(
              inArray(webhookDeliveries.id, controlledIds),
              inArray(webhookDeliveries.status, ['received', 'processing']),
            ),
          )
          .run()
      }
      const rows = await db
        .update(webhookDeliveries)
        .set({ status: 'failed', statusReason: 'interrupted' })
        .where(
          and(
            inArray(webhookDeliveries.status, ['received', 'processing']),
            ...(controlledIds.length === 0
              ? []
              : [notInArray(webhookDeliveries.id, controlledIds)]),
          ),
        )
        .returning({ id: webhookDeliveries.id })
      return rows.length
    },

    async gcSlice(input) {
      if (!Number.isInteger(input.batchSize) || input.batchSize < 1) {
        throw new Error('maintenance-webhook-delivery-batch-invalid')
      }
      const cursor = gcCursor(input.cursor, input.now, input.retention)
      if (cursor.phase === 'bodies') {
        const batch = await db.all<{ id: string }>(sql`
          UPDATE webhook_deliveries SET body_json = NULL
          WHERE rowid IN (
            SELECT rowid FROM webhook_deliveries
            WHERE received_at < ${cursor.bodyCutoff} AND body_json IS NOT NULL
              AND status NOT IN ('received','processing')
            LIMIT ${input.batchSize}
          )
          RETURNING id`)
        return {
          done: false,
          cursor: {
            ...cursor,
            phase: batch.length < input.batchSize ? 'rows' : 'bodies',
          },
          counters: { bodiesCleared: batch.length, rowsDeleted: 0 },
        }
      }
      const batch = await db.all<{ id: string }>(sql`
        DELETE FROM webhook_deliveries
        WHERE rowid IN (
          SELECT rowid FROM webhook_deliveries
          WHERE received_at < ${cursor.rowCutoff}
            AND status NOT IN ('received','processing')
            AND NOT EXISTS (
              SELECT 1 FROM webhook_mr_control_effects effect
              WHERE effect.delivery_id = webhook_deliveries.id
                AND effect.status <> 'succeeded'
            )
            AND NOT EXISTS (
              SELECT 1 FROM webhook_mr_launch_guards guard
              WHERE guard.delivery_id = webhook_deliveries.id
                AND guard.status IN ('reserved','launching','revoking-terminal','task-committed')
            )
          LIMIT ${input.batchSize}
        )
        RETURNING id`)
      return {
        done: batch.length < input.batchSize,
        cursor,
        counters: { bodiesCleared: 0, rowsDeleted: batch.length },
      }
    },

    async touchEndpointLastDelivery(endpointId, now) {
      await db
        .update(webhookEndpoints)
        .set({ lastDeliveryAt: now })
        .where(eq(webhookEndpoints.id, endpointId))
    },
  }
}
