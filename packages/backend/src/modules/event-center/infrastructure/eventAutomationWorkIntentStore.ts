import { canonicalJson } from '@agent-workflow/shared'
import { and, eq, isNull, or } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { eventAutomationWorkIntents, eventDeliveries, eventResponseRules } from '@/db/schema'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import { ConflictError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import {
  eventResponseMaterializedSubscriptionId,
  eventResponseRuleIdFromSubscriberRef,
} from '../application/eventResponseRules'
import { materializeEventAutomationTarget } from '../application/eventAutomationTarget'
import type {
  EventAutomationWorkIntentStorePort,
  PreparedEventAutomationIntent,
} from '../application/ports/eventAutomationWorkIntentStore'
import type {
  EmployeeAutomationWorkStartV1,
  EventAutomationOriginRef,
  TaskAutomationWorkStartV1,
} from '../composition/required-ports'
import { eventResponseTargetSchema } from '../domain/responseRule'

function preparedIntentOf(
  row: typeof eventAutomationWorkIntents.$inferSelect,
): PreparedEventAutomationIntent {
  if (row.portId === 'task-automation-work-start.v1') {
    return {
      kind: 'task',
      origin: row.originRef as EventAutomationOriginRef,
      portId: row.portId,
      ownerUserId: row.ownerUserId,
      input: JSON.parse(row.targetPayloadJson) as TaskAutomationWorkStartV1,
      receiptRef: row.receiptRef,
    }
  }
  return {
    kind: 'employee',
    origin: row.originRef as EventAutomationOriginRef,
    portId: row.portId,
    ownerUserId: row.ownerUserId,
    input: JSON.parse(row.targetPayloadJson) as EmployeeAutomationWorkStartV1,
    receiptRef: row.receiptRef,
  }
}

export function createEventAutomationWorkIntentStore(
  db: ProviderNeutralDatabase,
): EventAutomationWorkIntentStorePort {
  const session = databaseSessionFor(db)
  return {
    async prepare(input) {
      return await session.transaction(async (tx) => {
        await engineOf(tx).lockAggregateRoot(
          tx,
          eventDeliveries,
          eventDeliveries.id,
          input.delivery.deliveryId,
        )
        const claimed = await tx
          .select()
          .from(eventDeliveries)
          .where(eq(eventDeliveries.id, input.delivery.deliveryId))
          .get()
        if (
          claimed === undefined ||
          claimed.state !== 'claimed' ||
          claimed.claimedBy !== input.claim.leaseOwner ||
          claimed.attemptCount !== input.claim.attemptCount
        ) {
          throw new ConflictError(
            'event-delivery-lease-lost',
            `event delivery lease was lost: ${input.delivery.deliveryId}`,
          )
        }

        const existing = await tx
          .select()
          .from(eventAutomationWorkIntents)
          .where(eq(eventAutomationWorkIntents.deliveryId, input.delivery.deliveryId))
          .get()
        const ruleId = eventResponseRuleIdFromSubscriberRef(input.delivery.subscriber.subscriberRef)
        if (ruleId === null) return { kind: 'obsolete' as const }
        const rule = await tx
          .select()
          .from(eventResponseRules)
          .where(eq(eventResponseRules.id, ruleId))
          .get()
        const current =
          rule !== undefined &&
          rule.enabled &&
          input.delivery.subscriptionId ===
            eventResponseMaterializedSubscriptionId(rule, input.delivery.subject)
        if (!current) {
          if (existing?.receiptRef !== null && existing?.receiptRef !== undefined) {
            return { kind: 'prepared' as const, intent: preparedIntentOf(existing) }
          }
          if (existing !== undefined) {
            await tx
              .update(eventAutomationWorkIntents)
              .set({ status: 'obsolete', updatedAt: input.now })
              .where(eq(eventAutomationWorkIntents.originRef, existing.originRef))
          }
          return { kind: 'obsolete' as const }
        }
        if (input.delivery.triggerContext === null) {
          throw new ValidationError(
            'event-response-trigger-context-missing',
            `event delivery has no declared task input contract: ${input.delivery.deliveryId}`,
          )
        }

        const target = eventResponseTargetSchema.parse(JSON.parse(rule.targetJson) as unknown)
        const materialized = materializeEventAutomationTarget(target, input.delivery.triggerContext)
        const targetPayloadJson = canonicalJson(materialized.input)
        const targetDigest = sha256Hex(canonicalJson(target))
        const ruleDigest = sha256Hex(
          canonicalJson({
            id: rule.id,
            ownerUserId: rule.ownerUserId,
            revision: rule.updatedAt,
            targetDigest,
          }),
        )
        const origin = `event-automation:${sha256Hex(
          canonicalJson({
            deliveryId: input.delivery.deliveryId,
            subscriptionId: input.delivery.subscriptionId,
            ruleId: rule.id,
            ruleRevision: rule.updatedAt,
            targetDigest,
          }),
        )}` as EventAutomationOriginRef
        const resolvedTargetRef =
          materialized.kind === 'task'
            ? materialized.input.target.refId
            : materialized.input.employeeId

        if (existing !== undefined) {
          if (
            existing.originRef !== origin ||
            existing.portId !== materialized.portId ||
            existing.targetDigest !== targetDigest
          ) {
            throw new ConflictError(
              'event-automation-intent-conflict',
              `event automation intent does not match its durable origin: ${input.delivery.deliveryId}`,
            )
          }
          await tx
            .update(eventAutomationWorkIntents)
            .set({
              claimOwner: input.claim.leaseOwner,
              claimAttempt: input.claim.attemptCount,
              updatedAt: input.now,
              ...(existing.receiptRef === null ? { status: 'prepared' as const } : {}),
            })
            .where(eq(eventAutomationWorkIntents.originRef, existing.originRef))
          return {
            kind: 'prepared' as const,
            intent: preparedIntentOf({
              ...existing,
              claimOwner: input.claim.leaseOwner,
              claimAttempt: input.claim.attemptCount,
              updatedAt: input.now,
              ...(existing.receiptRef === null ? { status: 'prepared' as const } : {}),
            }),
          }
        }

        await tx.insert(eventAutomationWorkIntents).values({
          originRef: origin,
          deliveryId: input.delivery.deliveryId,
          subscriptionId: input.delivery.subscriptionId,
          ruleId: rule.id,
          ruleRevision: rule.updatedAt,
          ruleDigest,
          ownerUserId: rule.ownerUserId,
          portId: materialized.portId,
          targetPayloadJson,
          targetFormatVersion: 1,
          targetDigest,
          resolvedTargetRef,
          receiptRef: null,
          status: 'prepared',
          claimOwner: input.claim.leaseOwner,
          claimAttempt: input.claim.attemptCount,
          lastError: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        const inserted = await tx
          .select()
          .from(eventAutomationWorkIntents)
          .where(eq(eventAutomationWorkIntents.originRef, origin))
          .get()
        if (inserted === undefined) throw new Error('event-automation-intent-insert-missing')
        return { kind: 'prepared' as const, intent: preparedIntentOf(inserted) }
      })
    },

    async recordReceipt(input) {
      const written = await db
        .update(eventAutomationWorkIntents)
        .set({
          receiptRef: input.receiptRef,
          status: 'launched',
          lastError: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(eventAutomationWorkIntents.originRef, input.origin),
            eq(eventAutomationWorkIntents.portId, input.portId),
            or(
              isNull(eventAutomationWorkIntents.receiptRef),
              eq(eventAutomationWorkIntents.receiptRef, input.receiptRef),
            ),
          ),
        )
        .returning({ originRef: eventAutomationWorkIntents.originRef })
        .get()
      if (written === undefined) {
        throw new ConflictError(
          'event-automation-receipt-conflict',
          `event automation receipt conflicts with its durable origin: ${input.origin}`,
        )
      }
    },

    async recordFailure(input) {
      await db
        .update(eventAutomationWorkIntents)
        .set({ status: 'failed', lastError: input.error, updatedAt: input.now })
        .where(
          and(
            eq(eventAutomationWorkIntents.originRef, input.origin),
            isNull(eventAutomationWorkIntents.receiptRef),
          ),
        )
    },

    async settle(input) {
      return await session.transaction(async (tx) => {
        await engineOf(tx).lockAggregateRoot(
          tx,
          eventDeliveries,
          eventDeliveries.id,
          input.delivery.deliveryId,
        )
        const claimed = await tx
          .select()
          .from(eventDeliveries)
          .where(eq(eventDeliveries.id, input.delivery.deliveryId))
          .get()
        if (
          claimed === undefined ||
          claimed.state !== 'claimed' ||
          claimed.claimedBy !== input.claim.leaseOwner ||
          claimed.attemptCount !== input.claim.attemptCount
        )
          return false

        const intent = await tx
          .select()
          .from(eventAutomationWorkIntents)
          .where(eq(eventAutomationWorkIntents.deliveryId, input.delivery.deliveryId))
          .get()
        const ruleId =
          intent?.ruleId ??
          eventResponseRuleIdFromSubscriberRef(input.delivery.subscriber.subscriberRef)
        if (ruleId !== null) {
          const rule = await tx
            .select()
            .from(eventResponseRules)
            .where(eq(eventResponseRules.id, ruleId))
            .get()
          const matchingRevision =
            rule !== undefined &&
            rule.enabled &&
            (intent === undefined || rule.updatedAt === intent.ruleRevision) &&
            input.delivery.subscriptionId ===
              eventResponseMaterializedSubscriptionId(rule, input.delivery.subject)
          if (matchingRevision) {
            await tx
              .update(eventResponseRules)
              .set({
                lastFiredAt: input.now,
                lastStatus: input.state === 'accepted' ? 'launched' : 'failed',
                lastError: input.state === 'accepted' ? null : input.error,
              })
              .where(
                and(
                  eq(eventResponseRules.id, ruleId),
                  eq(eventResponseRules.updatedAt, rule.updatedAt),
                ),
              )
          }
        }
        if (intent !== undefined) {
          const status =
            input.state === 'accepted'
              ? intent.receiptRef === null
                ? 'obsolete'
                : 'launched'
              : 'failed'
          await tx
            .update(eventAutomationWorkIntents)
            .set({ status, lastError: input.error, updatedAt: input.now })
            .where(eq(eventAutomationWorkIntents.originRef, intent.originRef))
        }
        const terminal = input.state !== 'pending'
        const settled = await tx
          .update(eventDeliveries)
          .set({
            state: input.state,
            nextAttemptAt: input.nextAttemptAt,
            claimedBy: null,
            claimExpiresAt: null,
            lastError: input.error,
            acceptedAt: input.state === 'accepted' ? input.now : null,
            deadLetterAt: input.state === 'dead-letter' ? input.now : null,
            ...(terminal ? {} : { acceptedAt: null, deadLetterAt: null }),
          })
          .where(
            and(
              eq(eventDeliveries.id, input.delivery.deliveryId),
              eq(eventDeliveries.state, 'claimed'),
              eq(eventDeliveries.claimedBy, input.claim.leaseOwner),
              eq(eventDeliveries.attemptCount, input.claim.attemptCount),
            ),
          )
          .returning({ id: eventDeliveries.id })
          .get()
        return settled !== undefined
      })
    },

    async resolve(origin, portId) {
      const row = await db
        .select({
          eventSubscriptionId: eventAutomationWorkIntents.subscriptionId,
          eventDeliveryId: eventAutomationWorkIntents.deliveryId,
        })
        .from(eventAutomationWorkIntents)
        .where(
          and(
            eq(eventAutomationWorkIntents.originRef, origin),
            eq(eventAutomationWorkIntents.portId, portId),
          ),
        )
        .get()
      return row ?? null
    },
  }
}
