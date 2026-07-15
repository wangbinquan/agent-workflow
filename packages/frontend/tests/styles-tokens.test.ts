// RFC-035 PR1 — source-level guard for the design tokens.
//
// Why this test exists: the tokens live in :root inside styles.css; a future
// PR could remove one without anything else turning red because the project
// has no runtime CSS-token validator. This file reads styles.css and asserts
// every token name plus its dark-mode override is present, so deleting a
// token immediately fails the suite.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const cssPath = path.resolve(here, '../src/styles.css')
const css = readFileSync(cssPath, 'utf8')

const SPACE = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6']
const FONT = [
  '--font-ui',
  '--font-mono',
  '--font-xs',
  '--font-sm',
  '--font-md',
  '--font-lg',
  '--font-xl',
]
const RADIUS = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-pill']
const SHADOW = ['--shadow-sm', '--shadow-md', '--shadow-lg']
const SEMANTIC = [
  '--accent-fill',
  '--on-accent',
  '--success-fg',
  '--success-fill',
  '--on-success',
  '--success-bg',
  '--success-border',
  '--warn-fg',
  '--warn-fill',
  '--on-warn',
  '--warn-bg',
  '--warn-border',
  '--info-fg',
  '--info-fill',
  '--on-info',
  '--info-bg',
  '--info-border',
  '--danger-fg',
  '--danger-fill',
  '--on-danger',
  '--danger-bg',
  '--danger-border',
  '--focus-ring-color',
  '--focus-ring-width',
  '--focus-ring-offset',
]
const DARK_SEMANTIC = [
  '--accent',
  '--accent-fill',
  '--danger-fg',
  '--danger-fill',
  '--success-fg',
  '--success-fill',
  '--warn-fg',
  '--warn-fill',
  '--info-fg',
  '--info-fill',
]

function declared(name: string): boolean {
  return new RegExp(`${name}:\\s`).test(css)
}

describe('RFC-035 design tokens', () => {
  test('every spacing token is declared in :root', () => {
    for (const t of SPACE) expect(declared(t), t).toBe(true)
  })

  test('every font token is declared in :root', () => {
    for (const t of FONT) expect(declared(t), t).toBe(true)
  })

  test('every radius token is declared in :root', () => {
    for (const t of RADIUS) expect(declared(t), t).toBe(true)
  })

  test('every shadow token is declared in :root', () => {
    for (const t of SHADOW) expect(declared(t), t).toBe(true)
  })

  test('every semantic color token is declared in :root', () => {
    for (const t of SEMANTIC) expect(declared(t), t).toBe(true)
  })

  test('dark theme override declares text and fill roles independently', () => {
    // The dark block starts with `:root[data-theme='dark']` and must contain
    // each semantic color name. We extract from the first dark block up to
    // the closing brace via a non-greedy match.
    const darkMatch = css.match(/:root\[data-theme='dark'\][^}]+}/m)
    expect(darkMatch, 'dark theme block').not.toBeNull()
    const darkBody = darkMatch?.[0] ?? ''
    for (const t of DARK_SEMANTIC) {
      expect(darkBody.includes(`${t}:`), `dark ${t}`).toBe(true)
    }
  })

  test('@media (prefers-color-scheme: dark) fallback also redeclares semantic colors', () => {
    const idx = css.indexOf('prefers-color-scheme: dark')
    expect(idx).toBeGreaterThan(0)
    // Grab a generous slice; the block is small.
    const slice = css.slice(idx, idx + 1_600)
    for (const t of DARK_SEMANTIC) {
      expect(slice.includes(`${t}:`), `media-query fallback ${t}`).toBe(true)
    }
  })
})
