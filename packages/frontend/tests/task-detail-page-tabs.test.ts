// RFC-021/RFC-201: source-level locks on how `tasks.detail.tsx` wires the
// URL-backed page-section layout. We deliberately don't do a full RTL render of TaskDetailPage —
// that route reads from tanstack-router's `Route.useParams()`, runs four
// `useQuery`s, two `useMutation`s, and `useTaskSync` (WS), so a full
// integration render would need a wall of mocks and would still fail to
// exercise xyflow inside jsdom.
//
// What this file *does* lock: the structural invariants that keep every
// URL key mapped to one hidden/active section, grouped page navigation, and the jumpToFailed handler that
// switches tab synchronously with the node-run selection. Pure-function
// branches (TAB_ORDER / availableTabs / nextTabForFailedJump) are
// covered by tests/task-detail-tabs.test.ts.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src/routes/tasks.detail.tsx'), 'utf8')

describe('TaskDetailPage page-section structure', () => {
  test('page root uses .page--task-detail (viewport lock anchor)', () => {
    expect(SRC).toMatch(/className="page page--task-detail"/)
    expect(SRC).not.toMatch(/className="page page--wide"/)
  })

  test('uses shared page, feedback and table primitives for the task shell', () => {
    expect(SRC).toMatch(/<PageHeader\b/)
    expect(SRC).not.toMatch(/<header className="page__header/)
    expect(SRC).toMatch(/<NoticeBanner\b/)
    expect(SRC).toMatch(/<ErrorBanner\b/)
    expect(SRC).toMatch(/<TableViewport label=\{t\('tasks\.tabNodeRuns'\)\} minWidth="lg">/)
  })

  test('primary query and tab data errors expose retry actions', () => {
    expect(SRC).toContain(
      'task.data === undefined && task.error !== null && task.error !== undefined',
    )
    // RFC-214: single-query error banners收编到 ErrorBanner.onRetry (was hand-written
    // button onClick). The room banner (compound Details+retry action) stays onClick — see below.
    expect(SRC).toMatch(/onRetry=\{\(\) => void task\.refetch\(\)\}/)
    expect(SRC).toMatch(/onRetry=\{\(\) => void nodeRuns\.refetch\(\)\}/)
    expect(SRC).toMatch(/onRetry=\{\(\) => void diff\.refetch\(\)\}/)
    expect(SRC).toMatch(/onRetry=\{\(\) => void structuralDiff\.refetch\(\)\}/)
    expect(SRC).toContain("tab === 'workflow-status' || tab === 'node-runs' || tab === 'outputs'")
    expect(SRC).toContain(
      'nodeRunsConsumerActive && nodeRuns.data === undefined && nodeRuns.isLoading',
    )
  })

  test('uses grouped inline PageSectionNav instead of pseudo-tab semantics', () => {
    expect(SRC).toMatch(/<PageSectionNav<TaskDetailTab>/)
    expect(SRC).toMatch(/presentation="inline"/)
    expect(SRC).toMatch(/<PageSectionLink/)
    expect(SRC).not.toMatch(/<TabBar\b/)
    expect(SRC).not.toMatch(/role:\s*'tabpanel'/)
  })

  test('renders six panes keyed by `hidden={tab !== ...}` (one per TaskDetailTab)', () => {
    const tabs = [
      'workflow-status',
      'node-runs',
      'details',
      'outputs',
      'worktree-diff',
      'worktree-structure',
      'feedback',
    ]
    for (const k of tabs) {
      expect(SRC).toMatch(new RegExp(`hidden=\\{tab !== '${k}'\\}`))
    }
  })

  test('outputs pane is gated on the shared capability so an empty section never shows up', () => {
    // `availableTabs` filters the navigation; this guard makes sure the
    // pane DOM also stays absent when there are no output ports.
    expect(SRC).toMatch(/\{taskCapabilities\.outputs && \(/)
  })

  test('jumpToFailed uses nextTabForFailedJump and applies selection + URL push', () => {
    // Catches a future refactor that only updates selectedNodeRunId
    // (then the tab stays on whatever the user was browsing) or only
    // URL navigation (then the drawer never opens).
    expect(SRC).toMatch(/nextTabForFailedJump\(/)
    expect(SRC).toMatch(/setSelectedNodeRunId\(runId\)/)
    expect(SRC).toMatch(/navigateTaskTab\(next\)/)
  })

  test('jumpToFailed button render is gated on canOfferFailedJump(tabs)', () => {
    // Scheduling-architecture review 2026-07-14: the jump targets the
    // workflow-status canvas, which turn-engine workgroup tasks don't have —
    // without this gate the button bounced back to the chatroom with a
    // dangling node-run selection. The pure branch cases live in
    // task-detail-tabs.test.ts (canOfferFailedJump); this locks the wiring.
    expect(SRC).toMatch(/canOfferFailedJump\(tabs\) && \(/)
  })

  test('uses WorktreeDiffPanel (not the legacy DiffViewer) on the diff pane', () => {
    expect(SRC).toMatch(/<WorktreeDiffPanel\b/)
    expect(SRC).not.toMatch(/<DiffViewer\b/)
    expect(SRC).toMatch(
      /taskSectionProps\(t, 'worktree-diff'\)[\s\S]*?className="task-detail__pane task-detail__pane--worktree-diff"/,
    )
  })

  test('emits all seven tab i18n labels via the tabLabel switch (RFC-065 added worktree-files)', () => {
    for (const key of [
      'tabWorkflowStatus',
      'tabNodeRuns',
      'tabDetails',
      'tabOutputs',
      'tabWorktreeFiles',
      'tabWorktreeDiff',
      'tabWorktreeStructure',
      'tabFeedback',
    ]) {
      expect(SRC).toMatch(new RegExp(`'tasks\\.${key}'`))
    }
  })

  test('every pane sits inside .task-detail__panes (overflow container)', () => {
    // Counts panes vs occurrences of the panes wrapper — the wrapper
    // should appear exactly once and contain every `.task-detail__pane`.
    // RFC-065 added the worktree-files pane between outputs and worktree-diff.
    // RFC-120 added the task-questions pane (board) after feedback.
    // RFC-164 PR-4 added the workgroup chatroom pane (first; content gated on
    // isWorkgroup — see rfc164-workgroup-tabs.test.ts for its wiring locks).
    // RFC-167 PR-3 added the dw-orchestration pane (dynamic-workflow confirm
    // gate; content gated on isDynamicWorkgroup).
    const paneCount = (SRC.match(/className="task-detail__pane(?:\s[^"]*)?"/g) ?? []).length
    expect(paneCount).toBe(11)
    expect(SRC.match(/className="task-detail__panes"/g)?.length).toBe(1)
  })

  test('URL search is the sole tab authority and canonical fallbacks replace', () => {
    expect(SRC).toMatch(/validateSearch:\s*validateTaskDetailSearch/)
    expect(SRC).toMatch(/const search = Route\.useSearch\(\)/)
    expect(SRC).toMatch(/resolveTaskDetailTabs\(\{/)
    expect(SRC).toMatch(/navigateTaskTab\(canonicalTab, true\)/)
    expect(SRC).not.toMatch(/useState<TaskDetailTab>/)
    expect(SRC).not.toMatch(/\bsetTab\(/)
  })

  test('all explicit section jumps share push navigation and preserve search', () => {
    expect(SRC).toMatch(/search: \(previous\) => withTaskDetailTab\(previous, next\)/)
    expect(SRC).toMatch(/onSelectCompact=\{\(next\) => navigateTaskTab\(next\)\}/)
    expect(SRC).toMatch(/search=\{\(previous\) => withTaskDetailTab\(previous, key\)\}/)
    expect(SRC).toMatch(/navigateTaskTab\('task-questions'\)/)
    expect(SRC).toMatch(/navigateTaskTab\('worktree-diff'\)/)
  })

  test('navigation owns aria-current and every panel is an accessible section, not a tabpanel', () => {
    expect(SRC).toMatch(/idPrefix="task-detail"/)
    expect(SRC).toMatch(/pageSectionCurrent=\{destination\.ariaCurrent\}/)
    expect(SRC).toMatch(/id: `task-detail-section-\$\{tab\}`/)
    expect(SRC).toMatch(/'aria-label': tabLabel\(t, tab\)/)
    expect(SRC).not.toMatch(/taskTabPanelProps/)
  })

  test('diff and structure queries/panels share the multi-repo capability oracle', () => {
    expect(SRC).toMatch(/enabled: tab === 'worktree-diff' && taskCapabilities\.worktreeDiff/)
    expect(SRC).toMatch(
      /enabled: tab === 'worktree-structure' && taskCapabilities\.worktreeStructure/,
    )
    expect(SRC).not.toMatch(/tab === 'worktree-structure'[\s\S]{0,160}task\.data\.baseCommit/)
    expect(SRC).not.toMatch(/tk\.baseCommit === null/)
  })

  test('late room classification has pending and retryable error states', () => {
    expect(SRC).toMatch(/room\.data !== undefined/)
    expect(SRC).toMatch(/room\.error !== null/)
    expect(SRC).toMatch(/tabResolution\.status === 'pending'/)
    expect(SRC).toMatch(/tabResolution\.status === 'error'/)
    expect(SRC).toMatch(/onClick=\{\(\) => void room\.refetch\(\)\}/)
  })
})

describe('TaskDetailPage i18n key coverage', () => {
  test('zh-CN.ts ships all six tab labels', () => {
    const zh = readFileSync(resolve(import.meta.dirname, '..', 'src/i18n/zh-CN.ts'), 'utf8')
    expect(zh).toMatch(/tabWorkflowStatus:\s*'/)
    expect(zh).toMatch(/tabNodeRuns:\s*'/)
    expect(zh).toMatch(/tabDetails:\s*'/)
    expect(zh).toMatch(/tabOutputs:\s*'/)
    expect(zh).toMatch(/tabWorktreeDiff:\s*'/)
    expect(zh).toMatch(/tabFeedback:\s*'/)
  })

  test('en-US.ts ships all six tab labels', () => {
    const en = readFileSync(resolve(import.meta.dirname, '..', 'src/i18n/en-US.ts'), 'utf8')
    expect(en).toMatch(/tabWorkflowStatus:\s*'/)
    expect(en).toMatch(/tabNodeRuns:\s*'/)
    expect(en).toMatch(/tabDetails:\s*'/)
    expect(en).toMatch(/tabOutputs:\s*'/)
    expect(en).toMatch(/tabWorktreeDiff:\s*'/)
    expect(en).toMatch(/tabFeedback:\s*'/)
  })
})
