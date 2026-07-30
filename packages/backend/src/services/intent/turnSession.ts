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
  | 'kind'
  | 'captureState'
  | 'captureLastEventSeq'
  | 'captureEventBytes'
  | 'captureRootSessionId'
  | 'captureIncompleteReason'
>

function effectiveCaptureState(
  row: Pick<typeof intentTurns.$inferSelect, 'kind' | 'captureState'>,
): IntentTurnExecutionDto['captureState'] | null {
  // Capture is auxiliary, so a transient failure may prevent every terminal
  // marker while the following business settlement still succeeds. Once the
  // turn itself is terminal, an unresolved live marker means incomplete
  // evidence—not an execution that is still running.
  return row.captureState === 'live' && row.kind !== 'running' ? 'incomplete' : row.captureState
}

export function projectIntentTurnExecution(
  row: IntentTurnExecutionRow,
): IntentTurnExecutionDto | null {
  const captureState = effectiveCaptureState(row)
  if (captureState === null) return null
  return {
    captureState,
    lastEventSeq: row.captureLastEventSeq,
    eventBytes: row.captureEventBytes,
    rootSessionId: row.captureRootSessionId,
    incompleteReason:
      captureState === 'incomplete' && row.captureIncompleteReason === null
        ? 'stream-persist-failed'
        : row.captureIncompleteReason,
  }
}

/**
 * One ordered writer per turn. The promise tail serializes parent stream and
 * post-run child imports so event_seq never races across capture sources.
 */
export class IntentTurnSessionEventSink implements SystemAgentEventSinkV1 {
  private tail: Promise<void> = Promise.resolve()
  /** Once capture settles/caps, later observations bypass SQLite entirely. */
  private stopped = false
  /**
   * Remember the strongest requested terminal state before touching SQLite.
   * If that write fails transiently, a later generic complete retry must not
   * erase the fact that this process already observed truncated evidence or a
   * capture failure.
   */
  private terminalIntent:
    | {
        state: SessionCaptureTerminalState
        reason?: SessionCaptureIncompleteReason
      }
    | undefined

  constructor(
    private readonly db: DbClient,
    private readonly turnId: string,
    private readonly onUpdated?: (eventSeq: number) => void,
  ) {}

  append(event: Parameters<SystemAgentEventSinkV1['append']>[0]): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.enqueue(() => {
      if (this.stopped) return
      const result = dbTxSync(this.db, (tx) => {
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
        if (turn.captureState !== 'live') {
          return { eventSeq: turn.lastEventSeq, stop: true }
        }

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
          if (duplicate !== undefined) return { eventSeq: turn.lastEventSeq, stop: false }
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
          return { eventSeq: turn.lastEventSeq, stop: true }
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
        return { eventSeq, stop: false }
      })
      if (result.stop) this.stopped = true
      this.notify(result.eventSeq)
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
    const terminal = this.rememberTerminalIntent(state, reason)
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
        // Terminal evidence is monotonic: complete cannot repaint truncation,
        // while a later observed persistence/lifecycle failure is stronger
        // than truncation and must retain its explicit incomplete reason.
        if (
          turn.captureState === 'incomplete' ||
          (turn.captureState === 'truncated' && terminal.state !== 'incomplete')
        ) {
          return turn.lastEventSeq
        }
        tx.update(intentTurns)
          .set({
            captureState: terminal.state,
            captureIncompleteReason:
              terminal.state === 'incomplete' ? (terminal.reason ?? 'stream-persist-failed') : null,
          })
          .where(eq(intentTurns.id, this.turnId))
          .run()
        return turn.lastEventSeq
      })
      this.stopped = true
      this.notify(eventSeq)
    })
  }

  private rememberTerminalIntent(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): { state: SessionCaptureTerminalState; reason?: SessionCaptureIncompleteReason } {
    const current = this.terminalIntent
    const rank = (value: SessionCaptureTerminalState): number =>
      value === 'incomplete' ? 2 : value === 'truncated' ? 1 : 0
    if (current === undefined || rank(state) > rank(current.state)) {
      const next = {
        state,
        ...(state === 'incomplete' && reason !== undefined ? { reason } : {}),
      }
      this.terminalIntent = next
      return next
    }
    return current
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
      kind: intentTurns.kind,
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
  const captureState = effectiveCaptureState(turn)
  const tree =
    captureState === 'complete' || captureState === 'live'
      ? parsed
      : { ...parsed, captureComplete: false }
  return SessionViewResponseSchema.parse({ tree })
}
