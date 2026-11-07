// RFC-465 (RFC-294 W9-D): the runtime drivers call this port and task-execution implements it (it writes its own
// node_run_events), so the port is owned here, by its caller.
import type { PersistedEventKind } from './agentObservations'

/** One captured transcript row: a persisted observation kind, the pump's stderr, or the capture's own failure marker. */
export interface RuntimeSessionCaptureEvent {
  readonly ts: number
  readonly kind: PersistedEventKind | 'stderr' | 'subagent_capture_failed'
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
}

/**
 * Provider-neutral persistence used by runtime transcript capture. Runtime
 * drivers own filesystem/native-store parsing; the selected provider owns
 * sibling de-duplication and the fenced event write.
 */
export interface RuntimeSessionCapturePersistence {
  resolveTaskId(nodeRunId: string): Promise<string | null>
  listSiblingCapturedSessionIds(input: {
    readonly taskId: string
    readonly nodeRunId: string
  }): Promise<ReadonlySet<string>>
  appendEvents(input: {
    readonly taskId: string
    readonly nodeRunId: string
    readonly events: readonly RuntimeSessionCaptureEvent[]
  }): Promise<void>
}
