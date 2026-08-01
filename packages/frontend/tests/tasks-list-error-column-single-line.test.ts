// RFC-244 — failure diagnostics occupy one bounded execution-detail line.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')
const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')

describe('routes/tasks.tsx — bounded failure detail', () => {
  test('failed status delegates to the shared failure descriptor', () => {
    expect(SRC).toMatch(/if \(item\.status === 'failed'\)[\s\S]*?describeTaskFailure\(\{/)
    expect(SRC).toContain('failureCode: item.failureCode ?? null')
  })

  test('the detail span exposes the complete diagnostic in a title', () => {
    expect(SRC).toMatch(
      /className="task-operations__detail"\s+title=\{detail\.title\}[\s\S]*?\{detail\.text\}/,
    )
    expect(SRC).toContain('title: item.errorSummary ?? failure.title')
  })

  test('the retired standalone Error column does not return', () => {
    expect(SRC).not.toContain("t('tasks.colError')")
    expect(SRC).not.toContain('data-table__clip')
  })

  test('execution detail remains single-line and ellipsized on desktop', () => {
    const block = CSS.match(/\.task-operations__detail\s*\{[^}]*\}/)
    expect(block).not.toBeNull()
    expect(block![0]).toMatch(/overflow:\s*hidden/)
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
    expect(block![0]).toMatch(/text-overflow:\s*ellipsis/)
  })
})
