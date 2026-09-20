import { Buffer } from 'node:buffer'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  SessionCaptureIncompleteReason,
  SessionCaptureTerminalState,
  SystemAgentEventSinkV1,
} from '@/services/sessionEventSink'
import type { McpRuntimeTestPersistence } from './runtimeTestPersistence'
import {
  sha256,
  stableJson,
  MCP_RUNTIME_TEST_EVENT_ROWS,
  MCP_RUNTIME_TEST_EVENT_BYTES,
  MCP_RUNTIME_TEST_SINGLE_EVENT_BYTES,
} from '../../domain/mcps/runtimeDiagnostics'
interface EventSinkOwner {
  sessionId: string
  turnId: string
}
export class McpRuntimeTestEventSink implements SystemAgentEventSinkV1 {
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  private resetPendingFrom: string | undefined
  private terminalIntent:
    | { state: SessionCaptureTerminalState; reason?: SessionCaptureIncompleteReason }
    | undefined

  constructor(
    private readonly persistence: McpRuntimeTestPersistence,
    private readonly owner: EventSinkOwner,
    private readonly notify?: () => void,
    private readonly claimNativeSession?: (
      sessionId: string,
      previousSessionId?: string,
    ) => Promise<void>,
  ) {}

  append(event: Parameters<SystemAgentEventSinkV1['append']>[0]): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.enqueue(async () => {
      if (this.stopped) return
      const result = await this.persistence.appendEvent({
        sessionId: this.owner.sessionId,
        turnId: this.owner.turnId,
        ts: event.ts,
        kind: event.kind,
        payload: event.payload,
        runtimeSessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        source: event.source,
        externalEventKey:
          event.externalEventId === undefined
            ? null
            : sha256(
                stableJson({
                  runtimeSessionId: event.sessionId,
                  externalEventId: event.externalEventId,
                }),
              ),
        payloadBytes: Buffer.byteLength(event.payload, 'utf8'),
        maxSingleEventBytes: MCP_RUNTIME_TEST_SINGLE_EVENT_BYTES,
        maxSessionRows: MCP_RUNTIME_TEST_EVENT_ROWS,
        maxSessionBytes: MCP_RUNTIME_TEST_EVENT_BYTES,
      })
      if (result === 'stopped' || result === 'truncated') this.stopped = true
      this.notify?.()
    })
  }

  setRootSessionId(sessionId: string, previousSessionId?: string): Promise<void> {
    return this.enqueue(async () => {
      const before = await this.persistence.loadRuntimeSessionId(this.owner.sessionId)
      if (before === undefined) {
        throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
      }
      if (previousSessionId !== undefined) {
        if (before !== previousSessionId) {
          throw new ConflictError(
            'mcp-test-runtime-session-changed',
            'runtime conversation reset did not match the persisted native session',
          )
        }
        await this.claimNativeSession?.(sessionId, previousSessionId)
      } else if (before === null) {
        await this.claimNativeSession?.(sessionId)
      }
      // The production lease participant rotates the lease key, durable
      // session pointer and root-event identities atomically. Once it returns,
      // persistence must observe the new id rather than attempting the old-id
      // CAS a second time. A standalone sink without a lease participant keeps
      // the legacy persistence-owned rotation path for focused fixtures.
      const persistencePreviousSessionId =
        previousSessionId !== undefined && this.claimNativeSession === undefined
          ? previousSessionId
          : undefined
      const result = await this.persistence.setRootSession({
        sessionId: this.owner.sessionId,
        turnId: this.owner.turnId,
        runtimeSessionId: sessionId,
        ...(persistencePreviousSessionId === undefined
          ? {}
          : { previousRuntimeSessionId: persistencePreviousSessionId }),
      })
      if (previousSessionId !== undefined) {
        if (this.resetPendingFrom === previousSessionId) this.resetPendingFrom = undefined
        this.stopped = !result.captureLive
      }
      this.notify?.()
    })
  }

  markRootSessionResetPending(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const result = await this.persistence.markRootSessionResetPending({
        sessionId: this.owner.sessionId,
        turnId: this.owner.turnId,
        runtimeSessionId: sessionId,
      })
      if (result.captureLive) this.resetPendingFrom = sessionId
      this.notify?.()
    })
  }

  markTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void> {
    const terminal = this.rememberTerminal(
      this.resetPendingFrom === undefined ? state : 'incomplete',
      this.resetPendingFrom === undefined ? reason : 'stream-persist-failed',
    )
    return this.enqueue(async () => {
      const finalState =
        terminal.state === 'truncated'
          ? 'truncated'
          : terminal.state === 'incomplete'
            ? 'incomplete'
            : 'complete'
      await this.persistence.markCaptureTerminal({
        sessionId: this.owner.sessionId,
        turnId: this.owner.turnId,
        state: finalState,
        reason: finalState === 'incomplete' ? (terminal.reason ?? null) : null,
      })
      this.stopped = true
      this.notify?.()
    })
  }

  private rememberTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): { state: SessionCaptureTerminalState; reason?: SessionCaptureIncompleteReason } {
    const rank = (value: SessionCaptureTerminalState): number =>
      value === 'incomplete' ? 2 : value === 'truncated' ? 1 : 0
    if (this.terminalIntent === undefined || rank(state) > rank(this.terminalIntent.state)) {
      this.terminalIntent = {
        state,
        ...(state === 'incomplete' && reason !== undefined ? { reason } : {}),
      }
    }
    return this.terminalIntent
  }

  private enqueue(work: () => void | Promise<void>): Promise<void> {
    const next = this.tail.then(work, work)
    this.tail = next.catch(() => {})
    return next
  }
}
