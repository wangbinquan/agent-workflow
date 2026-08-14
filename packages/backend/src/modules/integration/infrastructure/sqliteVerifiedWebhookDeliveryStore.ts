// RFC-303 SQLite implementation of the verified-ingress application port.
// The delivery row, fact dedupe, MR revision/state, and control effect are one
// dbTxSync transaction; no abort/process side effect occurs inside it.
import { and, eq, isNull, notInArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import type {
  AcceptedVerifiedDelivery,
  VerifiedWebhookDeliveryInput,
  VerifiedWebhookDeliveryStore,
} from '@/modules/integration/application/acceptVerifiedWebhookDelivery'
import {
  linearizeMrEvent,
  isMrAssociatedEvent,
  mrFactKey,
  sourceTerminationBinding,
  stableMrIdentityOf,
  type MrStreamState,
} from '@/modules/integration/domain/mrTerminalControl'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { webhookDeliveries, webhookMrControlEffects, webhookMrStreamStates } from '@/db/schema'
import { truncateDeliveryBody } from '@/services/webhook/deliveryStore'

/** The exported class is instance-owned so tests/daemons never share ambient state. */
export class SqliteVerifiedWebhookDeliveryStore implements VerifiedWebhookDeliveryStore {
  constructor(private readonly db: DbClient) {}

  accept(input: VerifiedWebhookDeliveryInput): AcceptedVerifiedDelivery {
    return dbTxSync(this.db, (tx) => {
      const factKey = isMrAssociatedEvent(input.event)
        ? mrFactKey({
            provider: input.event.provider,
            eventUuid: input.event.eventUuid,
            normalizedEventType: input.event.eventType,
            rawBodyBytes: input.rawBodyBytes,
          })
        : null
      const identity = stableMrIdentityOf(input.event)
      const isReplay = input.replay !== undefined

      // Manual replay is an explicit new processing request. Original ingress
      // facts dedupe by UUID or exact-body fallback; replay rows are excluded.
      if (!isReplay && (factKey !== null || input.event.eventUuid !== null)) {
        const duplicate = tx
          .select({
            id: webhookDeliveries.id,
            attemptCount: webhookDeliveries.attemptCount,
          })
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.endpointId, input.endpointId),
              ...(factKey !== null
                ? [eq(webhookDeliveries.mrFactKey, factKey)]
                : [eq(webhookDeliveries.eventUuid, input.event.eventUuid!)]),
              isNull(webhookDeliveries.replayedFromDeliveryId),
              notInArray(webhookDeliveries.status, ['rejected', 'failed']),
            ),
          )
          .get()
        if (duplicate !== undefined) {
          const attemptCount = duplicate.attemptCount + 1
          tx.update(webhookDeliveries)
            .set({ attemptCount })
            .where(eq(webhookDeliveries.id, duplicate.id))
            .run()
          const effect = tx
            .select({ id: webhookMrControlEffects.id, status: webhookMrControlEffects.status })
            .from(webhookMrControlEffects)
            .where(eq(webhookMrControlEffects.deliveryId, duplicate.id))
            .get()
          if (effect !== undefined && effect.status !== 'succeeded') {
            tx.update(webhookMrControlEffects)
              .set({ nextAttemptAt: Date.now(), leaseOwner: null, leaseExpiresAt: null })
              .where(eq(webhookMrControlEffects.id, effect.id))
              .run()
          }
          return {
            kind: 'duplicate',
            deliveryId: duplicate.id,
            attemptCount,
            effectId: effect?.id ?? null,
          }
        }
      }

      const now = Date.now()
      const deliveryId = ulid()
      let streamRevision: number | null = null
      let stateAfter: 'open' | 'closed' | 'merged' | null = null
      let effectId: string | null = null

      // Terminal replay never creates a new close/merge linearization point:
      // it references and wakes the original root effect. Nonterminal replay
      // continues through the ordinary new-revision path.
      const isTerminal =
        input.event.eventType === 'mr_closed' || input.event.eventType === 'mr_merged'
      if (isReplay && isTerminal && input.replay?.terminalRootRevision !== null) {
        streamRevision = input.replay!.terminalRootRevision
        const rootDelivery = tx
          .select({ stateAfter: webhookDeliveries.mrStateAfter })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, input.replay!.rootDeliveryId))
          .get()
        stateAfter = rootDelivery?.stateAfter ?? null
        const rootEffect = tx
          .select({ id: webhookMrControlEffects.id, status: webhookMrControlEffects.status })
          .from(webhookMrControlEffects)
          .where(eq(webhookMrControlEffects.deliveryId, input.replay!.rootDeliveryId))
          .get()
        effectId = rootEffect?.id ?? null
        if (rootEffect !== undefined && rootEffect.status !== 'succeeded') {
          tx.update(webhookMrControlEffects)
            .set({ nextAttemptAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
            .where(eq(webhookMrControlEffects.id, rootEffect.id))
            .run()
        }
      } else if (identity !== null) {
        const currentRow = tx
          .select()
          .from(webhookMrStreamStates)
          .where(
            and(
              eq(webhookMrStreamStates.endpointId, input.endpointId),
              eq(webhookMrStreamStates.streamKey, identity.streamKey),
            ),
          )
          .get()
        const current: MrStreamState | null =
          currentRow === undefined
            ? null
            : {
                state: currentRow.state,
                revision: currentRow.revision,
                lastTerminalRevision: currentRow.lastTerminalRevision,
              }
        streamRevision = (current?.revision ?? 0) + 1
        const linearized = linearizeMrEvent(current, input.event.eventType, streamRevision)
        stateAfter = linearized.state.state
        tx.insert(webhookMrStreamStates)
          .values({
            endpointId: input.endpointId,
            streamKey: identity.streamKey,
            projectId: identity.projectId,
            mrIid: identity.mrIid,
            state: linearized.state.state,
            revision: linearized.state.revision,
            lastTerminalRevision: linearized.state.lastTerminalRevision,
            lastDeliveryId: deliveryId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [webhookMrStreamStates.endpointId, webhookMrStreamStates.streamKey],
            set: {
              state: linearized.state.state,
              revision: linearized.state.revision,
              lastTerminalRevision: linearized.state.lastTerminalRevision,
              lastDeliveryId: deliveryId,
              updatedAt: now,
            },
          })
          .run()

        if (linearized.effectKind !== null) {
          effectId = ulid()
          tx.insert(webhookMrControlEffects)
            .values({
              id: effectId,
              deliveryId,
              endpointId: input.endpointId,
              streamKey: identity.streamKey,
              binding: sourceTerminationBinding({
                endpointId: input.endpointId,
                projectId: identity.projectId,
                mrIid: identity.mrIid,
              }),
              revision: streamRevision,
              observedEventType: input.event.eventType as 'mr_opened' | 'mr_closed' | 'mr_merged',
              kind: linearized.effectKind,
              status: 'pending',
              nextAttemptAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .run()
        }
      }

      tx.insert(webhookDeliveries)
        .values({
          id: deliveryId,
          endpointId: input.endpointId,
          eventUuid: isReplay ? null : input.event.eventUuid,
          gitlabEventHeader: input.eventHeader,
          objectKind: input.objectKind,
          eventType: input.event.eventType,
          repoPath: input.event.repoPath,
          streamHint: identity?.streamKey ?? null,
          mrFactKey: factKey,
          mrStreamKey: identity?.streamKey ?? null,
          mrStreamRevision: streamRevision,
          mrStateAfter: stateAfter,
          status: 'received',
          statusReason: null,
          bodyJson: truncateDeliveryBody(input.rawBodyText),
          replayedFromDeliveryId: input.replay?.rootDeliveryId ?? null,
        })
        .run()

      return {
        kind: 'inserted',
        deliveryId,
        effectId,
        controlAccepted: effectId !== null,
        streamRevision,
      }
    })
  }
}
