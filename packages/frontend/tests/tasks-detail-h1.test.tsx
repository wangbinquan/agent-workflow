// RFC-037 T8 — locks the detail page heading swap: H1 displays the task
// name; the ULID drops into a labelled `<code>` subtitle. Source-level grep
// so future refactors that wire the H1 back to `tk.id` go red immediately.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)

describe('routes/tasks.detail.tsx — RFC-037 H1 swap', () => {
  test('H1 renders tk.name (not tk.id as before)', () => {
    expect(SRC).toMatch(/<PageHeader\b[\s\S]*?title=\{/)
    expect(SRC).toMatch(/task-detail__name[\s\S]*?\{tk\.name\}/)
    expect(SRC).not.toMatch(/<h1[^>]*task-detail__title/)
  })

  test('ID drops into a labelled subtitle (task-detail__id) with the full ULID', () => {
    expect(SRC).toMatch(/task-detail__id[\s\S]*?<code>\{tk\.id\}<\/code>/)
    expect(SRC).toContain("t('tasks.detailTitleIdLabel')")
  })

  test('TaskStatusChip still renders inline with the name (no orphaned chip)', () => {
    expect(SRC).toMatch(/task-detail__title[\s\S]*?TaskStatusChip/)
  })

  test('styles.css carries the .task-detail__title family', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
    expect(css).toMatch(/\.task-detail__title/)
    expect(css).toMatch(/\.task-detail__name/)
    expect(css).toMatch(/\.task-detail__id\s*\{/)
  })
})
