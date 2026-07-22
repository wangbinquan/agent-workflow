// RFC-021: pure helpers for the task detail page's tab layout.
//
// Lives outside `routes/tasks.detail.tsx` so the React component can stay
// focused on JSX wiring while these branches get exhaustive unit coverage.

import { isWorkgroupTask } from '@agent-workflow/shared'
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

export type TaskDetailGroup = 'overview' | 'execution' | 'artifacts' | 'collaboration'

export interface TaskDetailCapabilities {
  outputs: boolean
  worktreeFiles: boolean
  worktreeDiff: boolean
  worktreeStructure: boolean
  orchestration: boolean
  chatroom: boolean
  questions: boolean
  feedback: boolean
}

export interface TaskDetailCapabilityRoom {
  status: 'pending' | 'error' | 'ready'
  mode?: 'turn-engine' | 'dynamic-workflow'
}

export interface TaskDetailRelatedData {
  hasOutputs: boolean
  room: TaskDetailCapabilityRoom
  /** GET /questions inherits task visibility, so every task viewer can read it. */
  canReadQuestions: boolean
  /** GET /feedback is additionally guarded by the memory:read permission. */
  canReadFeedback: boolean
}

export interface TaskDetailNavigationGroup {
  key: TaskDetailGroup
  items: TaskDetailTab[]
}

export interface TaskDetailNavigation {
  groups: TaskDetailNavigationGroup[]
  availableTabs: TaskDetailTab[]
  defaultForGroup: Record<TaskDetailGroup, TaskDetailTab | undefined>
}

/**
 * Page-section information architecture. This changes presentation order only;
 * every leaf remains the existing TaskDetailTab URL wire key.
 */
export const TASK_DETAIL_GROUP_TABS: Readonly<Record<TaskDetailGroup, readonly TaskDetailTab[]>> = {
  overview: ['workflow-status', 'details', 'dw-orchestration'],
  execution: ['node-runs'],
  artifacts: ['outputs', 'worktree-files', 'worktree-diff', 'worktree-structure'],
  collaboration: ['task-questions', 'feedback', 'chatroom'],
}

export const TASK_DETAIL_GROUP_ORDER: readonly TaskDetailGroup[] = [
  'overview',
  'execution',
  'artifacts',
  'collaboration',
]

function nonEmptyPath(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function usableDiffProjection(projection: {
  worktreePath?: string | null
  baseCommit?: string | null
}): boolean {
  return nonEmptyPath(projection.worktreePath) && nonEmptyPath(projection.baseCommit)
}

/**
 * Single capability oracle for Task detail navigation and query/panel gates.
 *
 * The backend diff/structure consumers use the top-level projection for a
 * single-repo task and per-repo projections for a multi-repo task. In
 * particular, a multi-repo task has no meaningful aggregate base commit, so a
 * null top-level baseCommit must not hide usable repo shards. Worktree files
 * need only a readable task/repo root; actual filesystem disappearance remains
 * a stable in-panel 410 rather than being guessed from the DTO.
 */
export function deriveTaskDetailCapabilities(
  task: Pick<Task, 'workgroupId' | 'repoCount' | 'repos' | 'worktreePath' | 'baseCommit'>,
  relatedData: TaskDetailRelatedData,
): TaskDetailCapabilities {
  const isMultiRepo = task.repoCount > 1 || task.repos.length > 1
  const projections = [
    { worktreePath: task.worktreePath, baseCommit: task.baseCommit },
    ...task.repos.map((repo) => ({
      worktreePath: repo.worktreePath,
      baseCommit: repo.baseCommit,
    })),
  ]
  const hasWorktreeProjection = projections.some((projection) =>
    nonEmptyPath(projection.worktreePath),
  )
  const hasDiffProjection = isMultiRepo
    ? task.repos.some(usableDiffProjection)
    : usableDiffProjection({
        worktreePath: task.worktreePath,
        baseCommit: task.baseCommit,
      })
  const isWorkgroup = isWorkgroupTask(task)
  const stableRoom = isWorkgroup && relatedData.room.status === 'ready'

  return {
    outputs: relatedData.hasOutputs,
    worktreeFiles: hasWorktreeProjection,
    worktreeDiff: hasDiffProjection,
    worktreeStructure: hasDiffProjection,
    orchestration: stableRoom && relatedData.room.mode === 'dynamic-workflow',
    chatroom: stableRoom && relatedData.room.mode === 'turn-engine',
    questions: relatedData.canReadQuestions,
    feedback: relatedData.canReadFeedback,
  }
}

export function deriveTaskDetailNavigation(
  available: readonly TaskDetailTab[],
): TaskDetailNavigation {
  const availableSet = new Set(available)
  const defaultForGroup: Record<TaskDetailGroup, TaskDetailTab | undefined> = {
    overview: undefined,
    execution: undefined,
    artifacts: undefined,
    collaboration: undefined,
  }
  const groups: TaskDetailNavigationGroup[] = []

  for (const key of TASK_DETAIL_GROUP_ORDER) {
    const items = TASK_DETAIL_GROUP_TABS[key].filter((tab) => availableSet.has(tab))
    if (items.length === 0) continue
    defaultForGroup[key] = items[0]
    groups.push({ key, items })
  }

  return { groups, availableTabs: [...available], defaultForGroup }
}

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
 *
 * 2026-07-20 — `worktree-files` + `worktree-diff` were missing here from the
 * day this constant was born (91cab517), leaving the 产物 group with `structure`
 * as its only leaf: a user could see that symbols moved but could neither
 * browse nor DOWNLOAD the files the members wrote. That gap is worse for a
 * group than for a workflow task, because RFC-184 makes host runs persist no
 * declared outputs at all (scheduler.ts `persistDeclaredOutputs: false`), so
 * port artifacts are permanently empty and the canonical worktree is the group's
 * ONLY file deliverable — members run in throwaway iso worktrees whose refs are
 * deleted right after each turn, and their writes survive only by merge-back
 * into `tasks.worktree_path`. Both leaves stay capability-filtered below, so a
 * repo-less group still shows neither.
 */
export const WORKGROUP_TAB_ORDER: readonly TaskDetailTab[] = [
  'chatroom',
  'task-questions',
  'worktree-files',
  'worktree-diff',
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
 * Filter the preserved wire-order sets to the page sections that should
 * actually render. RFC-201 supplies the capability oracle so output,
 * worktree, room and permission-gated leaves do not lead to dead panels.
 * The fallback capability object keeps pre-RFC-201 pure callers compatible.
 *
 * RFC-164 PR-4: `isWorkgroup` (default false so pre-existing callers/tests
 * stay untouched) switches to the fixed `WORKGROUP_TAB_ORDER` set — the
 * chat room leads and canvas/outputs are absent unless the supplied
 * capability model says otherwise.
 *
 * RFC-167 PR-3: `isDynamicWorkgroup` (wins over `isWorkgroup` — the page
 * derives it from the room config's mode, which arrives one query later
 * than workgroupId) switches to DYNAMIC_WORKGROUP_TAB_ORDER before applying
 * the same capability filter.
 */
export function availableTabs(opts: {
  hasOutputs: boolean
  isWorkgroup?: boolean
  isDynamicWorkgroup?: boolean
  capabilities?: TaskDetailCapabilities
}): TaskDetailTab[] {
  const capabilities =
    opts.capabilities ??
    ({
      outputs: opts.hasOutputs,
      worktreeFiles: true,
      worktreeDiff: true,
      worktreeStructure: true,
      orchestration: opts.isDynamicWorkgroup === true,
      chatroom: opts.isWorkgroup === true && opts.isDynamicWorkgroup !== true,
      questions: true,
      feedback: true,
    } satisfies TaskDetailCapabilities)
  const permits = (tab: TaskDetailTab): boolean => {
    switch (tab) {
      case 'outputs':
        return capabilities.outputs
      case 'worktree-files':
        return capabilities.worktreeFiles
      case 'worktree-diff':
        return capabilities.worktreeDiff
      case 'worktree-structure':
        return capabilities.worktreeStructure
      case 'dw-orchestration':
        return capabilities.orchestration
      case 'chatroom':
        return capabilities.chatroom
      case 'task-questions':
        return capabilities.questions
      case 'feedback':
        return capabilities.feedback
      default:
        return true
    }
  }

  if (opts.isDynamicWorkgroup === true) {
    return DYNAMIC_WORKGROUP_TAB_ORDER.filter(permits)
  }
  if (opts.isWorkgroup === true) return WORKGROUP_TAB_ORDER.filter(permits)
  return TAB_ORDER.filter(permits)
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
 * Whether the "Jump to failed node" button is offerable at all: the jump
 * lands on the workflow-status canvas (`nextTabForFailedJump` hardcodes it —
 * node selection is only meaningful there), so a tab set WITHOUT that tab
 * must not render the button. Concretely: a turn-engine workgroup task
 * (WORKGROUP_TAB_ORDER) has no canvas — clicking used to setTab a tab the
 * invalid-tab fallback effect immediately bounced back to 'chatroom', with a
 * dangling node-run selection nothing consumes (scheduling-architecture
 * review 2026-07-14). Dynamic-workgroup and plain workflow sets keep it.
 */
export function canOfferFailedJump(tabs: readonly TaskDetailTab[]): boolean {
  return tabs.includes('workflow-status')
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
