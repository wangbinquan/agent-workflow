import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { TriggerContextSchema } from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
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
  eventTypeContentDigest,
  eventTypeDescriptorSchema,
  type EventDeliveryRecord,
  type EventDeliveryStatusRecord,
  type EventRecordAuditRecord,
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
  const origin =
    row.originKind === null || row.originRef === null || row.definitionRevision === null
      ? null
      : {
          kind: row.originKind,
          ref: row.originRef,
          definitionRevision: row.definitionRevision,
        }
  return {
    id: row.id,
    eventTypeRef: { id: row.eventTypeId, revision: row.eventTypeRevision },
    sourceRef: { id: row.sourceId, revision: row.sourceRevision },
    subject: { typeId: row.subjectType, subjectRef: row.subjectRef },
    subscriber: {
      kind: row.subscriberKind as EventSubscriber['kind'],
      subscriberRef: row.subscriberRef,
    },
    mode: row.mode,
    origin,
    displayName:
      row.displayNameJson === null
        ? null
        : (JSON.parse(row.displayNameJson) as EventSubscriptionRecord['displayName']),
    selector:
      row.selectorKind === null || row.selectorJson === null
        ? null
        : {
            kind: row.selectorKind,
            config: JSON.parse(row.selectorJson) as NonNullable<
              EventSubscriptionRecord['selector']
            >['config'],
          },
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
  }
}

function eventDocument(summaryJson: string): {
  readonly summary: string
  readonly routingFacts: EventDeliveryRecord['routingFacts']
  readonly triggerContext: EventDeliveryRecord['triggerContext']
} {
  const parsed = JSON.parse(summaryJson) as {
    summary: string
    routingFacts?: EventDeliveryRecord['routingFacts']
    triggerContext?: unknown
  }
  return {
    summary: parsed.summary,
    routingFacts: parsed.routingFacts ?? null,
    triggerContext:
      parsed.triggerContext === undefined || parsed.triggerContext === null
        ? null
        : TriggerContextSchema.parse(parsed.triggerContext),
  }
}

function loadDeliveryRecord(db: DbClient, deliveryId: string): EventDeliveryRecord | null {
  const row = db
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
      occurredAt: eventRecords.occurredAt,
      summaryJson: eventRecords.summaryJson,
      payloadArtifactRef: eventRecords.payloadArtifactRef,
      attemptCount: eventDeliveries.attemptCount,
      createdAt: eventDeliveries.createdAt,
    })
    .from(eventDeliveries)
    .innerJoin(eventRecords, eq(eventRecords.id, eventDeliveries.eventId))
    .where(eq(eventDeliveries.id, deliveryId))
    .get()
  if (row === undefined) return null
  const document = eventDocument(row.summaryJson)
  return {
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
    occurredAt: row.occurredAt,
    summary: document.summary,
    payloadArtifactRef: row.payloadArtifactRef,
    routingFacts: document.routingFacts,
    triggerContext: document.triggerContext,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
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
    async registerSource(descriptor, digest, now) {
      const existing = db
        .select({ digest: eventSources.descriptorDigest })
        .from(eventSources)
        .where(sourceWhere(descriptor.sourceRef))
        .get()
      if (existing !== undefined) {
        if (existing.digest !== digest) {
          throw new Error(
            `immutable event source revision conflict: ${descriptor.sourceRef.id}@${descriptor.sourceRef.revision}`,
          )
        }
        return
      }
      db.insert(eventSources)
        .values({
          sourceId: descriptor.sourceRef.id,
          revision: descriptor.sourceRef.revision,
          descriptorJson: JSON.stringify(descriptor),
          descriptorDigest: digest,
          state: 'published',
          registeredAt: now,
        })
        .run()
    },

    async registerEventType(descriptor, digest, now) {
      const existing = db
        .select({
          descriptorJson: eventTypeCatalog.descriptorJson,
          digest: eventTypeCatalog.descriptorDigest,
        })
        .from(eventTypeCatalog)
        .where(typeWhere(descriptor.eventTypeRef))
        .get()
      if (existing !== undefined) {
        const existingDescriptor = eventTypeDescriptorSchema.parse(
          JSON.parse(existing.descriptorJson) as unknown,
        )
        if (eventTypeContentDigest(existingDescriptor) !== digest) {
          throw new Error(
            `immutable event type revision conflict: ${descriptor.eventTypeRef.id}@${descriptor.eventTypeRef.revision}`,
          )
        }
        db.update(eventTypeCatalog)
          .set({
            descriptorJson: JSON.stringify(descriptor),
            descriptorDigest: digest,
            catalogVisibility: descriptor.catalogVisibility ?? 'public',
          })
          .where(typeWhere(descriptor.eventTypeRef))
          .run()
        return
      }
      db.insert(eventTypeCatalog)
        .values({
          eventTypeId: descriptor.eventTypeRef.id,
          revision: descriptor.eventTypeRef.revision,
          sourceId: descriptor.sourceRef.id,
          sourceRevision: descriptor.sourceRef.revision,
          descriptorJson: JSON.stringify(descriptor),
          descriptorDigest: digest,
          catalogVisibility: descriptor.catalogVisibility ?? 'public',
          state: 'published',
          registeredAt: now,
        })
        .run()
    },

    async getSource(ref) {
      const row = db.select().from(eventSources).where(sourceWhere(ref)).get()
      return row === undefined
        ? null
        : eventSourceDescriptorSchema.parse(JSON.parse(row.descriptorJson) as unknown)
    },

    async getEventType(ref) {
      const row = db.select().from(eventTypeCatalog).where(typeWhere(ref)).get()
      if (row === undefined) return null
      const descriptor = eventTypeDescriptorSchema.parse(JSON.parse(row.descriptorJson) as unknown)
      return eventTypeDescriptorSchema.parse({
        ...descriptor,
        ...(row.catalogVisibility === 'public'
          ? { catalogVisibility: undefined }
          : { catalogVisibility: row.catalogVisibility }),
      })
    },

    async listSources() {
      return db
        .select()
        .from(eventSources)
        .where(eq(eventSources.state, 'published'))
        .orderBy(asc(eventSources.sourceId), desc(eventSources.revision))
        .all()
        .map((row) => eventSourceDescriptorSchema.parse(JSON.parse(row.descriptorJson) as unknown))
    },

    async listEventTypes() {
      return db
        .select()
        .from(eventTypeCatalog)
        .where(eq(eventTypeCatalog.state, 'published'))
        .orderBy(asc(eventTypeCatalog.eventTypeId), desc(eventTypeCatalog.revision))
        .all()
        .map((row) => {
          const descriptor = eventTypeDescriptorSchema.parse(
            JSON.parse(row.descriptorJson) as unknown,
          )
          return eventTypeDescriptorSchema.parse({
            ...descriptor,
            ...(row.catalogVisibility === 'public'
              ? { catalogVisibility: undefined }
              : { catalogVisibility: row.catalogVisibility }),
          })
        })
    },

    async subscribe(input) {
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

      return dbTxSync(db, (tx) => {
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
            mode: 'exact',
            activeIdentityKey: input.identityKey,
            state: 'active',
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()

        const latestEvent = input.replayLatest
          ? tx
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
          : undefined
        if (latestEvent !== undefined) {
          tx.insert(eventDeliveries)
            .values({
              id: `${input.id}:replay`,
              eventId: latestEvent.id,
              subscriptionId: input.id,
              subscriberKind: input.subscriber.kind,
              subscriberRef: input.subscriber.subscriberRef,
              deliveryClass: input.eventType.deliveryClass,
              state: 'pending',
              attemptCount: 0,
              nextAttemptAt: input.now,
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
            mode: 'exact',
            originKind: null,
            originRef: null,
            definitionRevision: null,
            displayNameJson: null,
            selectorKind: null,
            selectorJson: null,
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

    async cancelSubscription(id, now) {
      const current = db
        .select()
        .from(eventSubscriptions)
        .where(
          and(
            eq(eventSubscriptions.id, id),
            eq(eventSubscriptions.mode, 'exact'),
            eq(eventSubscriptions.state, 'active'),
          ),
        )
        .get()
      if (current === undefined) return null

      return dbTxSync(db, (tx) => {
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

    async nudgeObserver(sourceRef, now) {
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

    async listSubscriptions(subscriberRef) {
      const subscriberCondition =
        subscriberRef === undefined
          ? sql`1 = 1`
          : eq(eventSubscriptions.subscriberRef, subscriberRef)
      return db
        .select()
        .from(eventSubscriptions)
        .where(and(eq(eventSubscriptions.mode, 'exact'), subscriberCondition))
        .orderBy(desc(eventSubscriptions.createdAt))
        .all()
        .map(subscriptionRecord)
    },

    async listSubscriptionPage(input) {
      const where = and(
        eq(eventSubscriptions.mode, 'exact'),
        ...(input.subscriberRef === undefined
          ? []
          : [eq(eventSubscriptions.subscriberRef, input.subscriberRef)]),
      )
      const total = db
        .select({ count: sql<number>`count(*)` })
        .from(eventSubscriptions)
        .where(where)
        .get()!.count
      const items = db
        .select()
        .from(eventSubscriptions)
        .where(where)
        .orderBy(desc(eventSubscriptions.updatedAt), desc(eventSubscriptions.id))
        .limit(Math.max(1, Math.min(100_000, input.limit)))
        .offset(Math.max(0, input.offset))
        .all()
        .map(subscriptionRecord)
      return { items, total }
    },

    async activeSubscriptionCountsBySource() {
      return new Map(
        db
          .select({
            sourceId: eventSubscriptions.sourceId,
            sourceRevision: eventSubscriptions.sourceRevision,
            count: sql<number>`count(*)`,
          })
          .from(eventSubscriptions)
          .where(and(eq(eventSubscriptions.mode, 'exact'), eq(eventSubscriptions.state, 'active')))
          .groupBy(eventSubscriptions.sourceId, eventSubscriptions.sourceRevision)
          .all()
          .map((row) => [`${row.sourceId}@${row.sourceRevision}`, row.count] as const),
      )
    },

    async recordObservation(input) {
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
        const deliveries = db
          .select({ id: eventDeliveries.id })
          .from(eventDeliveries)
          .where(eq(eventDeliveries.eventId, existing.id))
          .all()
        return {
          eventId: existing.id,
          duplicate: true,
          deliveryCount: deliveries.length,
          deliveryIds: deliveries.map((delivery) => delivery.id),
        }
      }

      return dbTxSync(db, (tx): ObservationStoreReceipt => {
        const inserted = tx
          .insert(eventRecords)
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
            summaryJson: JSON.stringify({
              summary: input.observation.summary,
              routingFacts: input.observation.routingFacts,
              triggerContext: input.triggerContext,
            }),
            payloadArtifactRef: input.observation.payloadArtifactRef,
          })
          .onConflictDoNothing()
          .returning({ id: eventRecords.id })
          .get()
        if (inserted === undefined) {
          const duplicate = tx
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
          if (duplicate === undefined) {
            throw new Error('event observation conflict did not expose the existing event')
          }
          const deliveries = tx
            .select({ id: eventDeliveries.id })
            .from(eventDeliveries)
            .where(eq(eventDeliveries.eventId, duplicate.id))
            .all()
          return {
            eventId: duplicate.id,
            duplicate: true,
            deliveryCount: deliveries.length,
            deliveryIds: deliveries.map((delivery) => delivery.id),
          }
        }
        const exactSubscriptions = tx
          .select()
          .from(eventSubscriptions)
          .where(
            and(
              eq(eventSubscriptions.mode, 'exact'),
              eq(eventSubscriptions.eventTypeId, input.observation.eventTypeRef.id),
              eq(eventSubscriptions.eventTypeRevision, input.observation.eventTypeRef.revision),
              eq(eventSubscriptions.subjectType, input.observation.subject.typeId),
              eq(eventSubscriptions.subjectRef, input.observation.subject.subjectRef),
              eq(eventSubscriptions.state, 'active'),
            ),
          )
          .all()
        const filteredSubscriptions: Array<typeof eventSubscriptions.$inferSelect> = []
        for (const match of input.routingSubscriptions) {
          const definition = match.definition
          tx.insert(eventSubscriptions)
            .values({
              id: match.materializedSubscriptionId,
              eventTypeId: match.eventTypeRef.id,
              eventTypeRevision: match.eventTypeRef.revision,
              sourceId: definition.sourceRef.id,
              sourceRevision: definition.sourceRef.revision,
              subjectType: input.observation.subject.typeId,
              subjectRef: input.observation.subject.subjectRef,
              subscriberKind: definition.subscriber.kind,
              subscriberRef: definition.subscriber.subscriberRef,
              mode: 'filtered',
              originKind: 'routing-rule',
              originRef: definition.id,
              definitionRevision: definition.definitionRevision,
              displayNameJson: JSON.stringify(definition.displayName),
              selectorKind: definition.selector.kind,
              selectorJson: JSON.stringify(definition.selector.config),
              activeIdentityKey: null,
              state: 'active',
              createdAt: definition.createdAt,
              updatedAt: definition.updatedAt,
              cancelledAt: null,
            })
            .onConflictDoNothing()
            .run()
          const row = tx
            .select()
            .from(eventSubscriptions)
            .where(eq(eventSubscriptions.id, match.materializedSubscriptionId))
            .get()
          if (row !== undefined) filteredSubscriptions.push(row)
        }
        const subscriptions = [...exactSubscriptions, ...filteredSubscriptions]
        const deliveryIds: string[] = []
        for (const subscription of subscriptions) {
          const deliveryId = input.nextId()
          tx.insert(eventDeliveries)
            .values({
              id: deliveryId,
              eventId: input.eventId,
              subscriptionId: subscription.id,
              subscriberKind: subscription.subscriberKind,
              subscriberRef: subscription.subscriberRef,
              deliveryClass: input.eventType.deliveryClass,
              state: 'pending',
              attemptCount: 0,
              nextAttemptAt: input.observedAt,
              createdAt: input.observedAt,
            })
            .run()
          deliveryIds.push(deliveryId)
        }
        return {
          eventId: input.eventId,
          duplicate: false,
          deliveryCount: subscriptions.length,
          deliveryIds,
        }
      })
    },

    async listPendingDeliveries(subscriber, limit) {
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
          occurredAt: eventRecords.occurredAt,
          summaryJson: eventRecords.summaryJson,
          payloadArtifactRef: eventRecords.payloadArtifactRef,
          attemptCount: eventDeliveries.attemptCount,
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
        .orderBy(asc(eventRecords.occurredAt), asc(eventRecords.id))
        .limit(Math.max(1, Math.min(1_000, limit)))
        .all()
        .map((row): EventDeliveryRecord => {
          const document = eventDocument(row.summaryJson)
          return {
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
            occurredAt: row.occurredAt,
            summary: document.summary,
            payloadArtifactRef: row.payloadArtifactRef,
            routingFacts: document.routingFacts,
            triggerContext: document.triggerContext,
            attemptCount: row.attemptCount,
            createdAt: row.createdAt,
          }
        })
    },

    async listDeliveryStatusPage(input) {
      const where = and(
        ...(input.state === undefined ? [] : [eq(eventDeliveries.state, input.state)]),
        ...(input.subscriberRef === undefined
          ? []
          : [eq(eventDeliveries.subscriberRef, input.subscriberRef)]),
      )
      const total = db
        .select({ count: sql<number>`count(*)` })
        .from(eventDeliveries)
        .where(where)
        .get()!.count
      const items = db
        .select({
          deliveryId: eventDeliveries.id,
          eventId: eventDeliveries.eventId,
          subscriptionId: eventDeliveries.subscriptionId,
          subscriberKind: eventDeliveries.subscriberKind,
          subscriberRef: eventDeliveries.subscriberRef,
          eventTypeId: eventRecords.eventTypeId,
          eventTypeRevision: eventRecords.eventTypeRevision,
          subjectType: eventRecords.subjectType,
          subjectRef: eventRecords.subjectRef,
          state: eventDeliveries.state,
          attemptCount: eventDeliveries.attemptCount,
          nextAttemptAt: eventDeliveries.nextAttemptAt,
          claimedBy: eventDeliveries.claimedBy,
          claimExpiresAt: eventDeliveries.claimExpiresAt,
          lastError: eventDeliveries.lastError,
          createdAt: eventDeliveries.createdAt,
          acceptedAt: eventDeliveries.acceptedAt,
          deadLetterAt: eventDeliveries.deadLetterAt,
        })
        .from(eventDeliveries)
        .innerJoin(eventRecords, eq(eventRecords.id, eventDeliveries.eventId))
        .where(where)
        .orderBy(desc(eventDeliveries.createdAt), desc(eventDeliveries.id))
        .limit(Math.max(1, Math.min(200, input.limit)))
        .offset(Math.max(0, input.offset))
        .all()
        .map(
          (row): EventDeliveryStatusRecord => ({
            deliveryId: row.deliveryId,
            eventId: row.eventId,
            subscriptionId: row.subscriptionId,
            subscriber: {
              kind: row.subscriberKind as EventSubscriber['kind'],
              subscriberRef: row.subscriberRef,
            },
            eventTypeRef: { id: row.eventTypeId, revision: row.eventTypeRevision },
            subject: { typeId: row.subjectType, subjectRef: row.subjectRef },
            state: row.state,
            attemptCount: row.attemptCount,
            nextAttemptAt: row.nextAttemptAt,
            claimedBy: row.claimedBy,
            claimExpiresAt: row.claimExpiresAt,
            lastError: row.lastError,
            createdAt: row.createdAt,
            acceptedAt: row.acceptedAt,
            deadLetterAt: row.deadLetterAt,
          }),
        )
      return { items, total }
    },

    async listEventRecordPage(input) {
      const where = and(
        eq(eventTypeCatalog.catalogVisibility, 'public'),
        ...(input.sourceId === undefined ? [] : [eq(eventRecords.sourceId, input.sourceId)]),
      )
      const total = db
        .select({ count: sql<number>`count(*)` })
        .from(eventRecords)
        .innerJoin(
          eventTypeCatalog,
          and(
            eq(eventTypeCatalog.eventTypeId, eventRecords.eventTypeId),
            eq(eventTypeCatalog.revision, eventRecords.eventTypeRevision),
          ),
        )
        .where(where)
        .get()!.count
      const items = db
        .select({
          eventId: eventRecords.id,
          eventTypeId: eventRecords.eventTypeId,
          eventTypeRevision: eventRecords.eventTypeRevision,
          sourceId: eventRecords.sourceId,
          sourceRevision: eventRecords.sourceRevision,
          subjectType: eventRecords.subjectType,
          subjectRef: eventRecords.subjectRef,
          occurredAt: eventRecords.occurredAt,
          observedAt: eventRecords.observedAt,
          summaryJson: eventRecords.summaryJson,
          payloadArtifactRef: eventRecords.payloadArtifactRef,
        })
        .from(eventRecords)
        .innerJoin(
          eventTypeCatalog,
          and(
            eq(eventTypeCatalog.eventTypeId, eventRecords.eventTypeId),
            eq(eventTypeCatalog.revision, eventRecords.eventTypeRevision),
          ),
        )
        .where(where)
        .orderBy(desc(eventRecords.observedAt), desc(eventRecords.id))
        .limit(Math.max(1, Math.min(200, input.limit)))
        .offset(Math.max(0, input.offset))
        .all()
        .map(
          (row): EventRecordAuditRecord => ({
            eventId: row.eventId,
            eventTypeRef: { id: row.eventTypeId, revision: row.eventTypeRevision },
            sourceRef: { id: row.sourceId, revision: row.sourceRevision },
            subject: { typeId: row.subjectType, subjectRef: row.subjectRef },
            occurredAt: row.occurredAt,
            observedAt: row.observedAt,
            summary: eventDocument(row.summaryJson).summary,
            payloadArtifactRef: row.payloadArtifactRef,
          }),
        )
      return { items, total }
    },

    async acceptDelivery(deliveryId, now) {
      const result = db
        .update(eventDeliveries)
        .set({
          state: 'accepted',
          acceptedAt: now,
          claimedBy: null,
          claimExpiresAt: null,
          lastError: null,
        })
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

    async claimNotificationDelivery(input) {
      if (input.subscriberKinds.length === 0) return null
      const due = or(
        and(eq(eventDeliveries.state, 'pending'), lte(eventDeliveries.nextAttemptAt, input.now)),
        and(
          eq(eventDeliveries.state, 'claimed'),
          or(
            isNull(eventDeliveries.claimExpiresAt),
            lte(eventDeliveries.claimExpiresAt, input.now),
          ),
        ),
      )
      const candidates = db
        .select({ id: eventDeliveries.id })
        .from(eventDeliveries)
        .where(
          and(
            inArray(eventDeliveries.subscriberKind, input.subscriberKinds),
            due,
            ...(input.deliveryId === undefined ? [] : [eq(eventDeliveries.id, input.deliveryId)]),
          ),
        )
        .orderBy(asc(eventDeliveries.nextAttemptAt), asc(eventDeliveries.createdAt))
        .limit(input.deliveryId === undefined ? 20 : 1)
        .all()
      for (const candidate of candidates) {
        const claimed = changes(
          db
            .update(eventDeliveries)
            .set({
              state: 'claimed',
              attemptCount: sql`${eventDeliveries.attemptCount} + 1`,
              claimedBy: input.leaseOwner,
              claimExpiresAt: input.now + input.leaseMs,
              lastError: null,
            })
            .where(and(eq(eventDeliveries.id, candidate.id), due))
            .run(),
        )
        if (claimed === 1) return loadDeliveryRecord(db, candidate.id)
      }
      return null
    },

    async settleNotificationDelivery(input) {
      const terminal = input.state !== 'pending'
      const result = db
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
            eq(eventDeliveries.id, input.deliveryId),
            eq(eventDeliveries.state, 'claimed'),
            eq(eventDeliveries.claimedBy, input.leaseOwner),
            eq(eventDeliveries.attemptCount, input.attemptCount),
          ),
        )
        .run()
      return changes(result) === 1
    },

    async listObserverActivations() {
      return db
        .select()
        .from(observerActivations)
        .orderBy(asc(observerActivations.sourceId), desc(observerActivations.sourceRevision))
        .all()
        .map(activationRecord)
    },

    async claimDueObserver(input) {
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
              eq(eventSubscriptions.mode, 'exact'),
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

    async settleObserver(input) {
      return dbTxSync(db, (tx) => {
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
          const inserted = tx
            .insert(eventRecords)
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
              summaryJson: JSON.stringify({
                summary: item.observation.summary,
                routingFacts: item.observation.routingFacts,
                triggerContext: item.triggerContext,
              }),
              payloadArtifactRef: item.observation.payloadArtifactRef,
            })
            .onConflictDoNothing()
            .returning({ id: eventRecords.id })
            .get()
          if (inserted === undefined) continue
          const exactSubscriptions = tx
            .select()
            .from(eventSubscriptions)
            .where(
              and(
                eq(eventSubscriptions.mode, 'exact'),
                eq(eventSubscriptions.eventTypeId, item.observation.eventTypeRef.id),
                eq(eventSubscriptions.eventTypeRevision, item.observation.eventTypeRef.revision),
                eq(eventSubscriptions.subjectType, item.observation.subject.typeId),
                eq(eventSubscriptions.subjectRef, item.observation.subject.subjectRef),
                eq(eventSubscriptions.state, 'active'),
              ),
            )
            .all()
          const filteredSubscriptions: Array<typeof eventSubscriptions.$inferSelect> = []
          for (const match of item.routingSubscriptions) {
            const definition = match.definition
            tx.insert(eventSubscriptions)
              .values({
                id: match.materializedSubscriptionId,
                eventTypeId: match.eventTypeRef.id,
                eventTypeRevision: match.eventTypeRef.revision,
                sourceId: definition.sourceRef.id,
                sourceRevision: definition.sourceRef.revision,
                subjectType: item.observation.subject.typeId,
                subjectRef: item.observation.subject.subjectRef,
                subscriberKind: definition.subscriber.kind,
                subscriberRef: definition.subscriber.subscriberRef,
                mode: 'filtered',
                originKind: 'routing-rule',
                originRef: definition.id,
                definitionRevision: definition.definitionRevision,
                displayNameJson: JSON.stringify(definition.displayName),
                selectorKind: definition.selector.kind,
                selectorJson: JSON.stringify(definition.selector.config),
                activeIdentityKey: null,
                state: 'active',
                createdAt: definition.createdAt,
                updatedAt: definition.updatedAt,
                cancelledAt: null,
              })
              .onConflictDoNothing()
              .run()
            const row = tx
              .select()
              .from(eventSubscriptions)
              .where(eq(eventSubscriptions.id, match.materializedSubscriptionId))
              .get()
            if (row !== undefined) filteredSubscriptions.push(row)
          }
          const subscriptions = [...exactSubscriptions, ...filteredSubscriptions]
          for (const subscription of subscriptions) {
            tx.insert(eventDeliveries)
              .values({
                id: input.nextId(),
                eventId: item.eventId,
                subscriptionId: subscription.id,
                subscriberKind: subscription.subscriberKind,
                subscriberRef: subscription.subscriberRef,
                deliveryClass: item.eventType.deliveryClass,
                state: 'pending',
                attemptCount: 0,
                nextAttemptAt: input.now,
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
