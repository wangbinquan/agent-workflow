import type { NormalizedEventKind } from '@/services/runtime/types'

export type SessionEventSource = 'stream' | 'live-child' | 'post-run-child'
export type SessionCaptureTerminalState = 'complete' | 'truncated' | 'incomplete'
export type SessionCaptureIncompleteReason =
  | 'stream-persist-failed'
  | 'stream-frame-limit-exceeded'
  | 'child-capture-failed'
  | 'post-exit-flush-timeout'

/**
 * Observation-only seam shared by system-agent stdout and runtime-store
 * capture. Implementations must never make the agent's business result depend
 * on persistence of this auxiliary execution record.
 */
export interface SystemAgentEventSinkV1 {
  append(event: {
    ts: number
    kind: NormalizedEventKind | 'text' | 'stderr' | 'subagent_capture_failed'
    payload: string
    sessionId: string | null
    parentSessionId: string | null
    source: SessionEventSource
    externalEventId?: string
  }): Promise<void>
  setRootSessionId(sessionId: string): Promise<void>
  markTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void>
}
