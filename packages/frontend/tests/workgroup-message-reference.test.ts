import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

function ruleBody(selector: string): string {
  const start = css.indexOf(selector)
  expect(start, `selector ${selector} not found`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('RFC-229 message reference layout', () => {
  test('quote stays inside the bubble at narrow widths', () => {
    const body = ruleBody('.message-reference {')
    expect(body).toMatch(/width:\s*100%/)
    expect(body).toMatch(/min-width:\s*0/)
    expect(body).toMatch(/box-sizing:\s*border-box/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('body is a two-line, anywhere-wrapping preview', () => {
    const body = ruleBody('.message-reference__body {')
    expect(body).toMatch(/-webkit-line-clamp:\s*2/)
    expect(body).toMatch(/overflow-wrap:\s*anywhere/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('keyboard focus stays inset and the target highlight is visible', () => {
    const focus = ruleBody('.message-reference--interactive:focus-visible {')
    expect(focus).toMatch(
      /outline:\s*var\(--focus-ring-width\)\s+solid\s+var\(--focus-ring-color\)/,
    )
    expect(focus).toMatch(/outline-offset:\s*var\(--focus-ring-offset-inset\)/)
    expect(ruleBody('.workgroup-room__msg--highlighted {')).toMatch(/box-shadow:/)
  })
})
