// RFC-035 PR2 — source-level guard: the three table sites named in
// design.md §5 MUST render `.data-table` (instead of the legacy bespoke
// classes). The visual is owned by the shared primitive now.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

function read(rel: string): string {
  return readFileSync(path.resolve(SRC, rel), 'utf8')
}

describe('RFC-035 .data-table推广 grep guard', () => {
  test('routes/repos.tsx renders .data-table for its list', () => {
    const body = read('routes/repos.tsx')
    expect(body.includes('className="data-table"')).toBe(true)
    expect(body.includes("<TableViewport label={t('repos.title')}>"), 'responsive wrapper').toBe(
      true,
    )
  })

  test('routes/repos.tsx no longer applies the legacy .repos-table CSS class (data-testid="repos-table" survives as a test anchor)', () => {
    const body = read('routes/repos.tsx')
    // No `className="repos-table…` or `className="…repos-table` survives.
    expect(/className="[^"]*repos-table/.test(body)).toBe(false)
  })

  test('components/AgentImportDialog.tsx uses grouped cards instead of a dense data table', () => {
    const body = read('components/AgentImportDialog.tsx')
    expect(body.includes('data-table data-table--compact')).toBe(false)
    expect(body.includes('className="agent-import__section"')).toBe(true)
  })

  test('routes/reviews.tsx renders .data-table for each task group', () => {
    expect(read('routes/reviews.tsx').includes('className="data-table"')).toBe(true)
  })
})
