// RFC-083 — whether a task status is terminal (a terminal task's structural diff is worth persisting, since its
// worktree may be GC'd). RFC-453: kept from the old artifact helper module, whose two standalone-file helpers were
// deleted (only a test used them); the terminal set is read from shared directly.

import { TERMINAL_TASK_STATUSES as LIFECYCLE_TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'

// RFC-097: single source of truth in services/lifecycle.ts.
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(LIFECYCLE_TERMINAL_TASK_STATUSES)

/** Whether a task status is terminal (worth persisting its structural diff,
 *  since a terminal task's worktree may be GC'd). */
export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status)
}
