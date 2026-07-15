// Locks in that the per-task feedback area lives inside its own tab pane on
// the task detail page, not as a fixed footer panel below the panes.
//
// Why this exists: the task-detail page is
// `display:flex; flex-direction:column; height:100%; overflow:hidden`, with
// `.task-detail__panes` at `flex:1; min-height:0` and (previously) a
// `<TaskFeedbackList>` rendered as a sibling AFTER the panes. When the
// feedback thread grew, the flex algorithm shrunk the panes (which CAN
// shrink to 0 thanks to `min-height:0`) instead of the unbounded feedback
// section, and the task area disappeared entirely. User-reported
// regression: "留言多了之后会挤占上方任务区空间，导致任务区已经看不到东西了"
// + "放到任务详情里的一个 tab 页签里吧".
//
// The fix: promote feedback to its own `feedback` tab so it shares the
// panes' bounded scroll track with every other section.
//
// Source-text assertions per CLAUDE.md's test-with-every-change rule.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)

describe('routes/tasks.detail.tsx — feedback lives in its own tab pane', () => {
  test('TaskFeedbackList is rendered inside a `.task-detail__pane` gated by `tab === feedback`', () => {
    // The pane wraps the feedback list and is hidden unless the feedback
    // tab is selected. Locking the regex here so a future refactor can't
    // re-promote the list outside the panes track without tripping the test.
    // (RFC-099 follow-up: the members panel moved to a header dialog button
    // for uniformity with the resource pages — the pane holds ONLY the
    // feedback list again, restoring the original lock.)
    expect(SRC).toMatch(
      /hidden=\{tab !== 'feedback'\}\s*>\s*\n\s*<TaskFeedbackList taskId=\{id\} \/>/,
    )
  })

  test('there is exactly one <TaskFeedbackList /> render and it sits BEFORE the closing panes div', () => {
    // Belt-and-suspenders: a stray copy of the old footer-positioned
    // `<TaskFeedbackList>` would re-introduce the squeeze. We assert both
    // the count and that its index is before the `</div>` that closes
    // `.task-detail__panes`.
    const matches = SRC.match(/<TaskFeedbackList\b/g) ?? []
    expect(matches.length).toBe(1)

    const panesOpen = SRC.indexOf('className="task-detail__panes"')
    const panesClose = SRC.indexOf(
      '</div>',
      // First `</div>` after the LAST top-level pane. Find by walking from
      // panesOpen and tracking nesting would be overkill — instead, locate
      // the unique sibling that used to host the footer panel. The new
      // structure has NO sibling between `</div>` (panes wrapper close) and
      // the page root close, so we just check that the feedback render
      // appears before the page root's terminator pattern.
      panesOpen,
    )
    const feedback = SRC.indexOf('<TaskFeedbackList')
    expect(panesOpen).toBeGreaterThanOrEqual(0)
    expect(panesClose).toBeGreaterThan(panesOpen)
    expect(feedback).toBeGreaterThan(panesOpen)
    // The feedback render must be inside the panes block, not after it.
    // We assert this by counting how many top-level `<div>` opens precede
    // the feedback render starting from panesOpen.
    const between = SRC.slice(panesOpen, feedback)
    const opens = (between.match(/<div\b/g) ?? []).length
    const closes = (between.match(/<\/div>/g) ?? []).length
    expect(opens).toBeGreaterThan(closes) // still inside an open <div> block
  })
})
