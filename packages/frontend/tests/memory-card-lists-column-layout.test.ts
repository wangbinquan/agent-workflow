// Regression: the memory card lists must stack VERTICALLY.
//
// Reported 2026-09-21 — on /memory 「按维度」 every card sat side by side and,
// once a scope held more than a handful of memories, the row ran off the right
// edge of the screen.
//
// Cause was a CSS selector-list splice, not a layout decision. RFC-041 shipped
// one shared rule for the three card lists:
//
//     .memory-by-scope__list,
//     .memory-scoped-list,
//     .memory-all-list { list-style:none; padding:0; margin:0;
//                        display:flex; flex-direction:column; gap:… }
//
// RFC-352 T8 (eb8b331db) added the paginator footer by inserting
// `.memory-all-list__more { display:flex; justify-content:center;
// padding:10px 22px; border-top:… }` between the 2nd and 3rd selector. A CSS
// selector list terminates at the first `{`, so the footer rule swallowed
// `.memory-by-scope__list` and `.memory-scoped-list`: both lists lost
// `flex-direction: column` (falling back to `row`), lost their list reset, and
// gained a stray top border — while `.memory-all-list` (the 「已审批」 tab, and
// the only list the pagination work exercised) kept the original rule and so
// still looked right. That is why the break went unnoticed.
//
// The lists are `<ul>`s of `<li class="memory-row">` cards rendered by
// MemoryByScopeBrowser / MemoryScopedList / MemoryAllList. jsdom does no
// layout (and vitest runs with css:false), so this is a source-level guard, in
// the style of memory-tag-nowrap.test.ts.
//
// The helper deliberately resolves a rule by SELECTOR-LIST MEMBERSHIP rather
// than by `indexOf('<selector> {')`: the latter is blind to exactly this bug,
// because a spliced-away selector no longer precedes any `{`.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
// Comments are stripped up front: they are not selectors, and a `{` inside one
// would otherwise look like a rule opening to the brace scan below.
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

interface Rule {
  selectors: string[]
  body: string
}

/** Every rule whose selector list contains `selector` as an exact member. */
function rulesFor(selector: string): Rule[] {
  const out: Rule[] = []
  let cursor = 0
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor)
    if (open === -1) break
    const close = css.indexOf('}', open)
    if (close === -1) break
    const preludeStart = Math.max(
      css.lastIndexOf('}', open),
      css.lastIndexOf('{', open - 1),
      css.lastIndexOf(';', open),
      0,
    )
    const selectors = css
      .slice(preludeStart, open)
      .replace(/^[}{;]/, '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (selectors.includes(selector)) out.push({ selectors, body: css.slice(open + 1, close) })
    cursor = open + 1
  }
  return out
}

const CARD_LISTS = ['.memory-by-scope__list', '.memory-scoped-list', '.memory-all-list']

describe('memory card lists stack vertically', () => {
  test.each(CARD_LISTS)('%s is a reset column list, so cards never run off screen', (selector) => {
    const rules = rulesFor(selector)
    expect(rules.length, `${selector} must be styled by at least one rule`).toBeGreaterThan(0)
    const body = rules.map((r) => r.body).join('\n')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
    expect(body).toMatch(/list-style:\s*none/)
    expect(body).toMatch(/padding:\s*0/)
    expect(body).toMatch(/margin:\s*0/)
  })

  test('the paginator footer styles only itself, never the lists above it', () => {
    const footers = rulesFor('.memory-all-list__more')
    expect(footers.length, 'the paginator footer must be its own rule').toBe(1)
    expect(footers[0]!.selectors).toEqual(['.memory-all-list__more'])
    expect(footers[0]!.body).toMatch(/justify-content:\s*center/)
  })
})
