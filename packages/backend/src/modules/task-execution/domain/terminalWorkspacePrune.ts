import type { TaskStatus, Task } from '@agent-workflow/shared'

export type WorkspacePruneCause = 'webhook-terminal'

export type TerminalWorkspacePruneDecision =
  | { readonly prune: false }
  | { readonly prune: true; readonly cause: WorkspacePruneCause }

export type TerminalWorkspacePrunePolicy = (
  row: {
    taskId: string
    spaceKind: Task['spaceKind']
    workspacePruningAt: number | null
    workspacePruneCause: WorkspacePruneCause | null
    workspacePrunedAt: number | null
  },
  to: TaskStatus,
) => Promise<TerminalWorkspacePruneDecision>
