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

describe('worktree-diff file list does not crush rows', () => {
  test('the tab list scrolls (overflow-y) instead of shrinking rows', () => {
    expect(block('.worktree-diff__tablist')).toMatch(/overflow-y:\s*auto/)
  })
  test('each file tab refuses to flex-shrink', () => {
    expect(block('.worktree-diff__file-tab')).toMatch(/flex-shrink:\s*0/)
  })
})
