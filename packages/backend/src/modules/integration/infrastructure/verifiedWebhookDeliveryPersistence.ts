// RFC-303 verified-ingress persistence：delivery dedupe、MR stream linearization、guard revocation 与 effect
// creation 在同一个事务里提交。RFC-359 W4-D2：一份实现，两个 provider 共用——事务走统一原语，MR 流的序列化锁经
// 引擎能力矩阵 `advisoryLock` 表达（PG：pg_advisory_xact_lock；SQLite：独占事务下无需第二把锁），
// 与启动预留（mrTerminalControlPersistence）共用同一把 `${endpointId}:${streamKey}` 键。
import { and, eq, inArray, isNull, lt, notInArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  webhookDeliveries,
  webhookMrControlEffects,
  webhookMrLaunchGuards,
  webhookMrStreamStates,
} from '@/db/schema'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
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

export function createVerifiedWebhookDeliveryPersistence(
  db: ProviderNeutralDatabase,
): VerifiedWebhookDeliveryPersistencePort {
  return {
    async accept(input): Promise<AcceptedVerifiedDelivery> {
      return await databaseSessionFor(db).transaction(async (tx) => {
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
          const duplicate = (
            await tx
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
              .limit(1)
          )[0]
          if (duplicate !== undefined) {
            const attemptCount = duplicate.attemptCount + 1
            await tx
              .update(webhookDeliveries)
              .set({ attemptCount })
              .where(eq(webhookDeliveries.id, duplicate.id))
            const effect = (
              await tx
                .select({ id: webhookMrControlEffects.id, status: webhookMrControlEffects.status })
                .from(webhookMrControlEffects)
                .where(eq(webhookMrControlEffects.deliveryId, duplicate.id))
                .limit(1)
            )[0]
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

        // Terminal replay never creates a new close/merge linearization point:
        // it references and wakes the original root effect. Nonterminal replay
        // continues through the ordinary new-revision path.
        const isTerminal =
          input.event.eventType === 'mr_closed' || input.event.eventType === 'mr_merged'
        if (isReplay && isTerminal && input.replay?.terminalRootRevision !== null) {
          streamRevision = input.replay!.terminalRootRevision
          const rootDelivery = (
            await tx
              .select({ stateAfter: webhookDeliveries.mrStateAfter })
              .from(webhookDeliveries)
              .where(eq(webhookDeliveries.id, input.replay!.rootDeliveryId))
              .limit(1)
          )[0]
          stateAfter = rootDelivery?.stateAfter ?? null
          const rootEffect = (
            await tx
              .select({ id: webhookMrControlEffects.id, status: webhookMrControlEffects.status })
              .from(webhookMrControlEffects)
              .where(eq(webhookMrControlEffects.deliveryId, input.replay!.rootDeliveryId))
              .limit(1)
          )[0]
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
          await engineOf(tx).advisoryLock(tx, `${input.endpointId}:${identity.streamKey}`)
          const currentRow = (
            await tx
              .select()
              .from(webhookMrStreamStates)
              .where(
                and(
                  eq(webhookMrStreamStates.endpointId, input.endpointId),
                  eq(webhookMrStreamStates.streamKey, identity.streamKey),
                ),
              )
              .limit(1)
          )[0]
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

            // The durable revoke is part of the same verified-ingress fact as the
            // stream transition/effect. Commit happens before any process signal;
            // a crash therefore leaves the worker enough state to finish safely.
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
