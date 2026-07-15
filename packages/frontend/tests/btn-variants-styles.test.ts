// RFC-035 PR1 — CSS-level guard for the two button variants that were
// referenced from 9 callsites but had no CSS declaration before this RFC.
//
// If anyone deletes these blocks from styles.css the silent-fallback bug
// (where `.btn--ghost` quietly rendered as the default `.btn`) returns.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

describe('RFC-035 btn variants — CSS declarations', () => {
  test('.btn--ghost is declared', () => {
    expect(css.includes('.btn--ghost {')).toBe(true)
  })

  test('.btn--xs is declared', () => {
    expect(css.includes('.btn--xs {')).toBe(true)
  })

  test('.btn--ghost has a hover state', () => {
    expect(css.includes('.btn--ghost:hover')).toBe(true)
  })

  test('.btn--ghost.btn--danger composes with the danger variant', () => {
    expect(css.includes('.btn--ghost.btn--danger {')).toBe(true)
  })
})

// User report ×3 ("权限按钮和保存、删除按钮大小不一"): the plain .btn border
// used --border (#e3e5ea), invisible as a button boundary on white, so a
// secondary button next to a filled --primary / red --danger read as a
// SMALLER object even though getBoundingClientRect was identical. The fix is
// the --border-strong token (color-mix over --border/--muted, theme-aware).
// Guard both halves: the token exists, and .btn actually consumes it.
// User report ("二次确认状态…背景色和字体颜色一致都是白的，看不清"): the armed
// ConfirmButton (TaskQuestionList 已处理待确认 → 完成, and every other ConfirmButton)
// paints `color:#fff` on the danger fill, but `.btn--armed` had no `:hover` rule.
// `.btn:hover { background: var(--bg) }` (specificity 0,2,0) therefore outranked
// `.btn--armed` (0,1,0) and reverted the background to the near-white --bg while
// the text stayed white → white-on-near-white. The cursor is always over the
// button when it arms, so the broken state was always the one the user saw.
// Guard: the armed variant must carry its own hover override so a hovered armed
// button can never fall back to `.btn:hover`'s light background.
describe('.btn--armed stays legible while hovered (二次确认 white-on-white fix)', () => {
  test('.btn--armed base fill + white text are declared', () => {
    const block = css.slice(css.indexOf('.btn--armed {'))
    const rule = block.slice(0, block.indexOf('}'))
    expect(rule).toContain('background: var(--danger)')
    expect(rule).toContain('color: #fff')
  })

  test('.btn--armed:hover overrides the background so it cannot revert to var(--bg)', () => {
    expect(css.includes('.btn--armed:hover')).toBe(true)
    const block = css.slice(css.indexOf('.btn--armed:hover'))
    const rule = block.slice(0, block.indexOf('}'))
    // Must repaint a dark danger-derived fill (not var(--bg)) to keep #fff readable.
    expect(rule).toContain('var(--danger)')
    expect(rule).not.toContain('var(--bg)')
  })
})

describe('.btn boundary uses the button-grade border token', () => {
  test('--border-strong token is declared in :root', () => {
    expect(css).toMatch(/--border-strong:\s*color-mix/)
  })

  test('.btn base rule borders with var(--border-strong)', () => {
    const match = css.match(/^\.btn\s*\{([^}]*)\}/m)
    expect(match, 'standalone .btn rule not found').not.toBeNull()
    const rule = match?.[1] ?? ''
    expect(rule).toContain('border: 1px solid var(--border-strong)')
  })
})
