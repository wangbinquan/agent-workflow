// Locks in the visual fix that turned the Reviews-nav pending-count
// indicator from bare inline text into a pill/bubble badge. The
// component already renders `<span class="sidebar__badge">N</span>`,
// but the matching CSS rule didn't exist, so the count rendered as
// plain text glued to the link label. If a future refactor drops the
// `.sidebar__badge` rule or strips its pill-shaping declarations,
// this test fails.
//
// Source-code-level fallback per CLAUDE.md "Test-with-every-change":
// JSDOM can't evaluate computed layout, so we assert the contract on
// the stylesheet text directly. Paired with the existing __root.tsx
// markup that emits `<span class="sidebar__badge">`.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const ROOT_TSX = resolve(__dirname, '..', 'src', 'routes', '__root.tsx')

describe('sidebar pending-review badge renders as a bubble', () => {
  test('styles.css declares a .sidebar__badge rule', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.sidebar__badge\s*\{/)
  })

  test('.sidebar__badge is pill-shaped with the danger color', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    // Grab the rule body so we don't accidentally match a different selector.
    const match = css.match(/\.sidebar__badge\s*\{([^}]*)\}/)
    expect(match).not.toBeNull()
    const body = match![1]
    // Fully rounded → pill / bubble.
    expect(body).toMatch(/border-radius:\s*999px/)
    // Filled with the danger token (count is an attention-grabber).
    expect(body).toMatch(/background:\s*var\(--danger\)/)
    // White text on the filled pill.
    expect(body).toMatch(/color:\s*#fff/)
    // Min-width keeps single-digit counts circular instead of squished.
    expect(body).toMatch(/min-width:\s*\d+px/)
  })

  test('.sidebar__link is a flex row so the badge sits at the right edge', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    const match = css.match(/\.sidebar__link\s*\{([^}]*)\}/)
    expect(match).not.toBeNull()
    const body = match![1]
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/justify-content:\s*space-between/)
    expect(body).toMatch(/align-items:\s*center/)
  })

  test('active-link variant inverts the badge so it stays readable on the accent fill', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.sidebar__link--active\s+\.sidebar__badge\s*\{/)
  })

  test('__root.tsx still emits <span class="sidebar__badge"> for the pending count', () => {
    const tsx = readFileSync(ROOT_TSX, 'utf8')
    expect(tsx).toContain('sidebar__badge')
    // Counts above 99 must collapse to "99+" so the pill keeps a sane width.
    expect(tsx).toMatch(/pendingCount\s*>\s*99\s*\?\s*'99\+'/)
  })
})
