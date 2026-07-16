// RFC-168 — app-shell scroll-clipping regression lock (source-level: jsdom
// has no layout engine, so this pins the CSS text itself).
//
// Latent shell bug surfaced by the workgroup studio on short viewports
// (user report 2026-07-11): `.app-shell` defined only grid COLUMNS, so the
// implicit `auto` row grew to the items' min-content — the sidebar nav's
// natural height (~830px). On any viewport shorter than that, the row blew
// past the shell's 100vh and `overflow: hidden` CLIPPED the bottom of
// `.content`; its internal scrollbar then bottomed out BEFORE the page's
// last fields (workgroup config's maxRounds / completionGate were
// unreachable) on EVERY route. The fix pins the single row to the shell
// (`minmax(0, 1fr)`) and lets the sidebar scroll itself when it is taller
// than the viewport.

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)
const CSS = readFileSync(resolve(TEST_DIR, '..', 'src', 'styles.css'), 'utf-8')

function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`)
  expect(start, `${selector} block exists`).toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('}', start))
}

describe('app-shell viewport locking (RFC-168 clipping regression)', () => {
  test('.app-shell pins its single grid row to the viewport', () => {
    const shell = block('.app-shell')
    expect(shell).toContain('grid-template-rows: minmax(0, 1fr)')
    expect(shell).toContain('height: 100dvh')
    expect(shell).toContain('min-height: 100dvh')
    expect(shell).toContain('overflow: hidden')
  })

  test('.sidebar scrolls itself on short viewports instead of growing the row', () => {
    const sidebar = block('.sidebar')
    expect(sidebar).toContain('min-height: 0')
    expect(sidebar).toContain('overflow-y: auto')
  })

  test('.content keeps its internal scroll contract', () => {
    const content = block('.content')
    expect(content).toContain('overflow: auto')
    expect(content).toContain('min-height: 0')
    expect(content).toContain('min-width: 0')
  })

  test('900px swaps to one topbar + main grid while 1080px owns compact resource splits', () => {
    expect(CSS).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\)/,
    )
    expect(CSS).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.mobile-topbar[\s\S]*?display: flex/)
    expect(CSS).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.content[\s\S]*?padding: var\(--space-3\)/,
    )
    expect(CSS).toMatch(/@media \(max-width: 1080px\)[\s\S]*?data-mobile-view='list'/)
  })

  test('mobile nav and tablet Inbox are viewport/safe-area bounded', () => {
    const navPanel = block('.dialog__panel.mobile-nav-dialog')
    expect(navPanel).toContain('width: min(88vw, 320px)')
    expect(navPanel).toContain('height: 100dvh')
    expect(navPanel).toContain('max-height: 100dvh')
    expect(navPanel).toContain('env(safe-area-inset-bottom)')
    expect(CSS).toMatch(
      /@media \(min-width: 721px\) and \(max-width: 900px\)[\s\S]*?\.dialog--md \.dialog__panel\.inbox-dialog[\s\S]*?right\)/,
    )
  })
})
