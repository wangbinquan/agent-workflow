// Intent Builder workflow drafts already reuse WorkflowCanvas, but the canvas
// used to sit inside a 340–420px review rail with `height: 100%` and no
// definite parent height. That made the graph look absent or unusably cramped.
// happy-dom cannot calculate layout, so these source-level guards lock the
// desktop rail ratio, an explicit canvas height, and the mobile single-column
// fallback; the browser E2E covers the resulting geometry.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const STYLES = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  const match = STYLES.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  if (match === null) throw new Error(`rule ${selector} not found in styles.css`)
  return match[1] ?? ''
}

describe('Intent workflow preview layout', () => {
  test('desktop gives the review workspace the wider rail promised by the UX flow', () => {
    const body = ruleBody('.intent-session__workspace')
    expect(body).toMatch(
      /grid-template-columns:\s*minmax\(320px,\s*0\.9fr\)\s+minmax\(480px,\s*1\.1fr\)/,
    )
  })

  test('inline and expanded workflow canvases own explicit bounded height', () => {
    const inline = ruleBody('.intent-workflow-preview__canvas')
    const expanded = ruleBody('.intent-workflow-preview__canvas--expanded')
    expect(inline).toMatch(/height:\s*clamp\(/)
    expect(inline).toMatch(/min-height:/)
    expect(expanded).toMatch(/height:\s*100%/)
    expect(expanded).toMatch(/min-height:\s*0/)
  })

  test('large preview dialog uses the shared Dialog with a viewport-bounded panel', () => {
    const panel = ruleBody('.dialog__panel.intent-workflow-preview-dialog')
    expect(panel).toMatch(/width:\s*min\(/)
    expect(panel).toMatch(/height:\s*min\(/)
  })
})
