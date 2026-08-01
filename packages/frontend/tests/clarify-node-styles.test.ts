// Locks in the visual parity between the Clarify (反问), Cross-clarify and
// Review (评审) cards. Their shared chrome comes from CanvasNodeCard and one
// Human-family accent group, so no renderer needs to duplicate a full CSS
// block to stay visually aligned.

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
  test('review and both clarify kinds share one amber accent group', async () => {
    const css = await styles()
    const start = css.indexOf(".canvas-node--card[data-node-kind='review'],")
    expect(start).toBeGreaterThanOrEqual(0)
    const humanAccentGroup = css.slice(start, css.indexOf('}', start) + 1)
    expect(humanAccentGroup).toContain(".canvas-node--card[data-node-kind='clarify']")
    expect(humanAccentGroup).toContain(".canvas-node--card[data-node-kind='clarify-cross-agent']")
    expect(humanAccentGroup).toContain('--node-accent: #d97706;')
  })

  test('shared card kind text derives its color from the node accent', async () => {
    const css = await styles()
    const kind = block(css, '.canvas-node--card .canvas-node__kind')
    expect(kind).toContain('var(--node-accent)')
  })
})
