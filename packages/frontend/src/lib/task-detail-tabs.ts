// RFC-021: pure helpers for the task detail page's tab layout.
//
// Lives outside `routes/tasks.detail.tsx` so the React component can stay
// focused on JSX wiring while these branches get exhaustive unit coverage.

import { isTerminalTaskStatus } from '@agent-workflow/shared'
import type { DynamicWorkflowPhase, NodeRun, Task } from '@agent-workflow/shared'

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
  // RFC-164 PR-4: workgroup task chat room (group tasks only — the room IS
  // the primary view; the host-graph canvas is not an observation surface).
  | 'chatroom'
  // RFC-167 PR-3: dynamic-workflow orchestration panel — generation progress,
  // the confirm gate (read-only DAG preview + approve / reject) and save-as.
  | 'dw-orchestration'

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
 * RFC-164 PR-4 — the workgroup-task tab set (chat room first = default tab).
 * The room replaces the workflow-status canvas (the builtin host graph is an
 * implementation detail, not an observation surface) and `outputs` never
 * applies (the host snapshot declares no output ports). Kept as its own
 * constant — NOT a filter over TAB_ORDER — so the group set can't silently
 * grow when a future RFC appends a workflow-task tab.
 */
export const WORKGROUP_TAB_ORDER: readonly TaskDetailTab[] = [
  'chatroom',
  'task-questions',
  'worktree-structure',
  'details',
] as const

/**
 * RFC-167 PR-3 — the dynamic_workflow task tab set. Unlike turn-engine
 * groups, a dynamic task IS a real DAG run after the confirm gate, so it
 * keeps the full workflow-task tab family (canvas, node-runs, outputs, diff)
 * and adds the orchestration panel first. No chatroom — dynamic mode has no
 * turns. The default tab is phase-driven (defaultDynamicTab), not simply
 * the first entry.
 */
export const DYNAMIC_WORKGROUP_TAB_ORDER: readonly TaskDetailTab[] = [
  'dw-orchestration',
  'workflow-status',
  'task-questions',
  'node-runs',
  'details',
  'outputs',
  'worktree-files',
  'worktree-diff',
  'worktree-structure',
  'feedback',
] as const

/**
 * Filter `TAB_ORDER` to the tabs that should actually render. The
 * `outputs` tab is hidden when the workflow has no declared output
 * ports — showing an empty tab would just trick the user into clicking
 * it. Every other tab is always present (including `worktree-diff`,
 * which has its own "No base commit" / "No changes" fallbacks in-pane).
 *
 * RFC-164 PR-4: `isWorkgroup` (default false so pre-existing callers/tests
 * stay untouched) switches to the fixed `WORKGROUP_TAB_ORDER` set — the
 * chat room leads, canvas/outputs are hidden, and `hasOutputs` is ignored.
 *
 * RFC-167 PR-3: `isDynamicWorkgroup` (wins over `isWorkgroup` — the page
 * derives it from the room config's mode, which arrives one query later
 * than workgroupId) switches to DYNAMIC_WORKGROUP_TAB_ORDER with the same
 * `outputs` filter as plain workflow tasks.
 */
export function availableTabs(opts: {
  hasOutputs: boolean
  isWorkgroup?: boolean
  isDynamicWorkgroup?: boolean
}): TaskDetailTab[] {
  if (opts.isDynamicWorkgroup === true) {
    return DYNAMIC_WORKGROUP_TAB_ORDER.filter((t) => t !== 'outputs' || opts.hasOutputs)
  }
  if (opts.isWorkgroup === true) return [...WORKGROUP_TAB_ORDER]
  return TAB_ORDER.filter((t) => t !== 'outputs' || opts.hasOutputs)
}

/**
 * RFC-167 PR-3 — the phase-driven DEFAULT tab for a dynamic_workflow task:
 * while the orchestration is being generated / awaiting the human confirm,
 * the orchestration panel is the primary view; once confirmed (executing,
 * incl. the terminal states after it), the real DAG canvas takes over.
 * Applied once when the room config first arrives (the page keeps the
 * user's manual tab choice afterwards).
 */
export function defaultDynamicTab(phase: DynamicWorkflowPhase | null | undefined): TaskDetailTab {
  return phase === 'executing' ? 'workflow-status' : 'dw-orchestration'
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
 * unit testing. flag-audit W0: the status set itself now comes from shared's
 * TERMINAL_TASK_STATUSES (single source) instead of a hand-copied list.
 */
export function isTerminal(status: Task['status'] | undefined): boolean {
  return status !== undefined && isTerminalTaskStatus(status)
}
