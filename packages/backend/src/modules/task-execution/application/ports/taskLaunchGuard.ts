import type { SourceTerminationSnapshot } from '../../domain/sourceTermination'

/**
 * RFC-486: the source guard a protected launch hands to task-execution. Task-execution declares the members its launch
 * uses and offers the type from `public/types`; integration's `ProtectedMrLaunchGuard` extends it. The launch therefore no
 * longer takes integration's type (RFC-294 S9 item 5, the same move as RFC-481).
 */
export interface TaskLaunchGuard {
  readonly signal: AbortSignal
  readonly snapshot: SourceTerminationSnapshot
  /** Process-local final check, made again inside the task admission transaction. */
  assertCanCommit(): void
  /** Provider-neutral durable check, made before and inside the task admission transaction. */
  verifyCanCommit(): Promise<void>
  taskCommitted(taskId: string): Promise<void>
  launchSettled(taskId: string): Promise<void>
  failed(errorCode: string): Promise<void>
  release(): void
}
