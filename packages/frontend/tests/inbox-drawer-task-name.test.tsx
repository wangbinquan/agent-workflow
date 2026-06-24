// RFC-037 T9 — source-layer wiring guard for the inbox drawer + clarify and
// reviews list pages: the joined `taskName` field is rendered alongside the
// existing source-task ID chip. Grep against the .tsx source so future
// refactors that drop the chip turn red.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

function read(rel: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', 'src', rel), 'utf-8')
}

describe('RFC-037 — inbox / clarify / reviews chain renders taskName', () => {
  test('InboxDrawer threads taskName from review and clarify summaries', () => {
    const src = read('components/shell/InboxDrawer.tsx')
    expect(src).toContain('taskName: r.taskName')
    expect(src).toContain('taskName: c.taskName')
    expect(src).toContain('inbox-drawer__task-name')
    expect(src).toContain('inbox-row-task-name')
  })

  test('homepage lib re-exports taskName in InboxPreviewItem', () => {
    const src = read('lib/homepage.ts')
    expect(src).toMatch(/taskName:\s*string/)
    expect(src).toContain('taskName: r.taskName')
    expect(src).toContain('taskName: c.taskName')
  })

  test('/clarify list page renders task name as group heading', () => {
    const src = read('routes/clarify.tsx')
    expect(src).toMatch(/items\[0\]\??\.taskName/)
  })

  test('/reviews list page renders task name as group heading', () => {
    const src = read('routes/reviews.tsx')
    expect(src).toMatch(/g\.taskName/)
  })

  test('/reviews/:id detail H1 prefers taskName', () => {
    const src = read('routes/reviews.detail.tsx')
    expect(src).toMatch(/data\.summary\.taskName/)
  })

  test('/clarify/:id detail surfaces taskName via /api/tasks fetch', () => {
    const src = read('routes/clarify.detail.tsx')
    // 2026-06-24: the task name moved out of a standalone "Task: {name}" muted
    // row and into the H1 itself, as a /tasks/$id link (compact header — the
    // separate row was eating body space). It's still sourced from the
    // /api/tasks fetch (taskQuery) and still carries the clarify-detail-task-name
    // testid, so the feature this test guards (clarify detail surfaces the task
    // name) is intact; only the presentation changed.
    expect(src).toContain('taskQuery.data')
    expect(src).toContain('clarify-detail-task-name')
  })

  test('styles.css declares the inbox-drawer__task-name family', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
    expect(css).toMatch(/\.inbox-drawer__task-name/)
  })
})
