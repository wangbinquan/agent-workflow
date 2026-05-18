// Locks in the visual parity between the Clarify (反问) node and the Review
// (评审) node on the canvas. Both are human-in-the-loop kinds and the
// product wants them to read as the same color family — same amber/gold tint
// for background, border, and the header `kind` pill. If a future refactor
// re-tints one of them without the other, this test goes red so the drift
// is caught at PR time rather than landing on the canvas.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

async function styles(): Promise<string> {
  const here = path.dirname(new URL(import.meta.url).pathname)
  return fs.readFile(path.join(here, '../src/styles.css'), 'utf8')
}

function block(css: string, selector: string): string {
  const idx = css.indexOf(selector + ' {')
  expect(idx, `selector ${selector} { not found in styles.css`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', idx)
  return css.slice(idx, end + 1)
}

describe('ClarifyNode styling mirrors ReviewNode', () => {
  test('.canvas-node--clarify background + border match .canvas-node--review', async () => {
    const css = await styles()
    const review = block(css, '.canvas-node--review')
    const clarify = block(css, '.canvas-node--clarify')
    // Strip the selector header so we compare only the declaration body.
    const body = (s: string) =>
      s
        .replace(/^[^{]+\{/, '')
        .replace(/\}$/, '')
        .trim()
    expect(body(clarify)).toBe(body(review))
  })

  test('.canvas-node--clarify .canvas-node__kind color matches the review kind pill', async () => {
    const css = await styles()
    const review = block(css, '.canvas-node--review .canvas-node__kind')
    const clarify = block(css, '.canvas-node--clarify .canvas-node__kind')
    const body = (s: string) =>
      s
        .replace(/^[^{]+\{/, '')
        .replace(/\}$/, '')
        .trim()
    expect(body(clarify)).toBe(body(review))
  })
})
