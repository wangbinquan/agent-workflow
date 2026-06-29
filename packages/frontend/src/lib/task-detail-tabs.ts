// RFC-021: pure helpers for the task detail page's tab layout.
//
// Lives outside `routes/tasks.detail.tsx` so the React component can stay
// focused on JSX wiring while these branches get exhaustive unit coverage.

import type { NodeRun, Task } from '@agent-workflow/shared'

export type TaskDetailTab =
  | 'workflow-status'
  | 'node-runs'
  | 'details'
  | 'outputs'
  | 'worktree-files'
  | 'worktree-diff'
  | 'worktree-structure'
  | 'feedback'
  // RFC-120: task question list / 任务中心 board.
  | 'task-questions'

/** Canonical left-to-right tab order shown in the page tab bar.
 *  RFC-128 (用户 2026-06-29): the task-question board moves to SECOND (right after
 *  workflow-status) so pending questions are prominent; the tab also carries a
 *  pending-question count badge (wired in tasks.detail.tsx).
 *  `feedback` sits last — it's a reflective companion to the run, not part of the
 *  run-monitoring flow above. Moving it into a tab (instead of a fixed footer
 *  panel) was a deliberate call: a long feedback thread used to squeeze the
 *  panes' `flex:1; min-height:0` track down to zero. */
export const TAB_ORDER: readonly TaskDetailTab[] = [
  'workflow-status',
  // RFC-120 task-question board, RFC-128 hoisted to second for prominence.
  'task-questions',
  'node-runs',
  'details',
  'outputs',
  'worktree-files',
  'worktree-diff',
  // RFC-083: structural-diff overlay, immediately after the textual diff.
  'worktree-structure',
  'feedback',
] as const

/**
 * Filter `TAB_ORDER` to the tabs that should actually render. The
 * `outputs` tab is hidden when the workflow has no declared output
 * ports — showing an empty tab would just trick the user into clicking
 * it. Every other tab is always present (including `worktree-diff`,
 * which has its own "No base commit" / "No changes" fallbacks in-pane).
 */
export function availableTabs(opts: { hasOutputs: boolean }): TaskDetailTab[] {
  return TAB_ORDER.filter((t) => t !== 'outputs' || opts.hasOutputs)
}

/**
 * Resolve the `(selected node-run id, target tab)` pair the "Jump to
 * failed node" button should commit.
 *
 * - If `failedNodeId` matches a node_run row, pick the most-recently
 *   started run for that node (most users want the latest attempt's
 *   prompt / events / output).
 * - If there's no matching run yet (race between scheduler crash and
 *   the table refresh), still switch to the workflow-status tab so the
 *   user at least sees the canvas; selection stays null.
 *
 * Always returns `tab: 'workflow-status'` — the canvas is the only
 * place where node selection is meaningful.
 */
export function nextTabForFailedJump(
  runs: NodeRun[],
  failedNodeId: string | null,
): { runId: string | null; tab: TaskDetailTab } {
  if (failedNodeId === null) return { runId: null, tab: 'workflow-status' }
  let pick: NodeRun | null = null
  for (const r of runs) {
    if (r.nodeId !== failedNodeId) continue
    if (pick === null || (r.startedAt ?? 0) > (pick.startedAt ?? 0)) {
      pick = r
    }
  }
  return { runId: pick?.id ?? null, tab: 'workflow-status' }
}

/**
 * Terminal task statuses — no further node runs or recovery events can land, so
 * the detail page's live-poll queries (task / node-runs / recovery) switch off
 * their `refetchInterval`. Shared by `routes/tasks.detail.tsx` and
 * `components/tasks/RecoverySection.tsx` so the two never drift. Exported for
 * unit testing.
 */
export function isTerminal(status: Task['status'] | undefined): boolean {
  return (
    status === 'done' || status === 'failed' || status === 'canceled' || status === 'interrupted'
  )
}
