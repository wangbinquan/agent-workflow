import type { TaskStatus, Task } from '@agent-workflow/shared'

export type WorkspacePruneCause = 'webhook-terminal'

export type TerminalWorkspacePruneDecision =
  | { readonly prune: false }
  | { readonly prune: true; readonly cause: WorkspacePruneCause }

/** The task columns a terminal workspace prune decision reads. */
export interface TerminalWorkspacePruneCandidate {
  readonly taskId: string
  readonly spaceKind: Task['spaceKind']
  readonly workspacePruningAt: number | null
  readonly workspacePruneCause: WorkspacePruneCause | null
  readonly workspacePrunedAt: number | null
}

/**
 * RFC-569: the session's terminal workspace prune policy as a closed interface (it was a function type alias). The
 * lifecycle writer asks it once when a task reaches `done` / `canceled`.
 */
export interface TerminalWorkspacePrunePolicy {
  decide(
    row: TerminalWorkspacePruneCandidate,
    to: TaskStatus,
  ): Promise<TerminalWorkspacePruneDecision>
}
