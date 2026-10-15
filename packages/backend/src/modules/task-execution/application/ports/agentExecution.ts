// RFC-370 v2 §3.3 / §5.2 — the execution side of one bound agent invocation.
//
// The selected implementation owns its transport: a local child process reads
// native stdout lines through the runtime protocol, a CrewStation subtask
// consumes the platform's normalized event stream. Either way the caller
// receives records it never has to parse, so the node / system / smoke logic
// (envelope, session leases, event persistence, usage, final status) is the
// same for both targets.
import type { NormalizedEvent, SystemEventObservation } from '@/services/runtime/types'
import type { Logger } from '@/util/log'
import type { AgentExecutionParticipants } from './agentExecutionBinding'

/** One record of an execution's output stream, interpreted by the selected
 * implementation. `raw` is what event persistence stores: a native stdout line
 * locally, a normalized JSON record for a hosted execution. */
export interface AgentExecutionRecord {
  /** Stable transport identity when an execution can be adopted and replayed. */
  readonly sourceKey?: string
  readonly raw: string
  /** The normalized runtime event; null when the record has no interpretation. */
  readonly event: NormalizedEvent | null
  /** Runtime-event observation used by system-agent output evidence. */
  readonly observation?: SystemEventObservation
  /** The runtime's terminal application error carried by this record. */
  readonly terminalError?: string
}

/** Callbacks run in arrival order; a rejection stops the execution and is
 * reported as the outcome's `pumpError`. */
export interface AgentExecutionSink {
  record(record: AgentExecutionRecord): Promise<void>
  /** One runtime diagnostic line (local stderr). */
  diagnostic(line: string): Promise<void>
  /** Everything delivered on `stream` since the last checkpoint is one batch. */
  checkpoint(stream: 'records' | 'diagnostics'): Promise<void>
  /** A record or diagnostic was delivered truncated (evidence incomplete). */
  truncated?(): Promise<void>
}

export interface AgentExecutionRequest {
  readonly timeoutMs?: number
  readonly termGraceMs?: number
  readonly signal?: AbortSignal
  /** Last product admission immediately before the execution starts. */
  readonly beforeStart?: () => void | Promise<void>
  /** Runs once the execution is reaped (skipped when it could not be). */
  readonly cleanup?: () => void | Promise<void>
  /** The owner acknowledges the started execution before any record; a
   * rejection aborts it (system owners that fence on the start receipt). */
  readonly acknowledgeStart?: boolean
  /** Task-owned executions record their durable effect and start receipt. */
  readonly task?: {
    readonly participants: AgentExecutionParticipants
    readonly taskId: string
    readonly nodeRunId: string
  }
  readonly log?: Logger
}

export type AgentExecutionResult =
  | 'ok'
  | 'nonzero-exit'
  | 'timeout'
  | 'aborted'
  | 'spawn-failed'
  | 'unreaped'

export interface AgentExecutionOutcome {
  readonly result: AgentExecutionResult
  readonly exitCode: number | null
  readonly stderrTail: string
  readonly durationMs: number
  readonly spawnError?: string
  /** First rejection raised by a sink callback. */
  readonly pumpError?: string
  /** The execution ended but its output tail could not be fully drained. */
  readonly drainTimedOut?: boolean
  readonly cleanupFailed?: boolean
  /** A start acknowledgement rejected; the execution was aborted for it. */
  readonly acknowledgeError?: unknown
  /** Operator-facing explanation when the execution could not be reaped. */
  unreapedMessage(deadlineMs: number): string
  /** Log the unreaped execution for manual cleanup. */
  reportUnreaped(input: {
    readonly nodeRunId: string
    readonly deadlineMs: number
    readonly log: Logger
  }): void
  /** Settle the durable task effect after the caller committed its own
   * projection; a no-op for executions without a task effect. */
  settle(): Promise<void>
}
