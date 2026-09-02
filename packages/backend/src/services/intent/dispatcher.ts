// RFC-293 — one dispatcher for HTTP-triggered turns and queued boot recovery.

import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import type { Actor } from '@/auth/actor'
import type {
  IntentDumpAuxiliaryQueries,
  IntentPersistence,
  IntentTurnRuntimeResolver,
} from '@/modules/intent/public/operations'
import { admitDurableWorkOwner, type DirectAuthorityAdmissionRuntime } from '@/auth/session'
import type { loadConfig } from '@/config'
import { createLogger } from '@/util/log'
import { INTENT_SESSIONS_CHANNEL, intentSessionsBroadcaster } from '@/ws/broadcaster'
import {
  resolveIntentTurnConfig,
  runIntentTurn,
  settleReservedIntentTurnStartFailure,
} from './turnEngine'
import type { ReservedIntentTurn } from './session'
import { activateIntentWorkingSetChange } from './workingSet'
import { intentResourceVisibility, type IntentResourceCatalogBinding } from './resourceCatalog'

const log = createLogger('intentDispatcher')

export interface IntentDispatchDeps {
  persistence: IntentPersistence
  /** Boot recovery re-admits each session's owner through this seam; see
   *  `admitDurableWorkOwner`. */
  identityAccess: DirectAuthorityAdmissionRuntime
  appHome: string
  configSnapshot: ReturnType<typeof loadConfig>
  runtimeResolver: IntentTurnRuntimeResolver
  dumpAuxiliary: IntentDumpAuxiliaryQueries
  /** Bootstrap-selected Resource Catalog query/context for this exact actor. */
  resourceCatalogFor(actor: Actor): IntentResourceCatalogBinding
  runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
}

function emitSessionUpdated(sessionId: string, ownerUserId: string): void {
  intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, {
    type: 'intent.session.updated',
    sessionId,
    ownerUserId,
  })
}

/** Launch a previously persisted reservation. Completion always checks for a
 * queued working-context successor, so response loss and browser closure do
 * not affect handoff. */
export async function dispatchIntentTurn(
  deps: IntentDispatchDeps,
  sessionId: string,
  actor: Actor,
  reservation: ReservedIntentTurn,
): Promise<void> {
  const EXECUTION_BROADCAST_THROTTLE_MS = 500
  let lastExecutionBroadcastAt = 0
  let pendingExecution: { sessionId: string; turnId: string; eventSeq: number } | undefined
  let executionTimer: ReturnType<typeof setTimeout> | undefined
  const flushExecution = (): void => {
    if (pendingExecution === undefined) return
    const event = pendingExecution
    pendingExecution = undefined
    lastExecutionBroadcastAt = Date.now()
    intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, {
      type: 'intent.turn.execution.updated',
      sessionId: event.sessionId,
      turnId: event.turnId,
      eventSeq: event.eventSeq,
      ownerUserId: actor.user.id,
    })
  }
  const queueExecution = (event: { sessionId: string; turnId: string; eventSeq: number }): void => {
    if (pendingExecution === undefined || event.eventSeq >= pendingExecution.eventSeq) {
      pendingExecution = event
    }
    const remaining = EXECUTION_BROADCAST_THROTTLE_MS - (Date.now() - lastExecutionBroadcastAt)
    if (remaining <= 0) {
      if (executionTimer !== undefined) clearTimeout(executionTimer)
      executionTimer = undefined
      flushExecution()
      return
    }
    if (executionTimer !== undefined) return
    executionTimer = setTimeout(() => {
      executionTimer = undefined
      flushExecution()
    }, remaining)
    executionTimer.unref?.()
  }

  try {
    const config = await resolveIntentTurnConfig(deps.runtimeResolver, deps.configSnapshot)
    await runIntentTurn(
      {
        persistence: deps.persistence,
        appHome: deps.appHome,
        config,
        resourceCatalog: deps.resourceCatalogFor(actor),
        dumpAuxiliary: deps.dumpAuxiliary,
        onSessionEvent: (event) => {
          if (
            event.type === 'intent.turn.execution.updated' &&
            event.turnId !== undefined &&
            event.eventSeq !== undefined
          ) {
            queueExecution({
              sessionId: event.sessionId,
              turnId: event.turnId,
              eventSeq: event.eventSeq,
            })
            return
          }
          if (event.type === 'intent.turn.started' || event.type === 'intent.turn.finished') {
            if (event.type === 'intent.turn.finished') flushExecution()
            intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, {
              type: event.type,
              sessionId: event.sessionId,
              turnId: event.turnId ?? '',
              ownerUserId: actor.user.id,
            })
          }
        },
        ...(deps.runFn === undefined ? {} : { runFn: deps.runFn }),
      },
      { sessionId, actor, reservation },
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const settled = await settleReservedIntentTurnStartFailure(deps.persistence, {
      sessionId,
      actor,
      reservation,
      detail,
    })
    log.warn('intent-turn-fire-failed', { sessionId, err: detail, settled })
    if (settled) {
      intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, {
        type: 'intent.turn.finished',
        sessionId,
        turnId: reservation.turnId,
        ownerUserId: actor.user.id,
      })
    }
  } finally {
    if (executionTimer !== undefined) clearTimeout(executionTimer)
    flushExecution()
    const next = await activateIntentWorkingSetChange(
      deps.persistence,
      intentResourceVisibility(deps.resourceCatalogFor(actor)),
      actor,
      sessionId,
      deps.configSnapshot.intentBuilderMaxGenerateRounds ?? 50,
    )
    if (next.reservation !== null) {
      emitSessionUpdated(sessionId, actor.user.id)
      void dispatchIntentTurn(deps, sessionId, actor, next.reservation)
    }
  }
}

/** Claim queued rows left by a dead process or a lost completion wake-up. */
export async function listQueuedIntentWorkingSetSessionIds(
  persistence: IntentPersistence,
): Promise<readonly string[]> {
  return await persistence.listQueuedWorkingSetSessionIds()
}

export async function resumeQueuedIntentWorkingSets(
  deps: IntentDispatchDeps,
  sessionIds?: readonly string[],
): Promise<number> {
  const queuedIds = sessionIds ?? (await listQueuedIntentWorkingSetSessionIds(deps.persistence))
  const queued = queuedIds.map((sessionId) => ({ sessionId }))
  let resumed = 0
  for (const { sessionId } of queued) {
    const session = await deps.persistence.findSession(sessionId)
    if (session === null) continue
    // The owner has to be re-admitted, not hand-projected: `resourceCatalogFor`
    // resolves the actor back to its registered authority (RFC-345), and a
    // projection the registry never minted throws `foreign-legacy-actor-projection`
    // — which is exactly how every queued successor silently died after a crash.
    const admitted = await admitDurableWorkOwner(deps.identityAccess, session.ownerUserId)
    if (admitted === null) continue
    const actor = admitted.actor as unknown as Actor
    const next = await activateIntentWorkingSetChange(
      deps.persistence,
      intentResourceVisibility(deps.resourceCatalogFor(actor)),
      actor,
      sessionId,
      deps.configSnapshot.intentBuilderMaxGenerateRounds ?? 50,
    )
    if (next.reservation === null) continue
    resumed += 1
    emitSessionUpdated(sessionId, actor.user.id)
    void dispatchIntentTurn(deps, sessionId, actor, next.reservation)
  }
  return resumed
}
