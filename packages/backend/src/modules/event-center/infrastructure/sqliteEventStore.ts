import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  eventDeliveries,
  eventObserverRuns,
  eventRecords,
  eventSources,
  eventSubscriptions,
  eventTypeCatalog,
  observerActivations,
} from '@/db/schema'
import type { EventStorePort, ObservationStoreReceipt } from '../application/ports/eventStore'
import {
  eventSourceDescriptorSchema,
  eventTypeDescriptorSchema,
  type EventDeliveryRecord,
  type EventExactRef,
  type EventSubject,
  type EventSubscriber,
  type EventSubscriptionRecord,
  type ObserverActivationRecord,
} from '../domain/model'

function changes(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}

function sourceWhere(ref: EventExactRef) {
  return and(eq(eventSources.sourceId, ref.id), eq(eventSources.revision, ref.revision))
}

function typeWhere(ref: EventExactRef) {
  return and(eq(eventTypeCatalog.eventTypeId, ref.id), eq(eventTypeCatalog.revision, ref.revision))
}

function subscriptionRecord(row: typeof eventSubscriptions.$inferSelect): EventSubscriptionRecord {
  return {
    id: row.id,
    eventTypeRef: { id: row.eventTypeId, revision: row.eventTypeRevision },
    sourceRef: { id: row.sourceId, revision: row.sourceRevision },
    subject: { typeId: row.subjectType, subjectRef: row.subjectRef },
    subscriber: {
      kind: row.subscriberKind as EventSubscriber['kind'],
      subscriberRef: row.subscriberRef,
    },
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
  }
}

function activationRecord(row: typeof observerActivations.$inferSelect): ObserverActivationRecord {
  return {
    sourceRef: { id: row.sourceId, revision: row.sourceRevision },
    subscriberCount: row.subscriberCount,
    state: row.state,
    generation: row.generation,
    wakeEpoch: row.wakeEpoch,
    cursorJson: row.cursorJson,
    leaseOwner: row.leaseOwner,
    leaseEpoch: row.leaseEpoch,
    leaseExpiresAt: row.leaseExpiresAt,
    nextScanAt: row.nextScanAt,
    lastScanAt: row.lastScanAt,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorCode: row.lastErrorCode,
    updatedAt: row.updatedAt,
  }
}

function uniqueSubjects(
  rows: readonly { subjectType: string; subjectRef: string }[],
): EventSubject[] {
  const seen = new Set<string>()
  const result: EventSubject[] = []
  for (const row of rows) {
    const key = `${row.subjectType}\u0000${row.subjectRef}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ typeId: row.subjectType, subjectRef: row.subjectRef })
  }
  return result
}

function rotatingSubjectBatch(
  subjects: readonly EventSubject[],
  batchSize: number,
  completedLeaseEpochs: number,
): EventSubject[] {
  if (subjects.length <= batchSize) return [...subjects]
  const start = (completedLeaseEpochs * batchSize) % subjects.length
  return Array.from(
    { length: batchSize },
    (_, offset) => subjects[(start + offset) % subjects.length]!,
  )
}

export function createSqliteEventStore(db: DbClient): EventStorePort {
  return {
    registerSource(descriptor, digest, now) {
      db.insert(eventSources)
        .values({
          sourceId: descriptor.sourceRef.id,
          revision: descriptor.sourceRef.revision,
          descriptorJson: JSON.stringify(descriptor),
          descriptorDigest: digest,
          state: 'published',
          registeredAt: now,
        })
        .onConflictDoUpdate({
          target: [eventSources.sourceId, eventSources.revision],
          set: { descriptorJson: JSON.stringify(descriptor), descriptorDigest: digest },
        })
        .run()
    },

    registerEventType(descriptor, digest, now) {
      db.insert(eventTypeCatalog)
        .values({
          eventTypeId: descriptor.eventTypeRef.id,
          revision: descriptor.eventTypeRef.revision,
          sourceId: descriptor.sourceRef.id,
          sourceRevision: descriptor.sourceRef.revision,
          descriptorJson: JSON.stringify(descriptor),
          descriptorDigest: digest,
          state: 'published',
          registeredAt: now,
        })
        .onConflictDoUpdate({
          target: [eventTypeCatalog.eventTypeId, eventTypeCatalog.revision],
          set: {
            sourceId: descriptor.sourceRef.id,
            sourceRevision: descriptor.sourceRef.revision,
            descriptorJson: JSON.stringify(descriptor),
            descriptorDigest: digest,
          },
        })
        .run()
    },

    getSource(ref) {
      const row = db.select().from(eventSources).where(sourceWhere(ref)).get()
      return row === undefined
        ? null
        : eventSourceDescriptorSchema.parse(JSON.parse(row.descriptorJson) as unknown)
    },

    getEventType(ref) {
      const row = db.select().from(eventTypeCatalog).where(typeWhere(ref)).get()
      return row === undefined
        ? null
        : eventTypeDescriptorSchema.parse(JSON.parse(row.descriptorJson) as unknown)
    },

    listSources() {
      return db
        .select()
        .from(eventSources)
        .where(eq(eventSources.state, 'published'))
        .orderBy(asc(eventSources.sourceId), desc(eventSources.revision))
        .all()
        .map((row) => eventSourceDescriptorSchema.parse(JSON.parse(row.descriptorJson) as unknown))
    },

    listEventTypes() {
      return db
        .select()
        .from(eventTypeCatalog)
        .where(eq(eventTypeCatalog.state, 'published'))
        .orderBy(asc(eventTypeCatalog.eventTypeId), desc(eventTypeCatalog.revision))
        .all()
        .map((row) => eventTypeDescriptorSchema.parse(JSON.parse(row.descriptorJson) as unknown))
    },

    subscribe(input) {
      const existing = db
        .select()
        .from(eventSubscriptions)
        .where(eq(eventSubscriptions.activeIdentityKey, input.identityKey))
        .get()
      if (existing !== undefined) {
        return {
          record: subscriptionRecord(existing),
          created: false,
          observerTransition: 'none',
        }
      }

      return db.transaction((tx) => {
        tx.insert(eventSubscriptions)
          .values({
            id: input.id,
            eventTypeId: input.eventType.eventTypeRef.id,
            eventTypeRevision: input.eventType.eventTypeRef.revision,
            sourceId: input.source.sourceRef.id,
            sourceRevision: input.source.sourceRef.revision,
            subjectType: input.subject.typeId,
            subjectRef: input.subject.subjectRef,
            subscriberKind: input.subscriber.kind,
            subscriberRef: input.subscriber.subscriberRef,
            activeIdentityKey: input.identityKey,
            state: 'active',
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()

        const latestEvent = tx
          .select({ id: eventRecords.id })
          .from(eventRecords)
          .where(
            and(
              eq(eventRecords.eventTypeId, input.eventType.eventTypeRef.id),
              eq(eventRecords.eventTypeRevision, input.eventType.eventTypeRef.revision),
              eq(eventRecords.sourceId, input.source.sourceRef.id),
              eq(eventRecords.sourceRevision, input.source.sourceRef.revision),
              eq(eventRecords.subjectType, input.subject.typeId),
              eq(eventRecords.subjectRef, input.subject.subjectRef),
            ),
          )
          .orderBy(
            desc(eventRecords.occurredAt),
            desc(eventRecords.observedAt),
            desc(eventRecords.id),
          )
          .get()
        if (latestEvent !== undefined) {
          tx.insert(eventDeliveries)
            .values({
              id: `${input.id}:replay`,
              eventId: latestEvent.id,
              subscriptionId: input.id,
              subscriberKind: input.subscriber.kind,
              subscriberRef: input.subscriber.subscriberRef,
              deliveryClass: input.eventType.deliveryClass,
              priority: input.eventType.priority,
              state: 'pending',
              attemptCount: 0,
              createdAt: input.now,
            })
            .onConflictDoNothing()
            .run()
        }

        let observerTransition: 'none' | 'started' = 'none'
        if (input.source.observationMode !== 'passive') {
          const activation = tx
            .select()
            .from(observerActivations)
            .where(
              and(
                eq(observerActivations.sourceId, input.source.sourceRef.id),
                eq(observerActivations.sourceRevision, input.source.sourceRef.revision),
              ),
            )
            .get()
          if (activation === undefined) {
            tx.insert(observerActivations)
              .values({
                sourceId: input.source.sourceRef.id,
                sourceRevision: input.source.sourceRef.revision,
                subscriberCount: 1,
                state: 'active',
                generation: 1,
                nextScanAt: input.now,
                updatedAt: input.now,
              })
              .run()
            observerTransition = 'started'
          } else {
            const restarting = activation.subscriberCount === 0
            tx.update(observerActivations)
              .set({
                subscriberCount: activation.subscriberCount + 1,
                state: 'active',
                generation: restarting ? activation.generation + 1 : activation.generation,
                cursorJson: restarting ? null : activation.cursorJson,
                nextScanAt: restarting ? input.now : activation.nextScanAt,
                lastErrorCode: null,
                updatedAt: input.now,
              })
              .where(
                and(
                  eq(observerActivations.sourceId, activation.sourceId),
                  eq(observerActivations.sourceRevision, activation.sourceRevision),
                ),
              )
              .run()
            if (restarting) observerTransition = 'started'
          }
        }

        return {
          record: subscriptionRecord({
            id: input.id,
            eventTypeId: input.eventType.eventTypeRef.id,
            eventTypeRevision: input.eventType.eventTypeRef.revision,
            sourceId: input.source.sourceRef.id,
            sourceRevision: input.source.sourceRef.revision,
            subjectType: input.subject.typeId,
            subjectRef: input.subject.subjectRef,
            subscriberKind: input.subscriber.kind,
            subscriberRef: input.subscriber.subscriberRef,
            activeIdentityKey: input.identityKey,
            state: 'active',
            createdAt: input.now,
            updatedAt: input.now,
            cancelledAt: null,
          }),
          created: true,
          observerTransition,
        }
      })
    },

    cancelSubscription(id, now) {
      const current = db
        .select()
        .from(eventSubscriptions)
        .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.state, 'active')))
        .get()
      if (current === undefined) return null

      return db.transaction((tx) => {
        tx.update(eventSubscriptions)
          .set({
            state: 'cancelled',
            activeIdentityKey: null,
            cancelledAt: now,
            updatedAt: now,
          })
          .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.state, 'active')))
          .run()

        let observerTransition: 'none' | 'stopped' = 'none'
        const activation = tx
          .select()
          .from(observerActivations)
          .where(
            and(
              eq(observerActivations.sourceId, current.sourceId),
              eq(observerActivations.sourceRevision, current.sourceRevision),
            ),
          )
          .get()
        if (activation !== undefined) {
          const count = Math.max(0, activation.subscriberCount - 1)
          const stopped = count === 0
          tx.update(observerActivations)
            .set({
              subscriberCount: count,
              state: stopped ? 'draining' : activation.state,
              generation: stopped ? activation.generation + 1 : activation.generation,
              nextScanAt: stopped ? now : activation.nextScanAt,
              updatedAt: now,
            })
            .where(
              and(
                eq(observerActivations.sourceId, activation.sourceId),
                eq(observerActivations.sourceRevision, activation.sourceRevision),
              ),
            )
            .run()
          if (stopped) observerTransition = 'stopped'
        }

        return {
          record: subscriptionRecord({
            ...current,
            activeIdentityKey: null,
            state: 'cancelled',
            cancelledAt: now,
            updatedAt: now,
          }),
          created: false,
          observerTransition,
        }
      })
    },

    nudgeObserver(sourceRef, now) {
      return (
        changes(
          db
            .update(observerActivations)
            .set({
              wakeEpoch: sql`${observerActivations.wakeEpoch} + 1`,
              nextScanAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(observerActivations.sourceId, sourceRef.id),
                eq(observerActivations.sourceRevision, sourceRef.revision),
                eq(observerActivations.state, 'active'),
                sql`${observerActivations.subscriberCount} > 0`,
              ),
            )
            .run(),
        ) === 1
      )
    },

    listSubscriptions(subscriberRef) {
      const condition =
        subscriberRef === undefined
          ? undefined
          : eq(eventSubscriptions.subscriberRef, subscriberRef)
      return db
        .select()
        .from(eventSubscriptions)
        .where(condition)
        .orderBy(desc(eventSubscriptions.createdAt))
        .all()
        .map(subscriptionRecord)
    },

    recordObservation(input) {
      const existing = db
        .select({ id: eventRecords.id })
        .from(eventRecords)
        .where(
          and(
            eq(eventRecords.sourceId, input.observation.sourceRef.id),
            eq(eventRecords.sourceRevision, input.observation.sourceRef.revision),
            eq(eventRecords.dedupeKey, input.observation.dedupeKey),
          ),
        )
        .get()
      if (existing !== undefined) {
        const deliveryCount = db
          .select({ id: eventDeliveries.id })
          .from(eventDeliveries)
          .where(eq(eventDeliveries.eventId, existing.id))
          .all().length
        return { eventId: existing.id, duplicate: true, deliveryCount }
      }

      return db.transaction((tx): ObservationStoreReceipt => {
        tx.insert(eventRecords)
          .values({
            id: input.eventId,
            eventTypeId: input.observation.eventTypeRef.id,
            eventTypeRevision: input.observation.eventTypeRef.revision,
            sourceId: input.observation.sourceRef.id,
            sourceRevision: input.observation.sourceRef.revision,
            subjectType: input.observation.subject.typeId,
            subjectRef: input.observation.subject.subjectRef,
            occurredAt: input.observation.occurredAt,
            observedAt: input.observedAt,
            dedupeKey: input.observation.dedupeKey,
            summaryJson: JSON.stringify({ summary: input.observation.summary }),
            payloadArtifactRef: input.observation.payloadArtifactRef,
          })
          .run()
        const subscriptions = tx
          .select()
          .from(eventSubscriptions)
          .where(
            and(
              eq(eventSubscriptions.eventTypeId, input.observation.eventTypeRef.id),
              eq(eventSubscriptions.eventTypeRevision, input.observation.eventTypeRef.revision),
              eq(eventSubscriptions.subjectType, input.observation.subject.typeId),
              eq(eventSubscriptions.subjectRef, input.observation.subject.subjectRef),
              eq(eventSubscriptions.state, 'active'),
            ),
          )
          .all()
        for (const subscription of subscriptions) {
          tx.insert(eventDeliveries)
            .values({
              id: input.nextId(),
              eventId: input.eventId,
              subscriptionId: subscription.id,
              subscriberKind: subscription.subscriberKind,
              subscriberRef: subscription.subscriberRef,
              deliveryClass: input.eventType.deliveryClass,
              priority: input.eventType.priority,
              state: 'pending',
              createdAt: input.observedAt,
            })
            .run()
        }
        return {
          eventId: input.eventId,
          duplicate: false,
          deliveryCount: subscriptions.length,
        }
      })
    },

    listPendingDeliveries(subscriber, limit) {
      return db
        .select({
          deliveryId: eventDeliveries.id,
          eventId: eventDeliveries.eventId,
          subscriptionId: eventDeliveries.subscriptionId,
          subscriberKind: eventDeliveries.subscriberKind,
          subscriberRef: eventDeliveries.subscriberRef,
          eventTypeId: eventRecords.eventTypeId,
          eventTypeRevision: eventRecords.eventTypeRevision,
          sourceId: eventRecords.sourceId,
          sourceRevision: eventRecords.sourceRevision,
          subjectType: eventRecords.subjectType,
          subjectRef: eventRecords.subjectRef,
          deliveryClass: eventDeliveries.deliveryClass,
          priority: eventDeliveries.priority,
          occurredAt: eventRecords.occurredAt,
          summaryJson: eventRecords.summaryJson,
          payloadArtifactRef: eventRecords.payloadArtifactRef,
          createdAt: eventDeliveries.createdAt,
        })
        .from(eventDeliveries)
        .innerJoin(eventRecords, eq(eventRecords.id, eventDeliveries.eventId))
        .where(
          and(
            eq(eventDeliveries.subscriberKind, subscriber.kind),
            eq(eventDeliveries.subscriberRef, subscriber.subscriberRef),
            eq(eventDeliveries.state, 'pending'),
          ),
        )
        .orderBy(desc(eventDeliveries.priority), asc(eventRecords.occurredAt), asc(eventRecords.id))
        .limit(Math.max(1, Math.min(1_000, limit)))
        .all()
        .map(
          (row): EventDeliveryRecord => ({
            deliveryId: row.deliveryId,
            eventId: row.eventId,
            subscriptionId: row.subscriptionId,
            subscriber: {
              kind: row.subscriberKind as EventSubscriber['kind'],
              subscriberRef: row.subscriberRef,
            },
            eventTypeRef: { id: row.eventTypeId, revision: row.eventTypeRevision },
            sourceRef: { id: row.sourceId, revision: row.sourceRevision },
            subject: { typeId: row.subjectType, subjectRef: row.subjectRef },
            deliveryClass: row.deliveryClass,
            priority: row.priority,
            occurredAt: row.occurredAt,
            summary: (JSON.parse(row.summaryJson) as { summary: string }).summary,
            payloadArtifactRef: row.payloadArtifactRef,
            createdAt: row.createdAt,
          }),
        )
    },

    acceptDelivery(deliveryId, now) {
      const result = db
        .update(eventDeliveries)
        .set({ state: 'accepted', acceptedAt: now })
        .where(and(eq(eventDeliveries.id, deliveryId), eq(eventDeliveries.state, 'pending')))
        .run()
      if (changes(result) === 1) return true
      return (
        db
          .select({ id: eventDeliveries.id })
          .from(eventDeliveries)
          .where(and(eq(eventDeliveries.id, deliveryId), eq(eventDeliveries.state, 'accepted')))
          .get() !== undefined
      )
    },

    listObserverActivations() {
      return db
        .select()
        .from(observerActivations)
        .orderBy(asc(observerActivations.sourceId), desc(observerActivations.sourceRevision))
        .all()
        .map(activationRecord)
    },

    claimDueObserver(input) {
      const candidates = db
        .select()
        .from(observerActivations)
        .where(
          and(
            inArray(observerActivations.state, ['active', 'draining']),
            or(
              isNull(observerActivations.nextScanAt),
              lte(observerActivations.nextScanAt, input.now),
            ),
            or(
              isNull(observerActivations.leaseExpiresAt),
              lte(observerActivations.leaseExpiresAt, input.now),
            ),
          ),
        )
        .orderBy(asc(observerActivations.nextScanAt), asc(observerActivations.sourceId))
        .limit(20)
        .all()

      for (const candidate of candidates) {
        if (candidate.subscriberCount === 0 || candidate.state === 'draining') {
          db.update(observerActivations)
            .set({
              state: 'idle',
              nextScanAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(observerActivations.sourceId, candidate.sourceId),
                eq(observerActivations.sourceRevision, candidate.sourceRevision),
                eq(observerActivations.generation, candidate.generation),
              ),
            )
            .run()
          continue
        }
        const sourceRow = db
          .select()
          .from(eventSources)
          .where(
            and(
              eq(eventSources.sourceId, candidate.sourceId),
              eq(eventSources.revision, candidate.sourceRevision),
              eq(eventSources.state, 'published'),
            ),
          )
          .get()
        if (sourceRow === undefined) continue
        const source = eventSourceDescriptorSchema.parse(
          JSON.parse(sourceRow.descriptorJson) as unknown,
        )
        const subjectRows = db
          .select({
            subjectType: eventSubscriptions.subjectType,
            subjectRef: eventSubscriptions.subjectRef,
          })
          .from(eventSubscriptions)
          .where(
            and(
              eq(eventSubscriptions.sourceId, candidate.sourceId),
              eq(eventSubscriptions.sourceRevision, candidate.sourceRevision),
              eq(eventSubscriptions.state, 'active'),
            ),
          )
          .all()
        const subjects = uniqueSubjects(subjectRows)
        const leaseEpoch = candidate.leaseEpoch + 1
        const claimed = changes(
          db
            .update(observerActivations)
            .set({
              leaseOwner: input.leaseOwner,
              leaseEpoch,
              leaseExpiresAt: input.now + input.leaseMs,
              lastScanAt: input.now,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(observerActivations.sourceId, candidate.sourceId),
                eq(observerActivations.sourceRevision, candidate.sourceRevision),
                eq(observerActivations.generation, candidate.generation),
                eq(observerActivations.leaseEpoch, candidate.leaseEpoch),
                or(
                  isNull(observerActivations.leaseExpiresAt),
                  lte(observerActivations.leaseExpiresAt, input.now),
                ),
              ),
            )
            .run(),
        )
        if (claimed !== 1) continue
        db.insert(eventObserverRuns)
          .values({
            id: input.runId,
            sourceId: candidate.sourceId,
            sourceRevision: candidate.sourceRevision,
            generation: candidate.generation,
            leaseEpoch,
            wakeEpoch: candidate.wakeEpoch,
            cursorBeforeJson: candidate.cursorJson,
            state: 'running',
            startedAt: input.now,
          })
          .run()
        return {
          runId: input.runId,
          source,
          generation: candidate.generation,
          leaseOwner: input.leaseOwner,
          leaseEpoch,
          wakeEpoch: candidate.wakeEpoch,
          cursorJson: candidate.cursorJson,
          subjects: rotatingSubjectBatch(subjects, source.batchSize, candidate.leaseEpoch),
        }
      }
      return null
    },

    settleObserver(input) {
      return db.transaction((tx) => {
        const activation = tx
          .select()
          .from(observerActivations)
          .where(
            and(
              eq(observerActivations.sourceId, input.run.source.sourceRef.id),
              eq(observerActivations.sourceRevision, input.run.source.sourceRef.revision),
            ),
          )
          .get()
        const current =
          activation !== undefined &&
          activation.generation === input.run.generation &&
          activation.leaseOwner === input.run.leaseOwner &&
          activation.leaseEpoch === input.run.leaseEpoch &&
          activation.subscriberCount > 0 &&
          activation.state === 'active'
        if (!current) {
          tx.update(eventObserverRuns)
            .set({ state: 'obsolete', finishedAt: input.now })
            .where(eq(eventObserverRuns.id, input.run.runId))
            .run()
          return 'obsolete' as const
        }

        if (input.errorCode !== null) {
          const nudgedDuringRun = activation.wakeEpoch > input.run.wakeEpoch
          tx.update(eventObserverRuns)
            .set({
              state: 'failed',
              finishedAt: input.now,
              errorCode: input.errorCode,
              errorDetail: input.errorDetail,
            })
            .where(eq(eventObserverRuns.id, input.run.runId))
            .run()
          tx.update(observerActivations)
            .set({
              leaseOwner: null,
              leaseExpiresAt: null,
              nextScanAt: nudgedDuringRun
                ? input.now
                : input.now + Math.min(input.run.source.pollIntervalMs, 30_000),
              lastErrorCode: input.errorCode,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(observerActivations.sourceId, input.run.source.sourceRef.id),
                eq(observerActivations.sourceRevision, input.run.source.sourceRef.revision),
                eq(observerActivations.leaseEpoch, input.run.leaseEpoch),
              ),
            )
            .run()
          return 'failed' as const
        }

        for (const item of input.observations) {
          const existing = tx
            .select({ id: eventRecords.id })
            .from(eventRecords)
            .where(
              and(
                eq(eventRecords.sourceId, item.observation.sourceRef.id),
                eq(eventRecords.sourceRevision, item.observation.sourceRef.revision),
                eq(eventRecords.dedupeKey, item.observation.dedupeKey),
              ),
            )
            .get()
          if (existing !== undefined) continue
          tx.insert(eventRecords)
            .values({
              id: item.eventId,
              eventTypeId: item.observation.eventTypeRef.id,
              eventTypeRevision: item.observation.eventTypeRef.revision,
              sourceId: item.observation.sourceRef.id,
              sourceRevision: item.observation.sourceRef.revision,
              subjectType: item.observation.subject.typeId,
              subjectRef: item.observation.subject.subjectRef,
              occurredAt: item.observation.occurredAt,
              observedAt: input.now,
              dedupeKey: item.observation.dedupeKey,
              summaryJson: JSON.stringify({ summary: item.observation.summary }),
              payloadArtifactRef: item.observation.payloadArtifactRef,
            })
            .run()
          const subscriptions = tx
            .select()
            .from(eventSubscriptions)
            .where(
              and(
                eq(eventSubscriptions.eventTypeId, item.observation.eventTypeRef.id),
                eq(eventSubscriptions.eventTypeRevision, item.observation.eventTypeRef.revision),
                eq(eventSubscriptions.subjectType, item.observation.subject.typeId),
                eq(eventSubscriptions.subjectRef, item.observation.subject.subjectRef),
                eq(eventSubscriptions.state, 'active'),
              ),
            )
            .all()
          for (const subscription of subscriptions) {
            tx.insert(eventDeliveries)
              .values({
                id: input.nextId(),
                eventId: item.eventId,
                subscriptionId: subscription.id,
                subscriberKind: subscription.subscriberKind,
                subscriberRef: subscription.subscriberRef,
                deliveryClass: item.eventType.deliveryClass,
                priority: item.eventType.priority,
                state: 'pending',
                createdAt: input.now,
              })
              .run()
          }
        }

        tx.update(eventObserverRuns)
          .set({
            state: 'completed',
            cursorAfterJson: input.cursorJson,
            observationCount: input.observations.length,
            finishedAt: input.now,
          })
          .where(eq(eventObserverRuns.id, input.run.runId))
          .run()
        const nudgedDuringRun = activation.wakeEpoch > input.run.wakeEpoch
        tx.update(observerActivations)
          .set({
            cursorJson: input.cursorJson,
            leaseOwner: null,
            leaseExpiresAt: null,
            nextScanAt: nudgedDuringRun ? input.now : input.now + input.run.source.pollIntervalMs,
            lastSuccessAt: input.now,
            lastErrorCode: null,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(observerActivations.sourceId, input.run.source.sourceRef.id),
              eq(observerActivations.sourceRevision, input.run.source.sourceRef.revision),
              eq(observerActivations.leaseEpoch, input.run.leaseEpoch),
            ),
          )
          .run()
        return 'completed' as const
      })
    },
  }
}
