// Locks in RFC-006 visual fix: port labels must live INSIDE the node
// body (.canvas-node), not on an absolutely-positioned strip that
// overflows onto the node body. If a future refactor reintroduces the
// old `.canvas-node__port { position: absolute }` chip-on-strip layout
// or the `.canvas-node__ports--left { left: -6px }` outer container,
// this test will fail.
//
// This is the "source-code-level fallback" called out in CLAUDE.md
// "Test-with-every-change": JSDOM cannot evaluate full CSS layout, so
// a runtime DOM assertion cannot prove the visual contract on its own;
// pairing it with a textual regression guard catches refactors that
// move the layout backwards.
//
// Link: design/RFC-006-node-port-ux-cleanup/design.md §4.2

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const PORT_HANDLES_TSX = resolve(
  __dirname,
  '..',
  'src',
  'components',
  'canvas',
  'nodes',
  'PortHandles.tsx',
)

describe('RFC-006 layout regression guard', () => {
  test('styles.css does not declare old `.canvas-node__port { position: absolute }` chip rule', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    // Old rule was: `.canvas-node__port { position: absolute; ... }`.
    // We look for the selector starting a rule block (followed by `{`)
    // rather than as a prefix of `.canvas-node__port-row` or
    // `.canvas-node__port-rows` / `.canvas-node__port-label`.
    expect(css).not.toMatch(/\.canvas-node__port\s*\{/)
    // The two old outer-strip selectors must also be gone.
    expect(css).not.toMatch(/\.canvas-node__ports--left\s*\{/)
    expect(css).not.toMatch(/\.canvas-node__ports--right\s*\{/)
    expect(css).not.toMatch(/\.canvas-node__port--left\s*\{/)
    expect(css).not.toMatch(/\.canvas-node__port--right\s*\{/)
  })

  test('styles.css declares the new RFC-006 inline-row rules', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.canvas-node__port-rows\s*\{/)
    expect(css).toMatch(/\.canvas-node__port-row\s*\{/)
    expect(css).toMatch(/\.canvas-node__inbound-catchall\s*\{/)
    // Label retains its ellipsis treatment.
    expect(css).toMatch(/\.canvas-node__port-label[\s\S]*text-overflow:\s*ellipsis/)
    expect(css).toMatch(/\.canvas-node__port-label[\s\S]*max-width:\s*140px/)
  })

  test('PortHandles.tsx references the new layout classes, not the old strip', () => {
    const tsx = readFileSync(PORT_HANDLES_TSX, 'utf8')
    expect(tsx).toContain('canvas-node__port-rows')
    expect(tsx).toContain('canvas-node__port-row')
    expect(tsx).toContain('canvas-node__inbound-catchall')
    // Label carries a `title` attribute for the native-tooltip fallback.
    expect(tsx).toMatch(/title=\{p\}/)
    // Old absolute-strip class is gone from the component output.
    expect(tsx).not.toContain('canvas-node__ports--left')
    expect(tsx).not.toContain('canvas-node__ports--right')
    expect(tsx).not.toMatch(/className=`canvas-node__port canvas-node__port--/)
  })
})
