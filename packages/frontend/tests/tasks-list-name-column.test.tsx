// RFC-037 T7 — locks the Linear-style first column on /tasks: task name is
// the primary identifier, the ULID drops into a muted subtitle inside the
// same cell. Rendered against a stub `useQuery` so we don't need the real
// HTTP stack.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')

describe('routes/tasks.tsx — RFC-037 Linear-style first column', () => {
  test('the name column header is t("tasks.colName") (no colId header)', () => {
    // RFC-192 column order: Status → Name → Subject → Repo → Started →
    // Duration (status leads the monitor scan). The ID column header
    // (`tasks.colId`) stays gone — the ULID lives in the name-cell subtitle.
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

  test('Subject / Status / Started / Repo / Duration columns present (RFC-192 set)', () => {
    expect(SRC).toContain("t('tasks.colSubject')")
    expect(SRC).toContain("t('tasks.colStatus')")
    expect(SRC).toContain("t('tasks.colStarted')")
    expect(SRC).toContain("t('tasks.colRepo')")
    expect(SRC).toContain("t('tasks.colDuration')")
    // The always-on Error column retired with RFC-192 — locked in
    // tasks-list-error-column-single-line.test.ts.
    expect(SRC).not.toContain("t('tasks.colError')")
  })

  test('styles.css declares the .task-name-cell layout family', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
    // The flex column sits on the inner wrapper, not the <td> — see
    // tasks-list-name-cell-row-alignment.test.ts for why that must hold.
    expect(css).toMatch(/\.task-name-cell__inner\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.task-name-cell__name/)
    expect(css).toMatch(/\.task-name-cell__id/)
  })
})
