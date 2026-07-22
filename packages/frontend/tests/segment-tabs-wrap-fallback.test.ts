// Locks BOTH sides of the `.tabs--segment` overflow contract:
//
//   1. /auth scope WRAPS — user report 2026-07-22: the English method labels
//      were wider than the 420px auth card, so TabBar's overflow affordance
//      kicked in: two 44px ‹ › arrow buttons crowded the login card and hid
//      "Token sign-in" entirely behind a horizontal scroll. A login method
//      picker is a closed 2-3 option set; its structural fallback is
//      flex-wrap, which also means TabBar's overflow detection never mounts
//      the arrows there.
//   2. The BASE variant keeps scroll-with-arrows — RFC-219 contracts the
//      workflow node picker's category strip to internal horizontal scroll +
//      arrow affordance at the 240px editor rail (proposal §UX "窄栏分类条允许
//      内部横向滚动并显示现有左右滚动 affordance", design §196), and
//      e2e/workflow-editor.spec.ts asserts scrollWidth > clientWidth for it.
//      A global wrap on the variant silently broke that (caught by Codex
//      review + the editor visual-regression scenes going red, 2026-07-22).
//
// jsdom does no layout, so these are source-level assertions against
// styles.css (same ruleBody() idiom as focus-ring-inset.test.ts). The
// companion rendered locks for /auth default-tab behavior live in
// auth-form-tabs.test.tsx.
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

describe('.tabs--segment overflow contract', () => {
  it('the auth-page scope wraps so no sign-in method can hide behind arrows', () => {
    const body = ruleBody('.auth-page .tabs--segment {')
    expect(body).toMatch(/flex-wrap:\s*wrap/)
    // Rows must not touch once wrapping engages; column gap stays 0 so the
    // single-row rendering is pixel-identical to the base variant.
    expect(body).toMatch(/gap:\s*2px 0/)
  })

  it('the base variant does NOT wrap — RFC-219 picker keeps scroll + arrows', () => {
    const body = ruleBody('.tabs--segment {')
    expect(body).not.toMatch(/flex-wrap/)
    expect(body).toMatch(/gap:\s*0/)
  })
})
