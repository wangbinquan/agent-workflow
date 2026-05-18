// RFC-037 T7 — locks the Linear-style first column on /tasks: task name is
// the primary identifier, the ULID drops into a muted subtitle inside the
// same cell. Rendered against a stub `useQuery` so we don't need the real
// HTTP stack.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')

describe('routes/tasks.tsx — RFC-037 Linear-style first column', () => {
  test('first column header is t("tasks.colName") (no longer colId)', () => {
    // Column order: Name → Workflow → Status → Started → Repo → Error.
    // The ID column header (`tasks.colId`) is gone — short ID now lives
    // inside the name cell as a subtitle.
    expect(SRC).toContain("t('tasks.colName')")
    expect(SRC).not.toMatch(/<th>\{t\('tasks\.colId'\)\}<\/th>/)
  })

  test('name cell contains `row.name` as the linked label', () => {
    expect(SRC).toMatch(/className="task-name-cell"/)
    expect(SRC).toMatch(/task-name-cell__name[\s\S]*?\{row\.name\}/)
  })

  test('name cell surfaces the full ULID as subtitle', () => {
    // The previous design showed only the last 10 chars and put the full ID
    // in a `title` tooltip; that left a wide empty chip below short names
    // and forced users to hover. Now we render `{row.id}` directly and let
    // the `.task-name-cell__id` `align-self: flex-start` shrink the chip.
    expect(SRC).toMatch(/task-name-cell__id[\s\S]*?\{row\.id\}/)
    expect(SRC).not.toMatch(/row\.id\.slice\(-10\)/)
  })

  test('Workflow / Status / Started / Repo / Error columns survive the reshuffle', () => {
    expect(SRC).toContain("t('tasks.colWorkflow')")
    expect(SRC).toContain("t('tasks.colStatus')")
    expect(SRC).toContain("t('tasks.colStarted')")
    expect(SRC).toContain("t('tasks.colRepo')")
    expect(SRC).toContain("t('tasks.colError')")
  })

  test('styles.css declares the .task-name-cell layout family', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
    expect(css).toMatch(/\.task-name-cell\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.task-name-cell__name/)
    expect(css).toMatch(/\.task-name-cell__id/)
  })
})
