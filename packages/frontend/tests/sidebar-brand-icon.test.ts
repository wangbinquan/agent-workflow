// Source-level guard: the sidebar brand renders the agent-workflow icon
// before the wordmark. The icon is the three-streak aurora mark shipped as
// /favicon.svg (three offset wavy paths, each with its own linearGradient);
// if a refactor drops the inline SVG the brand silently regresses to
// text-only, which we want to catch at test time.
//
// Also locks .sidebar__brand and .sidebar__link to the same horizontal
// padding so the icon's left edge stays in the same column as the nav
// labels below — the visible alignment fix from this commit.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const APP_SHELL = path.resolve(__dirname, '../src/components/shell/AppShell.tsx')
const CSS = path.resolve(__dirname, '../src/styles.css')

function extractRulePadding(css: string, selector: string): string | null {
  const escSel = selector.replace(/[.\\]/g, (m) => `\\${m}`)
  const re = new RegExp(`${escSel}\\s*\\{[^}]*?padding:\\s*([^;]+);`, 'm')
  const m = css.match(re)
  return m?.[1] ? m[1].trim() : null
}

function paddingX(padding: string): string {
  const parts = padding.split(/\s+/).filter((p) => p.length > 0)
  // 1-value: all sides. 2/3/4-value: index 1 is the horizontal (right) value.
  return parts.length === 1 ? (parts[0] ?? '') : (parts[1] ?? '')
}

describe('sidebar brand icon', () => {
  const source = fs.readFileSync(APP_SHELL, 'utf8')

  test('renders an <svg> with the brand-icon class inside sidebar__brand', () => {
    const brandBlock = source.match(/<div className="sidebar__brand">[\s\S]*?<\/div>/)
    expect(brandBlock, 'sidebar__brand block exists').not.toBeNull()
    expect(brandBlock![0]).toMatch(/<svg\b[\s\S]*?className="sidebar__brand-icon"/)
  })

  test('icon precedes the brand wordmark', () => {
    const svgIdx = source.indexOf('sidebar__brand-icon')
    const textIdx = source.indexOf("t('nav.brand')")
    expect(svgIdx).toBeGreaterThan(-1)
    expect(textIdx).toBeGreaterThan(-1)
    expect(svgIdx).toBeLessThan(textIdx)
  })

  test('icon uses the three-stream aurora palette shipped in favicon.svg', () => {
    // streak A (emerald → cyan), streak B (blue → violet), streak C (pink → orange)
    expect(source).toContain('#10b981')
    expect(source).toContain('#06b6d4')
    expect(source).toContain('#3b82f6')
    expect(source).toContain('#a855f7')
    expect(source).toContain('#ec4899')
    expect(source).toContain('#f97316')
  })

  test('icon renders three gradient-driven streaks (the parallel flows)', () => {
    const grads = source.match(/<linearGradient\b/g) ?? []
    expect(grads.length).toBeGreaterThanOrEqual(3)
    expect(source).toMatch(/stroke="url\(#aw-stream-a\)"/)
    expect(source).toMatch(/stroke="url\(#aw-stream-b\)"/)
    expect(source).toMatch(/stroke="url\(#aw-stream-c\)"/)
  })

  test('.sidebar__brand horizontal padding matches .sidebar__link so the icon column aligns with nav labels', () => {
    const css = fs.readFileSync(CSS, 'utf8')
    const brand = extractRulePadding(css, '.sidebar__brand')
    const link = extractRulePadding(css, '.sidebar__link')
    expect(brand, '.sidebar__brand declares padding').not.toBeNull()
    expect(link, '.sidebar__link declares padding').not.toBeNull()
    expect(paddingX(brand!)).toBe(paddingX(link!))
  })
})
