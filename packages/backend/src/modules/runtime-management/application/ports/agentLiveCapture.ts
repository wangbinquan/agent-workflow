/** Logical live-evidence request and handle; native store locations stay private. */
import type { RuntimeSessionCapturePersistence } from '@/modules/task-execution/application/ports/runtimeSessionCapturePersistence'
import type { Logger } from '@/util/log'

export interface AgentLiveCaptureRequest {
  nodeRunId: string
  taskId: string
  /** Workflow node id (canvas-level). Forwarded to onInsert payloads. */
  nodeId: string
  /**
   * Root opencode session id resolver. Returns null until stdoutPump observes
   * the first `sessionID` event from the child process; the poller short-
   * circuits its tick while this is null (no point BFS'ing nothing).
   */
  getRootSessionId: () => string | null
  persistence: RuntimeSessionCapturePersistence
  log?: Logger
  /** Cadence between ticks. `0` disables the poller — startLive returns a no-op handle. */
  pollMs: number
  /** Auto-disable after this many back-to-back failing ticks. */
  consecutiveFailureLimit: number
  /** When aborted, the poller stops itself. The runner pipes child.exited in here. */
  signal?: AbortSignal
  /**
   * Fired once per tick that actually inserted at least one row. The runner
   * uses this to broadcast a `node.status: running` re-ping so the frontend
   * `useTaskSync` invalidates `['tasks', taskId, 'node-runs']`. Tests can
   * pass a spy here.
   */
  onInsert?: (info: { insertedRows: number; sessionIds: string[] }) => void
}

export interface AgentLiveCaptureStats {
  ticks: number
  insertedRows: number
  failedTicks: number
  disabled: boolean
  /** Snapshot of internal partId dedupe state — runner.ts forwards into post-run capture. */
  insertedPartIdsBySession: Map<string, Set<string>>
}

export interface AgentLiveCaptureHandle {
  stop(): void
  /**
   * Test-only: run a single tick synchronously. The production timer just
   * invokes the same function on a setInterval cadence; exposing it lets
   * unit tests seed the SQLite fixture between ticks without sleeping.
   */
  tickOnce(): Promise<number>
  stats(): AgentLiveCaptureStats
}
