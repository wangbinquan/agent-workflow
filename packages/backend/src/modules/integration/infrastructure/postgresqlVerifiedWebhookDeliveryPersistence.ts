// RFC-349 — PostgreSQL implementation of the verified-ingress Promise port.
// Delivery dedupe, MR stream linearization, guard revocation, and effect
// creation stay on the same reserved asynchronous transaction.
import { and, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { AcceptedVerifiedDelivery } from '../application/acceptVerifiedWebhookDelivery'
import type { VerifiedWebhookDeliveryPersistencePort } from '../application/ports/verifiedWebhookDeliveryPersistence'
import {
  isMrAssociatedEvent,
  linearizeMrEvent,
  mrFactKey,
  sourceTerminationBinding,
  stableMrIdentityOf,
  webhookStreamKeyOf,
  type MrStreamState,
} from '../domain/mrTerminalControl'
import { truncateDeliveryBody } from '../domain/webhookDelivery'
import {
  webhookDeliveries,
  webhookMrControlEffects,
  webhookMrLaunchGuards,
  webhookMrStreamStates,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export function createPostgresqlVerifiedWebhookDeliveryPersistence(
  db: PostgresqlDatabaseClient,
): VerifiedWebhookDeliveryPersistencePort {
  return {
    async accept(input): Promise<AcceptedVerifiedDelivery> {
      return await db.transaction(async (tx) => {
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

        if (!isReplay && (factKey !== null || input.event.eventUuid !== null)) {
          const duplicate = await tx
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
            await tx
              .update(webhookDeliveries)
              .set({ attemptCount })
              .where(eq(webhookDeliveries.id, duplicate.id))
            const effect = await tx
              .select({ id: webhookMrControlEffects.id, status: webhookMrControlEffects.status })
              .from(webhookMrControlEffects)
              .where(eq(webhookMrControlEffects.deliveryId, duplicate.id))
              .get()
            if (effect !== undefined && effect.status !== 'succeeded') {
              await tx
                .update(webhookMrControlEffects)
                .set({ nextAttemptAt: Date.now(), leaseOwner: null, leaseExpiresAt: null })
                .where(eq(webhookMrControlEffects.id, effect.id))
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
        const isTerminal =
          input.event.eventType === 'mr_closed' || input.event.eventType === 'mr_merged'

        if (isReplay && isTerminal && input.replay?.terminalRootRevision !== null) {
          streamRevision = input.replay!.terminalRootRevision
          const rootDelivery = await tx
            .select({ stateAfter: webhookDeliveries.mrStateAfter })
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.id, input.replay!.rootDeliveryId))
            .get()
          stateAfter = rootDelivery?.stateAfter ?? null
          const rootEffect = await tx
            .select({ id: webhookMrControlEffects.id, status: webhookMrControlEffects.status })
            .from(webhookMrControlEffects)
            .where(eq(webhookMrControlEffects.deliveryId, input.replay!.rootDeliveryId))
            .get()
          effectId = rootEffect?.id ?? null
          if (rootEffect !== undefined && rootEffect.status !== 'succeeded') {
            await tx
              .update(webhookMrControlEffects)
              .set({ nextAttemptAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
              .where(eq(webhookMrControlEffects.id, rootEffect.id))
          }
        } else if (identity !== null) {
          // Shared with launch reservation: serialize the stream even before
          // its first row exists, so a terminal transition cannot miss a
          // concurrently inserted launch guard.
          await tx.run(
            sql`select pg_advisory_xact_lock(hashtextextended(${`${input.endpointId}:${identity.streamKey}`}, 0))`,
          )
          const currentRow = await tx
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
          await tx
            .insert(webhookMrStreamStates)
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

          if (linearized.effectKind !== null) {
            effectId = ulid()
            await tx.insert(webhookMrControlEffects).values({
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

            if (
              linearized.effectKind === 'fence-closed' ||
              linearized.effectKind === 'fence-merged'
            ) {
              await tx
                .update(webhookMrLaunchGuards)
                .set({ status: 'revoking-terminal', updatedAt: now })
                .where(
                  and(
                    eq(webhookMrLaunchGuards.endpointId, input.endpointId),
                    eq(webhookMrLaunchGuards.streamKey, identity.streamKey),
                    lt(webhookMrLaunchGuards.launchRevision, streamRevision),
                    inArray(webhookMrLaunchGuards.status, ['reserved', 'launching']),
                  ),
                )
            }
          }
        }

        await tx.insert(webhookDeliveries).values({
          id: deliveryId,
          endpointId: input.endpointId,
          eventUuid: isReplay ? null : input.event.eventUuid,
          gitlabEventHeader: input.eventHeader,
          objectKind: input.objectKind,
          eventType: input.event.eventType,
          repoPath: input.event.repoPath,
          streamHint: webhookStreamKeyOf(input.event),
          mrFactKey: factKey,
          mrStreamKey: identity?.streamKey ?? null,
          mrStreamRevision: streamRevision,
          mrStateAfter: stateAfter,
          status: 'received',
          statusReason: null,
          bodyJson: truncateDeliveryBody(input.rawBodyText),
          replayedFromDeliveryId: input.replay?.rootDeliveryId ?? null,
        })

        return {
          kind: 'inserted',
          deliveryId,
          effectId,
          controlAccepted: effectId !== null,
          streamRevision,
        }
      })
    },
  }
}
