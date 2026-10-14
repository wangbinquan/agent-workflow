import type { TaskStatus } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

// Required from task-execution (RFC-294: run-observability never imports
// task-execution; the composition root binds task-execution's offered query).

export interface ObservedTaskFact {
  readonly id: string
  readonly name: string
  readonly status: TaskStatus
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly runningMs: number
}

export interface ObservedAttemptFact {
  readonly nodeRunId: string
  readonly nodeId: string
  readonly retryIndex: number
}

export interface ObservationTaskFactsPort {
  /** The subset of `ids` (≤500) the actor may read. */
  visibleTaskIds(actor: Actor, ids: readonly string[]): Promise<readonly string[]>
  /** Display facts of existing tasks among `ids` (≤500); callers pass visible ids. */
  summaries(ids: readonly string[]): Promise<readonly ObservedTaskFact[]>
  /** Visible catalog tasks started in [from, to), newest first, keyset paged. */
  page(
    actor: Actor,
    query: {
      readonly from: number
      readonly to: number
      readonly q?: string
      readonly status?: string
      readonly after?: string
      readonly limit: number
    },
  ): Promise<{ readonly items: readonly ObservedTaskFact[]; readonly nextCursor: string | null }>
  /** Status counts and finished wall-clock durations (ascending) of visible catalog tasks started in [from, to). */
  counts(
    actor: Actor,
    window: { readonly from: number; readonly to: number },
  ): Promise<{
    readonly statuses: Readonly<Record<string, number>>
    readonly durations: readonly number[]
  }>
  /** Attempts of one task, for labelling its calls. */
  attempts(taskId: string): Promise<readonly ObservedAttemptFact[]>
}
