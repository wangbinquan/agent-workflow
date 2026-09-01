import type { NodeExecutionEventSnapshot } from './nodeExecutionPersistence'

export interface RuntimeSessionCaptureEvent {
  readonly ts: number
  readonly kind: NodeExecutionEventSnapshot['kind']
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
