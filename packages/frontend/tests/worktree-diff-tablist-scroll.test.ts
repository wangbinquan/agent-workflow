// Regression: the worktree-diff file list (`.worktree-diff__tablist`) is a
// fixed-height flex column. Without `overflow-y:auto` on the list + `flex-shrink:0`
// on each `.worktree-diff__file-tab`, many files get crushed below their text
// height and the names render VERTICALLY CLIPPED (a ~14px row over 12px text).
// This locks the two declarations that keep the list scrollable + readable.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

const block = (selector: string): string => {
  const start = css.indexOf(`${selector} {`)
  return start >= 0 ? css.slice(start, css.indexOf('}', start)) : ''
}

// Both feature-specific file lists share the SAME flex-column tablist pattern,
// so both need the SAME guard (worktree-diff is where it first surfaced; the
// structure tree has the identical nesting). RFC-021 (Q5) wrapped each
// worktree-diff file tab in a `.worktree-diff__file-row` (viewed-checkbox +
// tab), so the ROW is now the flex-column child that must refuse to shrink.
describe.each([
  ['.worktree-diff__tablist', '.worktree-diff__file-row'],
  ['.structure__tablist', '.structure__file-tab'],
])('%s does not crush its rows', (listSel, itemSel) => {
  test(`${listSel} scrolls (overflow-y) instead of shrinking rows`, () => {
    expect(block(listSel)).toMatch(/overflow-y:\s*auto/)
  })
  test(`${itemSel} refuses to flex-shrink`, () => {
    expect(block(itemSel)).toMatch(/flex-shrink:\s*0/)
  })
})
