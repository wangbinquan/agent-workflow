// RFC-023 bugfix #4 — UX styling guard. The QuestionForm now leans on the
// .clarify-option / .is-checked / .clarify-question__custom.is-active CSS
// rules for its card-shaped appearance and full-row clickability. JSDOM
// doesn't apply external stylesheets, so the only way to lock the visual
// contract without Playwright is a source-level assertion that the rules
// exist + cover the states the component emits. If a rule gets accidentally
// stripped, the form falls back to ugly defaults (the original reason this
// bugfix was filed).

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')

describe('RFC-023 bugfix #4 — clarify question form CSS contract', () => {
  test('styles.css declares the card-shaped option row + checked state + hover', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    // Base option card.
    expect(css).toMatch(/\.clarify-option\s*\{/)
    // Hover affordance — full row clickable cue.
    expect(css).toContain('.clarify-option:hover')
    // Checked / selected state — high-contrast accent.
    expect(css).toContain('.clarify-option.is-checked')
    // Digit chip styling.
    expect(css).toContain('.clarify-option__digit')
    // Custom row visual differentiation.
    expect(css).toContain('.clarify-option--custom')
  })

  test('styles.css declares the custom textarea container with active toggle', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.clarify-question__custom\s*\{/)
    expect(css).toContain('.clarify-question__custom.is-active')
    expect(css).toContain('.clarify-custom-input')
  })

  test('styles.css declares friendly labels for the agent-side clarify system ports', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    // The agent renders `__clarify__` / `__clarify_response__` as normal
    // port rows; the CSS pseudo-element swaps the noisy system name for a
    // human-readable badge so the channel reads cleanly on the canvas.
    expect(css).toContain("title='__clarify__'")
    expect(css).toContain("title='__clarify_response__'")
  })

  // The submit button used to ship as `class="button button--primary"` but
  // there are no `.button*` rules in styles.css (only `.btn` / `.btn--primary`),
  // so it rendered as an ugly default-grey button. Lock it to the shared
  // `.btn .btn--primary` styling so a future refactor can't quietly regress it.
  test('clarify-detail submit button uses the shared .btn .btn--primary class', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'routes', 'clarify.detail.tsx'),
      'utf8',
    )
    expect(src).toContain('className="btn btn--primary"')
    expect(src).not.toContain('"button button--primary"')
    const css = readFileSync(STYLES_CSS, 'utf8')
    // The footer rule must follow the className, otherwise margin-left:auto
    // (which pushes the submit to the right) silently breaks.
    expect(css).toContain('.clarify-detail__footer .btn {')
    // Sanity: .btn--primary exists and uses the accent color (blue).
    expect(css).toMatch(/\.btn--primary\s*\{[^}]*var\(--accent\)/)
  })
})
