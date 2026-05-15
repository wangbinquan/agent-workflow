// Locks in that .page no longer caps content width on wide displays.
//
// Before: `.page { max-width: 960px }` and `.page--wide { max-width: 1200px }`
// left a large empty band on the right side of every list/detail/form route
// when the viewport was wider than the cap. Users complained the UI didn't
// fill the available width. We removed both caps so pages flow to the full
// width of `.content`. Onboarding is the one exception: long prose still
// wants a readable line length, so `.onboarding` carries its own cap.
//
// Source-code-level fallback per CLAUDE.md "Test-with-every-change":
// JSDOM can't evaluate computed layout, so we assert directly on the
// stylesheet text. If a future refactor reintroduces a max-width on `.page`
// or drops the onboarding override, this test fails immediately.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')

function ruleBody(selector: string, css: string): string {
  // Match `selector { ... }` exactly — anchor the selector with a leading
  // boundary so `.page` doesn't accidentally pick up `.page--wide` etc.
  const re = new RegExp(`(?:^|\\n|\\})\\s*${selector.replace(/[.\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)
  const m = css.match(re)
  const body = m?.[1]
  if (body === undefined) throw new Error(`selector not found: ${selector}`)
  return body
}

describe('pages fill the full content width', () => {
  test('.page does not impose a max-width', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    const body = ruleBody('.page', css)
    expect(body).not.toMatch(/max-width\s*:/)
  })

  test('.page--wide does not impose a max-width', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    const body = ruleBody('.page--wide', css)
    expect(body).not.toMatch(/max-width\s*:/)
  })

  test('.onboarding keeps a narrow column for prose readability', () => {
    // Without this override, removing the global `.page` cap would let
    // onboarding text run edge-to-edge on a 27" monitor.
    const css = readFileSync(STYLES_CSS, 'utf8')
    const body = ruleBody('.onboarding', css)
    expect(body).toMatch(/max-width\s*:\s*\d+px/)
  })
})
