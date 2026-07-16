// Regression: at 721-1080px the resource split used to stack the list above
// the active detail. The list's intrinsic row consumed most of a short laptop
// viewport, leaving the Agent Prompt textarea only one or two lines tall while
// the 200px preview overflowed behind an overflow:hidden panel. Compact split
// layouts must therefore use the existing route-owned list/detail mode at the
// 1080px breakpoint, not keep both panes in the same vertical grid.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const STYLES = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function mediaBody(maxWidth: number): string {
  const marker = `@media (max-width: ${maxWidth}px)`
  const start = STYLES.indexOf(marker)
  if (start < 0) throw new Error(`${marker} not found in styles.css`)
  const open = STYLES.indexOf('{', start)
  let depth = 0
  for (let i = open; i < STYLES.length; i += 1) {
    if (STYLES[i] === '{') depth += 1
    if (STYLES[i] !== '}') continue
    depth -= 1
    if (depth === 0) return STYLES.slice(open + 1, i)
  }
  throw new Error(`${marker} is not closed`)
}

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  if (match === null) throw new Error(`rule ${selector} not found`)
  return match[1] ?? ''
}

describe('Agent Prompt compact-viewport height', () => {
  const compact = mediaBody(1080)

  test('1080px split shows only the route-owned list or detail pane', () => {
    expect(compact).toMatch(
      /\.page--split\[data-mobile-view='list'\] \.split__detail,\s*\.page--split\[data-mobile-view='detail'\] \.split__list\s*\{[^}]*display:\s*none/,
    )
  })

  test('the visible pane owns the full compact split track', () => {
    const split = ruleBody(compact, '.page--split[data-mobile-view] .split')
    expect(split).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/)

    const detail = ruleBody(compact, '.page--split[data-mobile-view] .split__detail')
    expect(detail).toMatch(/height:\s*100%/)
  })

  test('detail keeps one visible, keyboard-focusable return-to-list affordance', () => {
    const back = ruleBody(compact, '.page--split[data-mobile-view] .split__mobile-back')
    expect(back).toMatch(/display:\s*inline-flex/)
    expect(compact).toMatch(/\.split__mobile-back:focus-visible\s*\{[^}]*outline:/)

    // The former 720px block must not keep a second copy that can drift from
    // the promoted 1080px compact contract.
    expect(STYLES.match(/\.page--split\[data-mobile-view='list'\] \.split__detail/g)).toHaveLength(
      1,
    )
    expect(STYLES.match(/\.split__mobile-back:focus-visible/g)).toHaveLength(1)
  })

  test('split consumers without route-owned pane state keep both panes reachable', () => {
    const split = ruleBody(compact, '.split')
    expect(split).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(split).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/)

    const list = ruleBody(compact, '.split__list')
    expect(list).toMatch(/border-bottom:\s*1px solid var\(--border\)/)
    expect(list).not.toMatch(/height:\s*100%/)

    const cards = ruleBody(compact, '.split__cards')
    expect(cards).toMatch(/max-height:\s*15rem/)
  })
})
