import { and, eq, inArray, isNotNull, lt, notExists, notInArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  webhookDeliveries,
  webhookEndpoints,
  webhookMrControlEffects,
  webhookMrLaunchGuards,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
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

export function createPostgresqlWebhookDeliveryPersistence(
  db: PostgresqlDatabaseClient,
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
        const existing = await db
          .update(webhookDeliveries)
          .set({ attemptCount: sql`${webhookDeliveries.attemptCount} + 1` })
          .where(
            and(
              eq(webhookDeliveries.endpointId, input.endpointId),
              eq(webhookDeliveries.eventUuid, input.eventUuid),
              notInArray(webhookDeliveries.status, ['rejected', 'failed']),
            ),
          )
          .returning({
            id: webhookDeliveries.id,
            attemptCount: webhookDeliveries.attemptCount,
          })
          .get()
        if (existing === undefined) throw error
        return {
          kind: 'duplicate',
          deliveryId: existing.id,
          attemptCount: existing.attemptCount,
        }
      }
    },

    async mark(input) {
      await db
        .update(webhookDeliveries)
        .set({ status: input.status, statusReason: input.reason ?? null })
        .where(eq(webhookDeliveries.id, input.deliveryId))
    },

    async recoverInterrupted() {
      return await db.transaction(async (tx) => {
        const controlledIds = (
          await tx.select({ id: webhookMrControlEffects.deliveryId }).from(webhookMrControlEffects)
        ).map((row) => row.id)
        if (controlledIds.length > 0) {
          await tx
            .update(webhookDeliveries)
            .set({ status: 'matched', statusReason: 'terminal-control-accepted' })
            .where(
              and(
                inArray(webhookDeliveries.id, controlledIds),
                inArray(webhookDeliveries.status, ['received', 'processing']),
              ),
            )
        }
        const rows = await tx
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
      })
    },

    async gcSlice(input) {
      if (!Number.isInteger(input.batchSize) || input.batchSize < 1) {
        throw new Error('maintenance-webhook-delivery-batch-invalid')
      }
      const cursor = gcCursor(input.cursor, input.now, input.retention)
      if (cursor.phase === 'bodies') {
        const count = await db.transaction(async (tx) => {
          const ids = (
            await tx
              .select({ id: webhookDeliveries.id })
              .from(webhookDeliveries)
              .where(
                and(
                  lt(webhookDeliveries.receivedAt, cursor.bodyCutoff),
                  isNotNull(webhookDeliveries.bodyJson),
                  notInArray(webhookDeliveries.status, ['received', 'processing']),
                ),
              )
              .limit(input.batchSize)
          ).map((row) => row.id)
          if (ids.length === 0) return 0
          return (
            await tx
              .update(webhookDeliveries)
              .set({ bodyJson: null })
              .where(inArray(webhookDeliveries.id, ids))
              .returning({ id: webhookDeliveries.id })
          ).length
        })
        return {
          done: false,
          cursor: { ...cursor, phase: count < input.batchSize ? 'rows' : 'bodies' },
          counters: { bodiesCleared: count, rowsDeleted: 0 },
        }
      }

      const count = await db.transaction(async (tx) => {
        const ids = (
          await tx
            .select({ id: webhookDeliveries.id })
            .from(webhookDeliveries)
            .where(
              and(
                lt(webhookDeliveries.receivedAt, cursor.rowCutoff),
                notInArray(webhookDeliveries.status, ['received', 'processing']),
                notExists(
                  tx
                    .select({ id: webhookMrControlEffects.id })
                    .from(webhookMrControlEffects)
                    .where(
                      and(
                        eq(webhookMrControlEffects.deliveryId, webhookDeliveries.id),
                        notInArray(webhookMrControlEffects.status, ['succeeded']),
                      ),
                    ),
                ),
                notExists(
                  tx
                    .select({ id: webhookMrLaunchGuards.id })
                    .from(webhookMrLaunchGuards)
                    .where(
                      and(
                        eq(webhookMrLaunchGuards.deliveryId, webhookDeliveries.id),
                        inArray(webhookMrLaunchGuards.status, [
                          'reserved',
                          'launching',
                          'revoking-terminal',
                          'task-committed',
                        ]),
                      ),
                    ),
                ),
              ),
            )
            .limit(input.batchSize)
        ).map((row) => row.id)
        if (ids.length === 0) return 0
        return (
          await tx
            .delete(webhookDeliveries)
            .where(inArray(webhookDeliveries.id, ids))
            .returning({ id: webhookDeliveries.id })
        ).length
      })
      return {
        done: count < input.batchSize,
        cursor,
        counters: { bodiesCleared: 0, rowsDeleted: count },
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
