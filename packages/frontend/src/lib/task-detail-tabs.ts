// RFC-021: pure helpers for the task detail page's tab layout.
//
// Lives outside `routes/tasks.detail.tsx` so the React component can stay
// focused on JSX wiring while these branches get exhaustive unit coverage.

import type { NodeRun } from '@agent-workflow/shared'

export type TaskDetailTab =
  | 'workflow-status'
  | 'node-runs'
  | 'details'
  | 'outputs'
  | 'worktree-diff'

/** Canonical left-to-right tab order shown in the page tab bar. The
 *  product spec pins this sequence; do not reorder without an RFC. */
export const TAB_ORDER: readonly TaskDetailTab[] = [
  'workflow-status',
  'node-runs',
  'details',
  'outputs',
  'worktree-diff',
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
