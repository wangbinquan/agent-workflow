// RFC-349 — PostgreSQL committed-event delivery persistence. Ordering,
// lease-epoch CAS, retry/backoff, dead-letter and operator projections match
// the SQLite oracle while every operation stays Promise-shaped.
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  like,
  lt,
  lte,
  ne,
  notLike,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import {
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { assertNonNegativeInteger, assertPositiveInteger, storedEventFromRow } from './appendShared'
import type { ClaimedCommittedEventDelivery } from './types'
import type { CommittedEventDeliveryPersistencePort } from './persistence'

export type PostgresqlCommittedEventTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

function duePredicate(at: number): SQL<unknown> {
  return and(
    eq(committedEvents.deliveryMode, 'dispatchable'),
    eq(committedEventFamilyCutovers.mode, 'dispatchable'),
    eq(committedEvents.producerEpoch, committedEventFamilyCutovers.epoch),
    lte(committedEventDeliveries.nextAttemptAt, at),
    or(
      eq(committedEventDeliveries.state, 'pending'),
      and(
        eq(committedEventDeliveries.state, 'claimed'),
        lte(committedEventDeliveries.claimExpiresAt, at),
      ),
    ),
  )!
}

export function createPostgresqlCommittedEventDeliveryPersistence(
  db: PostgresqlDatabaseClient,
): CommittedEventDeliveryPersistencePort {
  return {
    async getStored(eventIds) {
      if (eventIds.length === 0) return []
      const rows = await db
        .select()
        .from(committedEvents)
        .where(inArray(committedEvents.id, [...eventIds]))
        .orderBy(asc(committedEvents.eventGroupId), asc(committedEvents.eventGroupOrdinal))
      return rows.map(storedEventFromRow)
    },
    async claimNext(input) {
      const leaseMs = input.leaseMs ?? 60_000
      const scanLimit = input.scanLimit ?? 64
      if (input.workerId.length === 0) throw new Error('committed event claim requires workerId')
      assertPositiveInteger(leaseMs, 'leaseMs')
      assertPositiveInteger(scanLimit, 'scanLimit')

      return await db.transaction(async (tx) => {
        const candidates = await tx
          .select({
            event: committedEvents,
            consumerId: committedEventDeliveries.consumerId,
            deliveryClass: committedEventDeliveries.deliveryClass,
            state: committedEventDeliveries.state,
            attemptCount: committedEventDeliveries.attemptCount,
            leaseEpoch: committedEventDeliveries.leaseEpoch,
          })
          .from(committedEventDeliveries)
          .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
          .innerJoin(
            committedEventFamilyCutovers,
            and(
              eq(committedEventFamilyCutovers.producer, committedEvents.producer),
              eq(committedEventFamilyCutovers.family, committedEvents.family),
            ),
          )
          .where(duePredicate(input.now))
          .orderBy(
            asc(committedEvents.createdAt),
            asc(committedEvents.eventGroupOrdinal),
            asc(committedEventDeliveries.consumerId),
          )
          .limit(scanLimit)

        for (const candidate of candidates) {
          const priorIds = (
            await tx
              .select({ id: committedEvents.id })
              .from(committedEvents)
              .where(
                and(
                  eq(committedEvents.producer, candidate.event.producer),
                  eq(committedEvents.family, candidate.event.family),
                  eq(committedEvents.aggregateKind, candidate.event.aggregateKind),
                  eq(committedEvents.aggregateId, candidate.event.aggregateId),
                  eq(committedEvents.deliveryMode, 'dispatchable'),
                  eq(committedEvents.producerEpoch, candidate.event.producerEpoch),
                  lt(committedEvents.aggregateSeq, candidate.event.aggregateSeq),
                ),
              )
          ).map((row) => row.id)
          if (priorIds.length > 0) {
            const blocker = await tx
              .select({ eventId: committedEventDeliveries.eventId })
              .from(committedEventDeliveries)
              .where(
                and(
                  inArray(committedEventDeliveries.eventId, priorIds),
                  eq(committedEventDeliveries.consumerId, candidate.consumerId),
                  ne(committedEventDeliveries.state, 'accepted'),
                ),
              )
              .limit(1)
              .get()
            if (blocker !== undefined) continue
          }

          const nextLeaseEpoch = candidate.leaseEpoch + 1
          const claimed = await tx
            .update(committedEventDeliveries)
            .set({
              state: 'claimed',
              attemptCount: candidate.attemptCount + 1,
              claimedBy: input.workerId,
              leaseEpoch: nextLeaseEpoch,
              claimExpiresAt: input.now + leaseMs,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(committedEventDeliveries.eventId, candidate.event.id),
                eq(committedEventDeliveries.consumerId, candidate.consumerId),
                eq(committedEventDeliveries.state, candidate.state),
                eq(committedEventDeliveries.leaseEpoch, candidate.leaseEpoch),
              ),
            )
            .returning({ eventId: committedEventDeliveries.eventId })
            .get()
          if (claimed === undefined) continue
          return {
            event: storedEventFromRow(candidate.event),
            consumerId: candidate.consumerId,
            deliveryClass: candidate.deliveryClass,
            attemptCount: candidate.attemptCount + 1,
            leaseEpoch: nextLeaseEpoch,
            claimedBy: input.workerId,
            claimExpiresAt: input.now + leaseMs,
          } satisfies ClaimedCommittedEventDelivery
        }
        return null
      })
    },
    async accept(input) {
      const updated = await db
        .update(committedEventDeliveries)
        .set({
          state: 'accepted',
          claimedBy: null,
          claimExpiresAt: null,
          lastErrorCode: null,
          lastErrorSummary: null,
          acceptedAt: input.now,
          deadLetterAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(committedEventDeliveries.eventId, input.claim.event.envelope.eventId),
            eq(committedEventDeliveries.consumerId, input.claim.consumerId),
            eq(committedEventDeliveries.state, 'claimed'),
            eq(committedEventDeliveries.claimedBy, input.claim.claimedBy),
            eq(committedEventDeliveries.leaseEpoch, input.claim.leaseEpoch),
          ),
        )
        .returning({ eventId: committedEventDeliveries.eventId })
        .get()
      if (updated === undefined) {
        throw new Error(
          `committed event delivery lease lost: ${input.claim.event.envelope.eventId}/${input.claim.consumerId}`,
        )
      }
    },
    async reject(input) {
      assertPositiveInteger(input.maxAttempts, 'maxAttempts')
      const terminal = input.claim.attemptCount >= input.maxAttempts
      const updated = await db
        .update(committedEventDeliveries)
        .set({
          state: terminal ? 'dead-letter' : 'pending',
          claimedBy: null,
          claimExpiresAt: null,
          nextAttemptAt: terminal
            ? input.now
            : input.now + Math.min(30_000, 1_000 * 2 ** Math.max(0, input.claim.attemptCount - 1)),
          lastErrorCode: input.errorCode.slice(0, 200),
          lastErrorSummary: input.errorSummary.slice(0, 2_000),
          deadLetterAt: terminal ? input.now : null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(committedEventDeliveries.eventId, input.claim.event.envelope.eventId),
            eq(committedEventDeliveries.consumerId, input.claim.consumerId),
            eq(committedEventDeliveries.state, 'claimed'),
            eq(committedEventDeliveries.claimedBy, input.claim.claimedBy),
            eq(committedEventDeliveries.leaseEpoch, input.claim.leaseEpoch),
          ),
        )
        .returning({ eventId: committedEventDeliveries.eventId })
        .get()
      if (updated === undefined) {
        throw new Error(
          `committed event delivery lease lost: ${input.claim.event.envelope.eventId}/${input.claim.consumerId}`,
        )
      }
      return terminal ? 'dead-letter' : 'retried'
    },
    async retry(input) {
      assertNonNegativeInteger(input.observedLeaseEpoch, 'observedLeaseEpoch')
      assertNonNegativeInteger(input.observedUpdatedAt, 'observedUpdatedAt')
      const at = input.now ?? Date.now()
      const row = await db
        .update(committedEventDeliveries)
        .set({
          state: 'pending',
          nextAttemptAt: at,
          claimedBy: null,
          claimExpiresAt: null,
          lastErrorCode: null,
          lastErrorSummary: null,
          deadLetterAt: null,
          replayGeneration: sql`${committedEventDeliveries.replayGeneration} + 1`,
          updatedAt: at,
        })
        .where(
          and(
            eq(committedEventDeliveries.eventId, input.eventId),
            eq(committedEventDeliveries.consumerId, input.consumerId),
            eq(committedEventDeliveries.state, 'dead-letter'),
            eq(committedEventDeliveries.leaseEpoch, input.observedLeaseEpoch),
            eq(committedEventDeliveries.updatedAt, input.observedUpdatedAt),
          ),
        )
        .returning({
          replayGeneration: committedEventDeliveries.replayGeneration,
          updatedAt: committedEventDeliveries.updatedAt,
        })
        .get()
      if (row === undefined) {
        throw new Error(
          `committed event delivery retry lost CAS: ${input.eventId}/${input.consumerId}`,
        )
      }
      return {
        eventId: input.eventId,
        consumerId: input.consumerId,
        replayGeneration: row.replayGeneration,
        state: 'pending',
        updatedAt: row.updatedAt,
      }
    },
    async deliveryPage(input) {
      assertPositiveInteger(input.page, 'page')
      assertPositiveInteger(input.limit, 'limit')
      const conditions: SQL[] = []
      if (input.stage === 'producer-publication') {
        conditions.push(like(committedEventDeliveries.consumerId, 'event-center.%'))
      } else if (input.stage === 'consumer-delivery') {
        conditions.push(notLike(committedEventDeliveries.consumerId, 'event-center.%'))
      }
      if (input.state != null) conditions.push(eq(committedEventDeliveries.state, input.state))
      if (input.producer != null) conditions.push(eq(committedEvents.producer, input.producer))
      if (input.family != null) conditions.push(eq(committedEvents.family, input.family))
      if (input.aggregateId != null && input.aggregateId.length > 0) {
        conditions.push(eq(committedEvents.aggregateId, input.aggregateId))
      }
      if (input.consumerId != null && input.consumerId.length > 0) {
        conditions.push(eq(committedEventDeliveries.consumerId, input.consumerId))
      }
      const where = conditions.length === 0 ? undefined : and(...conditions)
      const countRow = await db
        .select({ count: count() })
        .from(committedEventDeliveries)
        .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
        .where(where)
        .get()
      const total = Number(countRow?.count ?? 0)
      const rows = await db
        .select({ event: committedEvents, delivery: committedEventDeliveries })
        .from(committedEventDeliveries)
        .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
        .where(where)
        .orderBy(desc(committedEventDeliveries.updatedAt), desc(committedEvents.id))
        .limit(input.limit)
        .offset((input.page - 1) * input.limit)
      return {
        items: rows.map(({ event, delivery }) => ({
          eventId: event.id,
          stage: delivery.consumerId.startsWith('event-center.')
            ? 'producer-publication'
            : 'consumer-delivery',
          producer: event.producer,
          family: event.family,
          eventType: event.eventType,
          aggregateKind: event.aggregateKind,
          aggregateId: event.aggregateId,
          aggregateSeq: event.aggregateSeq,
          consumerId: delivery.consumerId,
          mode: event.deliveryMode,
          state: delivery.state,
          attemptCount: delivery.attemptCount,
          nextAttemptAt:
            delivery.state === 'accepted' || delivery.state === 'dead-letter'
              ? null
              : new Date(delivery.nextAttemptAt).toISOString(),
          leaseEpoch: delivery.leaseEpoch,
          lastErrorSummary: delivery.lastErrorSummary,
          updatedAt: new Date(delivery.updatedAt).toISOString(),
          canRetry: event.deliveryMode === 'dispatchable' && delivery.state === 'dead-letter',
        })),
        page: input.page,
        limit: input.limit,
        total,
        pageCount: Math.max(1, Math.ceil(total / input.limit)),
      }
    },
    async health() {
      const rows = await db
        .select({
          state: committedEventDeliveries.state,
          createdAt: committedEventDeliveries.createdAt,
          updatedAt: committedEventDeliveries.updatedAt,
          lastErrorSummary: committedEventDeliveries.lastErrorSummary,
        })
        .from(committedEventDeliveries)
      const pendingRows = rows.filter((row) => row.state === 'pending')
      const lastError = [...rows]
        .filter((row) => row.lastErrorSummary !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      return {
        pending: pendingRows.length,
        claimed: rows.filter((row) => row.state === 'claimed').length,
        deadLetter: rows.filter((row) => row.state === 'dead-letter').length,
        oldestPendingAt:
          pendingRows.length === 0 ? null : Math.min(...pendingRows.map((row) => row.createdAt)),
        lastErrorSummary: lastError?.lastErrorSummary ?? null,
      }
    },
  }
}
