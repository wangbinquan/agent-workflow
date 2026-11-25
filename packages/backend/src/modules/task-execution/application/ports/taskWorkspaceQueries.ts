// RFC-588 — the bound workspace queries the task routes read (the worktree browser's listing and file read). They left
// `public/queries` when the task routes moved into this module's inbound layer: no other module consumes them.
import type { WorktreeTreeEntry } from '@agent-workflow/shared'

/** The existing Task visibility gate runs before these bound workspace queries. */
export interface TaskWorkspaceQueries {
  listDisplay(
    taskId: string,
    relativeDirectory: string,
  ): Promise<{ readonly entries: readonly WorktreeTreeEntry[]; readonly truncated: boolean }>
  readDisplay(
    taskId: string,
    relativeFile: string,
  ): Promise<{ readonly content: string; readonly size: number; readonly oversized: boolean }>
}
