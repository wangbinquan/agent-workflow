// Regression: a fixed-height flex-column file list needs `overflow-y:auto` on
// the scroll container + `flex-shrink:0` on each row, or many files get
// crushed below their text height and render VERTICALLY CLIPPED (a ~14px row
// over 12px text). First surfaced on the pre-RFC-239 worktree-diff list; the
// merged changes sidebar inherits the identical nesting and the same guard.

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
describe.each([['.changes__sidebar', '.changes__file-row']])(
  '%s does not crush its rows',
  (listSel, itemSel) => {
    test(`${listSel} scrolls (overflow-y) instead of shrinking rows`, () => {
      expect(block(listSel)).toMatch(/overflow-y:\s*auto/)
    })
    test(`${itemSel} refuses to flex-shrink`, () => {
      expect(block(itemSel)).toMatch(/flex-shrink:\s*0/)
    })
  },
)
