import { Buffer } from 'node:buffer'
import {
  SessionViewResponseSchema,
  parseSessionTree,
  type IntentTurnExecutionDto,
  type ParseSessionInputEvent,
  type SessionViewResponse,
} from '@agent-workflow/shared'
import type {
  IntentTurnEventPersistence,
  IntentTurnRecord,
} from '@/modules/intent/application/ports/intentPersistence'
import type {
  SessionCaptureIncompleteReason,
  SessionCaptureTerminalState,
  SystemAgentEventSinkV1,
} from '@/services/sessionEventSink'
import { DomainError, NotFoundError } from '@/util/errors'

export const INTENT_TURN_EVENT_ROW_LIMIT = 10_000
export const INTENT_TURN_EVENT_BYTE_LIMIT = 8 * 1024 * 1024

type IntentTurnExecutionRow = Pick<
  IntentTurnRecord,
  | 'kind'
  | 'captureState'
  | 'captureLastEventSeq'
  | 'captureEventBytes'
  | 'captureRootSessionId'
  | 'captureIncompleteReason'
>

function effectiveCaptureState(
  row: Pick<IntentTurnRecord, 'kind' | 'captureState'>,
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
  /** A reset is provisional: replacement can restore a live capture in-process. */
  private resetPendingFrom: string | undefined
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
    private readonly persistence: IntentTurnEventPersistence,
    private readonly turnId: string,
    private readonly onUpdated?: (eventSeq: number) => void,
  ) {}

  append(event: Parameters<SystemAgentEventSinkV1['append']>[0]): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.enqueue(async () => {
      if (this.stopped) return
      const result = await this.persistence.appendTurnEvent({
        turnId: this.turnId,
        ts: event.ts,
        kind: event.kind,
        payload: event.payload,
        sessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        source: event.source,
        externalEventId: event.externalEventId ?? null,
        byteLength: Buffer.byteLength(event.payload, 'utf8'),
        rowLimit: INTENT_TURN_EVENT_ROW_LIMIT,
        byteLimit: INTENT_TURN_EVENT_BYTE_LIMIT,
      })
      if (result.stopped) this.stopped = true
      this.notify(result.eventSeq)
    })
  }

  setRootSessionId(sessionId: string, previousSessionId?: string): Promise<void> {
    return this.enqueue(async () => {
      const result = await this.persistence.replaceTurnRootSession({
        turnId: this.turnId,
        sessionId,
        ...(previousSessionId === undefined ? {} : { previousSessionId }),
      })
      if (previousSessionId !== undefined && this.resetPendingFrom === previousSessionId) {
        this.resetPendingFrom = undefined
        // Pending itself never changed the durable capture verdict. If a size
        // cap or another terminal condition landed meanwhile, keep it monotonic.
        this.stopped = result.captureState !== 'live'
      }
      this.notify(result.eventSeq)
    })
  }

  markRootSessionResetPending(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const turn = await this.persistence.readTurnCapture(this.turnId)
      if (turn === null || turn.captureState === null) {
        throw new NotFoundError('intent-turn-not-found', 'intent turn capture target not found')
      }
      if (turn.captureRootSessionId !== sessionId) {
        throw new DomainError(
          'intent-turn-runtime-session-changed',
          'runtime conversation reset did not match the captured root session',
          409,
        )
      }
      // Pending is provisional, not a terminal capture verdict. Only a live
      // capture enters this in-memory state; a prior cap/failure is monotonic.
      if (turn.captureState === 'live') this.resetPendingFrom = sessionId
      this.notify(turn.captureLastEventSeq)
    })
  }

  markTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void> {
    const terminal = this.rememberTerminalIntent(
      this.resetPendingFrom === undefined ? state : 'incomplete',
      this.resetPendingFrom === undefined ? reason : 'stream-persist-failed',
    )
    return this.enqueue(async () => {
      const result = await this.persistence.settleTurnCapture({
        turnId: this.turnId,
        state: terminal.state,
        ...(terminal.reason === undefined ? {} : { incompleteReason: terminal.reason }),
      })
      this.stopped = true
      this.notify(result.eventSeq)
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

  private enqueue(work: () => void | Promise<void>): Promise<void> {
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
  persistence: IntentTurnEventPersistence,
  sessionId: string,
  turnId: string,
): Promise<SessionViewResponse> {
  const capture = await persistence.readTurnSession(turnId)
  if (capture === null || capture.turn.sessionId !== sessionId) {
    throw new NotFoundError('intent-session-not-found', 'intent session not found')
  }
  const { turn } = capture
  if (turn.role !== 'agent' || turn.captureState === null) {
    throw new DomainError(
      'intent-turn-session-not-applicable',
      'this intent turn has no captured agent session',
      410,
    )
  }

  const events: ParseSessionInputEvent[] = capture.events.map((row) => ({
    id: row.eventSeq,
    ts: row.ts,
    kind: row.kind,
    payload: row.payload,
    sessionId: row.sessionId,
    parentSessionId: row.parentSessionId,
  }))
  const parsed = parseSessionTree({
    rootSessionId: turn.captureRootSessionId,
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
