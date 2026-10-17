// RFC-370 H8 / v3 V8 — the Drizzle inbox behind hosted event ingress:
// transport receipts (`cs_event_inbox`), frozen logical routes
// (`cs_event_routes`) and one target per routed endpoint (`cs_event_targets`).
// Receipts outlive endpoints and business failures. Durable intake needs no
// execution lease; admission, publication receipts and retries run under the
// execution fence, so an instance that lost authority leaves them untouched.
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  csEventInbox,
  csEventRoutes,
  csEventTargets,
  webhookDeliveries,
  webhookEndpoints,
} from '@/db/schema'
import type {
  EventObservationInput,
  EventObservationReceipt,
} from '@/modules/event-center/public/types'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import type { NormalizeResult } from '../../domain/codeHostNormalization'
import type {
  CrewStationAdmittedTarget,
  CrewStationEventInboxPort,
  CrewStationRecordOutcome,
} from '../../application/ports/crewStationEventInbox'
import { acceptVerifiedWebhookDeliveryInTransaction } from '../verifiedWebhookDeliveryPersistence'
import {
  CREWSTATION_CODE_HOST_EVENTS,
  CREWSTATION_TARGET_RECEIPT_PREFIX,
  CrewStationEventError,
  canonicalDigest,
  normalizeCrewStationEvent,
  type CrewStationEventDelivery,
  type CrewStationEventSource,
} from './eventContract'

const DUE_STAGES = ['pending', 'admitted'] as const
const RETRY_DELAY_MS = 5_000

/** A frozen envelope the current catalog can no longer read is a terminal rejection, not a retry loop. */
function normalizeFrozen(
  envelope: CrewStationEventDelivery,
  source: CrewStationEventSource,
  eventUuid: string,
): NormalizeResult {
  try {
    return normalizeCrewStationEvent(envelope, source, eventUuid)
  } catch (error) {
    if (!(error instanceof CrewStationEventError)) throw error
    return { ok: false, reason: 'parse-failed', detail: error.code }
  }
}

export function createCrewStationEventInbox(input: {
  readonly db: ProviderNeutralDatabase
  readonly installationId: string
  readonly fence: CrewStationMutationFence
  readonly now?: () => number
}): CrewStationEventInboxPort {
  const { db, installationId, fence } = input
  const now = input.now ?? Date.now
  const session = databaseSessionFor(db)
  const fenced = <T>(body: (tx: ProviderNeutralDatabase) => Promise<T>): Promise<T> => {
    const token = fence.current()
    return session.transaction(async (tx) => {
      await fence.assertHeld(tx, token)
      return await body(tx)
    })
  }
  const inboxKey = (deliveryId: string) =>
    and(eq(csEventInbox.installationId, installationId), eq(csEventInbox.deliveryId, deliveryId))
  const targetKey = (id: string) => eq(csEventTargets.id, id)
  const lockTarget = (tx: ProviderNeutralDatabase, id: string) =>
    engineOf(tx).advisoryLock(tx, `cs-target:${id}`)
  const readTarget = async (tx: ProviderNeutralDatabase, id: string) =>
    (await tx.select().from(csEventTargets).where(targetKey(id)).limit(1))[0]

  return Object.freeze({
    async record(delivery): Promise<CrewStationRecordOutcome> {
      return await session.transaction(async (tx): Promise<CrewStationRecordOutcome> => {
        await engineOf(tx).advisoryLock(tx, `cs-delivery:${installationId}:${delivery.deliveryId}`)
        const prior = (
          await tx.select().from(csEventInbox).where(inboxKey(delivery.deliveryId)).limit(1)
        )[0]
        if (prior) {
          if (prior.payloadDigest !== delivery.factDigest) {
            await tx
              .update(csEventInbox)
              .set({ conflicts: sql`${csEventInbox.conflicts} + 1` })
              .where(inboxKey(delivery.deliveryId))
            return { kind: 'conflict' }
          }
          await tx
            .update(csEventInbox)
            .set({ lastAttempt: Math.max(prior.lastAttempt, delivery.attempt) })
            .where(inboxKey(delivery.deliveryId))
          return { kind: 'recorded' }
        }
        await engineOf(tx).advisoryLock(
          tx,
          `cs-event:${installationId}:${delivery.producerId}:${delivery.eventId}`,
        )
        const eventKey = and(
          eq(csEventRoutes.installationId, installationId),
          eq(csEventRoutes.producerId, delivery.producerId),
          eq(csEventRoutes.eventId, delivery.eventId),
        )
        const route = (
          await tx
            .select({ id: csEventRoutes.id, payloadDigest: csEventRoutes.payloadDigest })
            .from(csEventRoutes)
            .where(eventKey)
            .limit(1)
        )[0]
        if (route && route.payloadDigest !== delivery.factDigest) {
          await tx
            .update(csEventRoutes)
            .set({ conflicts: sql`${csEventRoutes.conflicts} + 1` })
            .where(eventKey)
          return { kind: 'conflict' }
        }
        let routeId = route?.id
        if (routeId === undefined) {
          // First sighting: freeze where the configuration routes it now.
          const plan = delivery.route()
          if (plan.kind === 'unroutable') return plan
          const timestamp = now()
          routeId = ulid()
          await tx.insert(csEventRoutes).values({
            id: routeId,
            installationId,
            producerId: delivery.producerId,
            eventId: delivery.eventId,
            payloadDigest: delivery.factDigest,
            envelopeJson: delivery.envelopeJson,
            sourceJson: plan.frozenSource,
            sourceRevision: plan.sourceRevision,
            result: plan.targets.length > 0 ? 'routed' : 'ignored',
            createdAt: timestamp,
            conflicts: 0,
          })
          for (const target of plan.targets) {
            await tx.insert(csEventTargets).values({
              id: ulid(),
              logicalId: routeId,
              endpointId: target.endpointId,
              bindingRevision: target.bindingRevision,
              mode: target.channel,
              stage: 'pending',
              nextAttemptAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
          }
        }
        await tx.insert(csEventInbox).values({
          installationId,
          deliveryId: delivery.deliveryId,
          logicalId: routeId,
          eventId: delivery.eventId,
          producerId: delivery.producerId,
          eventTypeId: delivery.eventTypeId,
          payloadDigest: delivery.factDigest,
          payloadJson: delivery.envelopeJson,
          receivedAt: now(),
          lastAttempt: delivery.attempt,
        })
        return { kind: 'recorded' }
      })
    },

    async due(limit) {
      const rows = await db
        .select({ id: csEventTargets.id })
        .from(csEventTargets)
        .innerJoin(csEventRoutes, eq(csEventRoutes.id, csEventTargets.logicalId))
        .where(
          and(
            eq(csEventRoutes.installationId, installationId),
            inArray(csEventTargets.stage, DUE_STAGES),
            lte(csEventTargets.nextAttemptAt, now()),
          ),
        )
        .orderBy(asc(csEventTargets.createdAt), asc(csEventTargets.id))
        .limit(limit)
      return rows.map((row) => row.id)
    },

    async admit(targetId, decide) {
      return await fenced(async (tx): Promise<CrewStationAdmittedTarget | null> => {
        await lockTarget(tx, targetId)
        const target = await readTarget(tx, targetId)
        if (!target || !(DUE_STAGES as readonly string[]).includes(target.stage)) return null
        if (target.stage === 'admitted') {
          return {
            effectId: target.effectId,
            observations: JSON.parse(target.observationsJson ?? '[]') as EventObservationInput[],
            published: Object.keys(JSON.parse(target.publishedJson) as Record<string, unknown>).map(
              Number,
            ),
          }
        }
        const route = (
          await tx
            .select()
            .from(csEventRoutes)
            .where(eq(csEventRoutes.id, target.logicalId))
            .limit(1)
        )[0]
        if (!route || route.installationId !== installationId)
          throw new Error('CS target route missing')
        const endpoint = (
          await tx
            .select({ enabled: webhookEndpoints.enabled, provider: webhookEndpoints.provider })
            .from(webhookEndpoints)
            .where(eq(webhookEndpoints.id, target.endpointId))
            .limit(1)
        )[0]
        const source = JSON.parse(route.sourceJson) as CrewStationEventSource
        const envelope = JSON.parse(route.envelopeJson) as CrewStationEventDelivery
        const eventUuid = `cs:${canonicalDigest([installationId, source.producerId, envelope.eventId])}`
        const header = CREWSTATION_CODE_HOST_EVENTS[envelope.eventType]?.header ?? null
        const rawBodyText = JSON.stringify(envelope.payload)
        const decision = decide({
          endpointId: target.endpointId,
          channel: target.mode,
          endpoint: endpoint ?? null,
          provider: source.producer,
          normalized: normalizeFrozen(envelope, source, eventUuid),
          delivery: {
            rawBodyText,
            rawBodyBytes: Buffer.from(rawBodyText),
            eventHeader: header,
            objectKind:
              source.producer === 'gitlab' ? String(envelope.payload.object_kind) : header,
            transportReceiptRef: `${CREWSTATION_TARGET_RECEIPT_PREFIX}${targetId}`,
          },
          occurredAt: Date.parse(envelope.occurredAt),
        })
        if (decision.kind === 'close') {
          await tx
            .update(csEventTargets)
            .set({ stage: decision.stage, lastError: decision.reason, updatedAt: now() })
            .where(targetKey(targetId))
          return null
        }
        const accepted = await acceptVerifiedWebhookDeliveryInTransaction(tx, decision.delivery)
        const observations = decision.observations(accepted.deliveryId)
        await tx
          .update(csEventTargets)
          .set({
            stage: 'admitted',
            deliveryId: accepted.deliveryId,
            effectId: accepted.effectId,
            observationsJson: JSON.stringify(observations),
            lastError: null,
            updatedAt: now(),
          })
          .where(targetKey(targetId))
        return { effectId: accepted.effectId, observations, published: [] }
      })
    },

    async recordPublication({ targetId, index, receipt, finalize }) {
      await fenced(async (tx) => {
        await lockTarget(tx, targetId)
        const row = await readTarget(tx, targetId)
        if (!row || row.stage !== 'admitted') return
        const receipts = JSON.parse(row.publishedJson) as Record<string, EventObservationReceipt>
        receipts[String(index)] = receipt
        const observations = JSON.parse(row.observationsJson ?? '[]') as unknown[]
        const ordered = observations.map((_, at) => receipts[String(at)])
        const complete = ordered.every((entry) => entry !== undefined)
        await tx
          .update(csEventTargets)
          .set({
            publishedJson: JSON.stringify(receipts),
            stage: complete ? 'completed' : 'admitted',
            lastError: null,
            updatedAt: now(),
          })
          .where(targetKey(targetId))
        if (!complete || row.deliveryId === null) return
        const outcome = finalize(ordered as EventObservationReceipt[], row.effectId)
        await tx
          .update(webhookDeliveries)
          .set({ status: outcome.status, statusReason: outcome.reason ?? null })
          .where(eq(webhookDeliveries.id, row.deliveryId))
        await tx
          .update(webhookEndpoints)
          .set({ lastDeliveryAt: now() })
          .where(eq(webhookEndpoints.id, row.endpointId))
      })
    },

    async defer(targetId, error) {
      await fenced(async (tx) => {
        await tx
          .update(csEventTargets)
          .set({
            lastError: error,
            attempts: sql`${csEventTargets.attempts} + 1`,
            nextAttemptAt: now() + RETRY_DELAY_MS,
            updatedAt: now(),
          })
          .where(and(targetKey(targetId), inArray(csEventTargets.stage, DUE_STAGES)))
      })
    },
  } satisfies CrewStationEventInboxPort)
}
