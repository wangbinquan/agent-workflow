import { Buffer } from 'node:buffer'
import { and, asc, eq } from 'drizzle-orm'
import {
  SessionViewResponseSchema,
  parseSessionTree,
  type IntentTurnExecutionDto,
  type ParseSessionInputEvent,
  type SessionViewResponse,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { intentTurnEvents, intentTurns } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import type {
  SessionCaptureIncompleteReason,
  SessionCaptureTerminalState,
  SystemAgentEventSinkV1,
} from '@/services/sessionEventSink'
import { DomainError, NotFoundError } from '@/util/errors'

export const INTENT_TURN_EVENT_ROW_LIMIT = 10_000
export const INTENT_TURN_EVENT_BYTE_LIMIT = 8 * 1024 * 1024

type IntentTurnExecutionRow = Pick<
  typeof intentTurns.$inferSelect,
  | 'captureState'
  | 'captureLastEventSeq'
  | 'captureEventBytes'
  | 'captureRootSessionId'
  | 'captureIncompleteReason'
>

export function projectIntentTurnExecution(
  row: IntentTurnExecutionRow,
): IntentTurnExecutionDto | null {
  if (row.captureState === null) return null
  return {
    captureState: row.captureState,
    lastEventSeq: row.captureLastEventSeq,
    eventBytes: row.captureEventBytes,
    rootSessionId: row.captureRootSessionId,
    incompleteReason: row.captureIncompleteReason,
  }
}

/**
 * One ordered writer per turn. The promise tail serializes parent stream and
 * post-run child imports so event_seq never races across capture sources.
 */
export class IntentTurnSessionEventSink implements SystemAgentEventSinkV1 {
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly db: DbClient,
    private readonly turnId: string,
    private readonly onUpdated?: (eventSeq: number) => void,
  ) {}

  append(event: Parameters<SystemAgentEventSinkV1['append']>[0]): Promise<void> {
    return this.enqueue(() => {
      const nextEventSeq = dbTxSync(this.db, (tx) => {
        const turn = tx
          .select({
            captureState: intentTurns.captureState,
            lastEventSeq: intentTurns.captureLastEventSeq,
            eventBytes: intentTurns.captureEventBytes,
          })
          .from(intentTurns)
          .where(eq(intentTurns.id, this.turnId))
          .get()
        if (turn === undefined || turn.captureState === null) {
          throw new NotFoundError('intent-turn-not-found', 'intent turn capture target not found')
        }
        if (turn.captureState !== 'live') return turn.lastEventSeq

        if (event.externalEventId !== undefined) {
          const duplicate = tx
            .select({ id: intentTurnEvents.id })
            .from(intentTurnEvents)
            .where(
              and(
                eq(intentTurnEvents.turnId, this.turnId),
                eq(intentTurnEvents.source, event.source),
                eq(intentTurnEvents.externalEventId, event.externalEventId),
              ),
            )
            .get()
          if (duplicate !== undefined) return turn.lastEventSeq
        }

        const payloadBytes = Buffer.byteLength(event.payload, 'utf8')
        if (
          turn.lastEventSeq >= INTENT_TURN_EVENT_ROW_LIMIT ||
          turn.eventBytes + payloadBytes > INTENT_TURN_EVENT_BYTE_LIMIT
        ) {
          tx.update(intentTurns)
            .set({ captureState: 'truncated', captureIncompleteReason: null })
            .where(eq(intentTurns.id, this.turnId))
            .run()
          return turn.lastEventSeq
        }

        const eventSeq = turn.lastEventSeq + 1
        tx.insert(intentTurnEvents)
          .values({
            turnId: this.turnId,
            eventSeq,
            ts: event.ts,
            kind: event.kind,
            payload: event.payload,
            sessionId: event.sessionId,
            parentSessionId: event.parentSessionId,
            source: event.source,
            ...(event.externalEventId === undefined
              ? {}
              : { externalEventId: event.externalEventId }),
          })
          .run()
        tx.update(intentTurns)
          .set({
            captureLastEventSeq: eventSeq,
            captureEventBytes: turn.eventBytes + payloadBytes,
          })
          .where(eq(intentTurns.id, this.turnId))
          .run()
        return eventSeq
      })
      this.notify(nextEventSeq)
    })
  }

  setRootSessionId(sessionId: string): Promise<void> {
    return this.enqueue(() => {
      const eventSeq = dbTxSync(this.db, (tx) => {
        const turn = tx
          .select({
            captureState: intentTurns.captureState,
            rootSessionId: intentTurns.captureRootSessionId,
            lastEventSeq: intentTurns.captureLastEventSeq,
          })
          .from(intentTurns)
          .where(eq(intentTurns.id, this.turnId))
          .get()
        if (turn === undefined || turn.captureState === null) {
          throw new NotFoundError('intent-turn-not-found', 'intent turn capture target not found')
        }
        if (turn.rootSessionId === sessionId) return turn.lastEventSeq
        if (turn.rootSessionId !== null) {
          tx.update(intentTurns)
            .set({
              captureState: 'incomplete',
              captureIncompleteReason: 'stream-persist-failed',
            })
            .where(eq(intentTurns.id, this.turnId))
            .run()
          return turn.lastEventSeq
        }
        tx.update(intentTurns)
          .set({ captureRootSessionId: sessionId })
          .where(eq(intentTurns.id, this.turnId))
          .run()
        return turn.lastEventSeq
      })
      this.notify(eventSeq)
    })
  }

  markTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void> {
    return this.enqueue(() => {
      const eventSeq = dbTxSync(this.db, (tx) => {
        const turn = tx
          .select({
            captureState: intentTurns.captureState,
            lastEventSeq: intentTurns.captureLastEventSeq,
          })
          .from(intentTurns)
          .where(eq(intentTurns.id, this.turnId))
          .get()
        if (turn === undefined || turn.captureState === null) return 0
        // Truncation/incompleteness is evidence and may not be painted over by
        // a later generic "complete" call from a test seam or outer adapter.
        if (turn.captureState === 'truncated' || turn.captureState === 'incomplete') {
          return turn.lastEventSeq
        }
        tx.update(intentTurns)
          .set({
            captureState: state,
            captureIncompleteReason:
              state === 'incomplete' ? (reason ?? 'stream-persist-failed') : null,
          })
          .where(eq(intentTurns.id, this.turnId))
          .run()
        return turn.lastEventSeq
      })
      this.notify(eventSeq)
    })
  }

  private enqueue(work: () => void): Promise<void> {
    const next = this.tail.then(work, work)
    this.tail = next.catch(() => {})
    return next
  }

  private notify(eventSeq: number): void {
    try {
      this.onUpdated?.(eventSeq)
    } catch {
      // WS invalidation is best-effort; event durability already succeeded.
    }
  }
}

export async function getIntentTurnSession(
  db: DbClient,
  sessionId: string,
  turnId: string,
): Promise<SessionViewResponse> {
  const turn = db
    .select({
      id: intentTurns.id,
      sessionId: intentTurns.sessionId,
      role: intentTurns.role,
      createdAt: intentTurns.createdAt,
      captureState: intentTurns.captureState,
      rootSessionId: intentTurns.captureRootSessionId,
    })
    .from(intentTurns)
    .where(and(eq(intentTurns.id, turnId), eq(intentTurns.sessionId, sessionId)))
    .get()
  if (turn === undefined) {
    throw new NotFoundError('intent-session-not-found', 'intent session not found')
  }
  if (turn.role !== 'agent' || turn.captureState === null) {
    throw new DomainError(
      'intent-turn-session-not-applicable',
      'this intent turn has no captured agent session',
      410,
    )
  }

  const rows = db
    .select({
      id: intentTurnEvents.id,
      eventSeq: intentTurnEvents.eventSeq,
      ts: intentTurnEvents.ts,
      kind: intentTurnEvents.kind,
      payload: intentTurnEvents.payload,
      sessionId: intentTurnEvents.sessionId,
      parentSessionId: intentTurnEvents.parentSessionId,
    })
    .from(intentTurnEvents)
    .where(eq(intentTurnEvents.turnId, turn.id))
    .orderBy(asc(intentTurnEvents.eventSeq))
    .all()

  const events: ParseSessionInputEvent[] = rows.map((row) => ({
    id: row.eventSeq,
    ts: row.ts,
    kind: row.kind,
    payload: row.payload,
    sessionId: row.sessionId,
    parentSessionId: row.parentSessionId,
  }))
  const parsed = parseSessionTree({
    rootSessionId: turn.rootSessionId,
    promptText: null,
    startedAt: turn.createdAt,
    primaryAgentName: 'aw-intent-builder',
    events,
  })
  const tree =
    turn.captureState === 'complete' || turn.captureState === 'live'
      ? parsed
      : { ...parsed, captureComplete: false }
  return SessionViewResponseSchema.parse({ tree })
}
