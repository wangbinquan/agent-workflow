// Locks in the visual fix that turned the pending-count indicator from
// bare inline text into a pill/bubble badge.
//
// RFC-005 first introduced the badge inside __root.tsx's reviews nav row.
// RFC-032 PR2 lifted reviews + clarify into the unified inbox footer
// button, so the badge markup now lives in InboxFooterButton.tsx. The
// CSS contract is unchanged — same class, same pill shape, same `99+`
// cap on the count — and is still used by both NavGroup sub-items (for
// any future per-row count badge) and the inbox footer button.
//
// Source-code-level fallback per CLAUDE.md "Test-with-every-change":
// JSDOM can't evaluate computed layout, so we assert the contract on
// the stylesheet text directly.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const INBOX_BUTTON_TSX = resolve(
  __dirname,
  '..',
  'src',
  'components',
  'shell',
  'InboxFooterButton.tsx',
)

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

  test('.nav-item is a flex row so the badge sits at the right edge (RFC-032)', () => {
    // PR1 of RFC-032 replaced .sidebar__link with .nav-item — the legacy
    // CSS rule is kept for backward compat (other components reference it
    // via class) but the active-nav primitive is .nav-item now. Both must
    // remain flex rows so any future per-row badge still sits flush right.
    const css = readFileSync(STYLES_CSS, 'utf8')
    const match = css.match(/\.nav-item\s*\{([^}]*)\}/)
    expect(match).not.toBeNull()
    const body = match![1]
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/justify-content:\s*space-between/)
    expect(body).toMatch(/align-items:\s*center/)
  })

  test('active variant inverts the badge so it stays readable on the accent fill', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.nav-item--active\s+\.sidebar__badge\s*\{/)
  })

  test('InboxFooterButton emits <span class="sidebar__badge"> with the 99+ cap (RFC-032 PR2)', () => {
    const tsx = readFileSync(INBOX_BUTTON_TSX, 'utf8')
    expect(tsx).toContain('sidebar__badge')
    expect(tsx).toMatch(/total > 99 \? '99\+' : String\(total\)/)
  })
})
