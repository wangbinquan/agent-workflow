// Locks the overflow degradation of the `.tabs--segment` variant: WRAP, never
// the 44px viewport scroll arrows.
//
// Regression this guards (user report 2026-07-22): on the English /auth page
// the three method labels ("Username & password" / "Identity provider" /
// "Token sign-in") were wider than the 420px auth card, so TabBar's overflow
// affordance kicked in — two 44px ‹ › arrow buttons crowded the login card and
// hid "Token sign-in" entirely behind a horizontal scroll. Scroll-with-arrows
// is page-tab-strip chrome (RFC-206); a segmented control is a small closed
// set of options that must all stay visible, so its structural fallback is
// flex-wrap. With wrap in place the tablist can never horizontally overflow,
// which also means TabBar's overflow detection never mounts the arrows.
//
// jsdom does no layout, so this is a source-level assertion against styles.css
// (same ruleBody() idiom as focus-ring-inset.test.ts). The companion rendered
// locks for /auth default-tab behavior live in auth-form-tabs.test.tsx.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const rawCss = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

// Strip comments first so prose can never satisfy (or truncate) a match.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

/** Body of the first rule whose selector contains `selector`. */
function ruleBody(selector: string): string {
  const idx = css.indexOf(selector)
  expect(idx, `selector ${selector} not found`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('.tabs--segment overflow fallback', () => {
  it('wraps instead of scrolling so no option can hide behind arrows', () => {
    const body = ruleBody('.tabs--segment {')
    expect(body).toMatch(/flex-wrap:\s*wrap/)
    // Rows must not touch once wrapping engages; column gap stays 0 so the
    // single-row rendering is pixel-identical to the pre-fix control.
    expect(body).toMatch(/gap:\s*2px 0/)
  })
})
