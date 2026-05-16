// RFC-021: source-level locks on how `tasks.detail.tsx` wires the tab
// layout. We deliberately don't do a full RTL render of TaskDetailPage —
// that route reads from tanstack-router's `Route.useParams()`, runs four
// `useQuery`s, two `useMutation`s, and `useTaskSync` (WS), so a full
// integration render would need a wall of mocks and would still fail to
// exercise xyflow inside jsdom.
//
// What this file *does* lock: the structural invariants that make the
// tabs actually tabs — five distinct `hidden={tab !== 'X'}` panes, a
// tab-bar with all five labels, and the jumpToFailed handler that
// switches tab synchronously with the node-run selection. Pure-function
// branches (TAB_ORDER / availableTabs / nextTabForFailedJump) are
// covered by tests/task-detail-tabs.test.ts.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src/routes/tasks.detail.tsx'), 'utf8')

describe('TaskDetailPage tab structure', () => {
  test('page root uses .page--task-detail (viewport lock anchor)', () => {
    expect(SRC).toMatch(/className="page page--task-detail"/)
    expect(SRC).not.toMatch(/className="page page--wide"/)
  })

  test('renders a tab bar with role="tablist" + .task-detail__tab-bar', () => {
    expect(SRC).toMatch(/role="tablist"/)
    expect(SRC).toMatch(/className="task-detail__tab-bar tabs"/)
  })

  test('renders five panes keyed by `hidden={tab !== ...}` (one per TaskDetailTab)', () => {
    const tabs = ['workflow-status', 'node-runs', 'details', 'outputs', 'worktree-diff']
    for (const k of tabs) {
      expect(SRC).toMatch(new RegExp(`hidden=\\{tab !== '${k}'\\}`))
    }
  })

  test('outputs pane is gated on hasOutputs so an empty tab never shows up', () => {
    // `availableTabs` filters the tab bar; this guard makes sure the
    // pane DOM also stays absent when there are no output ports.
    expect(SRC).toMatch(/\{hasOutputs && \(/)
  })

  test('jumpToFailed uses nextTabForFailedJump and applies BOTH state mutations', () => {
    // Catches a future refactor that only updates selectedNodeRunId
    // (then the tab stays on whatever the user was browsing) or only
    // setTab (then the drawer never opens).
    expect(SRC).toMatch(/nextTabForFailedJump\(/)
    expect(SRC).toMatch(/setSelectedNodeRunId\(runId\)/)
    expect(SRC).toMatch(/setTab\(next\)/)
  })

  test('uses WorktreeDiffPanel (not the legacy DiffViewer) on the diff pane', () => {
    expect(SRC).toMatch(/<WorktreeDiffPanel\b/)
    expect(SRC).not.toMatch(/<DiffViewer\b/)
  })

  test('emits all five tab i18n labels via the tabLabel switch', () => {
    for (const key of [
      'tabWorkflowStatus',
      'tabNodeRuns',
      'tabDetails',
      'tabOutputs',
      'tabWorktreeDiff',
    ]) {
      expect(SRC).toMatch(new RegExp(`'tasks\\.${key}'`))
    }
  })

  test('every pane sits inside .task-detail__panes (overflow container)', () => {
    // Counts panes vs occurrences of the panes wrapper — the wrapper
    // should appear exactly once and contain every `.task-detail__pane`.
    const paneCount = (SRC.match(/className="task-detail__pane"/g) ?? []).length
    expect(paneCount).toBe(5)
    expect(SRC.match(/className="task-detail__panes"/g)?.length).toBe(1)
  })
})

describe('TaskDetailPage i18n key coverage', () => {
  test('zh-CN.ts ships all five tab labels', () => {
    const zh = readFileSync(resolve(import.meta.dirname, '..', 'src/i18n/zh-CN.ts'), 'utf8')
    expect(zh).toMatch(/tabWorkflowStatus:\s*'/)
    expect(zh).toMatch(/tabNodeRuns:\s*'/)
    expect(zh).toMatch(/tabDetails:\s*'/)
    expect(zh).toMatch(/tabOutputs:\s*'/)
    expect(zh).toMatch(/tabWorktreeDiff:\s*'/)
  })

  test('en-US.ts ships all five tab labels', () => {
    const en = readFileSync(resolve(import.meta.dirname, '..', 'src/i18n/en-US.ts'), 'utf8')
    expect(en).toMatch(/tabWorkflowStatus:\s*'/)
    expect(en).toMatch(/tabNodeRuns:\s*'/)
    expect(en).toMatch(/tabDetails:\s*'/)
    expect(en).toMatch(/tabOutputs:\s*'/)
    expect(en).toMatch(/tabWorktreeDiff:\s*'/)
  })
})
