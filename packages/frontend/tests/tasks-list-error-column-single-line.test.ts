// RFC-192 — locks the /tasks error-line surgery that RETIRED the always-on
// Error column (this file's predecessor lock covered that column's
// single-line `.data-table__clip` truncation; see git history).
//
// The error summary now renders INSIDE the name cell, on FAILED rows only:
//   - `.task-name-cell__error` is single-line (cap + ellipsis — the old
//     column's 360px clip semantics carried over) with the full text on
//     `title`, so multi-line stack traces can never balloon the row again;
//   - the render predicate includes `status === 'failed'` — canceled /
//     interrupted rows also carry non-null summaries ("canceled by user",
//     "daemon-shutdown") that are notes, not errors (Codex 设计门 P2);
//   - the standalone Error <th>/<td> is gone from the list (the detail page
//     keeps its own error surfaces and `tasks.colError` key).
//
// Source-text assertions per CLAUDE.md's test-with-every-change rule;
// behavioral coverage lives in tasks-list-surgery.test.tsx.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')
const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')

describe('routes/tasks.tsx — failed-row error line (Error column retired)', () => {
  test('the error line is gated on failed status AND a non-null summary', () => {
    expect(SRC).toMatch(/row\.status === 'failed' && row\.errorSummary != null/)
  })

  test('the error span carries the full text as a hover title', () => {
    expect(SRC).toMatch(/className="task-name-cell__error"\s*\n?\s*title=\{row\.errorSummary\}/)
  })

  test('the always-on Error column is gone from the list table', () => {
    expect(SRC).not.toContain("t('tasks.colError')")
    expect(SRC).not.toContain('data-table__clip')
  })

  test('.task-name-cell__error is single-line capped with ellipsis (row height stays bounded)', () => {
    const block = CSS.match(/\.task-name-cell__error\s*\{[^}]*\}/)
    expect(block, '.task-name-cell__error rule must exist').not.toBeNull()
    expect(block![0]).toMatch(/max-width:\s*360px/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
    expect(block![0]).toMatch(/text-overflow:\s*ellipsis/)
    expect(block![0]).toMatch(/color:\s*var\(--danger\)/)
  })
})
