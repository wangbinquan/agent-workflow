// Locks BOTH sides of the `.tabs--segment` overflow contract:
//
//   1. /auth is a full-width, single-row control. RFC-221 makes ready mode a
//      closed two-option set (SSO/password), while bootstrap has no picker at
//      all. Labels therefore stay on one line and ellipsize instead of forming
//      narrow, two-line tabs at 390px.
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
  it('the auth-page picker fills the card and keeps method labels on one line', () => {
    const viewportBody = ruleBody('.auth-page__method-picker .tabs-viewport--segment,')
    expect(viewportBody).toMatch(/width:\s*100%/)

    const body = ruleBody('.auth-page .tabs--segment {')
    expect(body).toMatch(/flex-wrap:\s*nowrap/)

    const textBody = ruleBody('.auth-page__method-tab-text {')
    expect(textBody).toMatch(/white-space:\s*nowrap/)
    expect(textBody).toMatch(/overflow:\s*hidden/)
    expect(textBody).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('the base variant does NOT wrap — RFC-219 picker keeps scroll + arrows', () => {
    const body = ruleBody('.tabs--segment {')
    expect(body).not.toMatch(/flex-wrap/)
    expect(body).toMatch(/gap:\s*0/)
  })

  it('the responsive auth shell keeps its brand row compact instead of stretching blank space', () => {
    const authBase = css.indexOf('.auth-experience {')
    const media = css.slice(css.indexOf('@media (max-width: 56rem)', authBase))
    const body = media.slice(
      media.indexOf('.auth-experience {') + '.auth-experience {'.length,
      media.indexOf('}', media.indexOf('.auth-experience {')),
    )
    expect(body).toMatch(/grid-template-rows:\s*auto minmax\(0,\s*1fr\)/)
    expect(body).toMatch(/align-content:\s*start/)
  })
})
