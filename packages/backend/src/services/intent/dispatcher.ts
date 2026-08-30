// RFC-293 — one dispatcher for HTTP-triggered turns and queued boot recovery.

import { eq } from 'drizzle-orm'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type {
  CurrentSubjectAccessResolver,
  LegacyActorProjectionFactory,
} from '@/modules/identity-access/public/participants'
import { intentSessions, intentWorkingSetChanges } from '@/db/schema'
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

const log = createLogger('intentDispatcher')

export interface IntentDispatchDeps {
  db: DbClient
  identityAccess: Readonly<{
    resolveAuthority: CurrentSubjectAccessResolver
    legacyProjection: LegacyActorProjectionFactory
  }>
  appHome: string
  configSnapshot: ReturnType<typeof loadConfig>
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
    const config = await resolveIntentTurnConfig(deps.db, deps.configSnapshot)
    await runIntentTurn(
      {
        db: deps.db,
        appHome: deps.appHome,
        config,
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
    const settled = settleReservedIntentTurnStartFailure(deps.db, {
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
    const next = activateIntentWorkingSetChange(
      deps.db,
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
export function listQueuedIntentWorkingSetSessionIds(db: DbClient): string[] {
  return db
    .select({ sessionId: intentWorkingSetChanges.sessionId })
    .from(intentWorkingSetChanges)
    .where(eq(intentWorkingSetChanges.state, 'queued'))
    .all()
    .map((row) => row.sessionId)
}

export async function resumeQueuedIntentWorkingSets(
  deps: IntentDispatchDeps,
  sessionIds: readonly string[] = listQueuedIntentWorkingSetSessionIds(deps.db),
): Promise<number> {
  const queued = sessionIds.map((sessionId) => ({ sessionId }))
  let resumed = 0
  for (const { sessionId } of queued) {
    const session = (
      await deps.db.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).limit(1)
    )[0]
    if (session === undefined) continue
    const current = await deps.identityAccess.resolveAuthority.resolveCurrentSubject(
      session.ownerUserId,
    )
    const actor =
      current === null
        ? null
        : (deps.identityAccess.legacyProjection.fromResolvedSubject(current) as unknown as Actor)
    if (actor === null) continue
    const next = activateIntentWorkingSetChange(
      deps.db,
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
