// Regression lock for long, unbroken document names rendered as a shared
// Dialog title. Without a shrinkable/wrapping heading, the title's flex
// min-content width pushes both the text and the close button past the panel.
//
// happy-dom does not calculate layout, so these source-level assertions lock
// the declarations that keep every dynamic Dialog title inside its panel.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  expect(match, `selector ${selector} not found`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('Dialog long-title containment', () => {
  test('the heading can shrink and wraps a filename with no natural break points', () => {
    const title = ruleBody('.dialog__header h2')
    expect(title).toMatch(/flex:\s*1\s+1\s+auto/)
    expect(title).toMatch(/min-width:\s*0/)
    expect(title).toMatch(/overflow-wrap:\s*anywhere/)
  })

  test('the close button keeps its own width while the title wraps', () => {
    expect(ruleBody('.dialog__close')).toMatch(/flex:\s*0\s+0\s+auto/)
  })
})
