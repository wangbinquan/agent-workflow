// Regression guard: on /agents/new the per-port kind <select> inherits
// .form-input { width: 100% }, which inside the .outputs-editor__row flex
// row pins its flex-basis at 100% of the row and shoves the remove button
// past the viewport edge ("突破窗口外了"). JSDOM doesn't run layout so we
// lock the CSS contract at the source level instead.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// Strip CSS comments first — inline comments inside a rule body can carry
// literal "{ }" tokens that confuse a naive brace-matching regex.
const STYLES = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.-]/g, (c) => `\\${c}`)
  // `[^{}]*` tolerates comma-grouped selectors — RFC-166 shares the outputs
  // rules with `.inputs-editor__*` via `.outputs-editor__kind, .inputs-editor__kind { }`.
  const re = new RegExp(`${escaped}[^{}]*\\{([^}]*)\\}`)
  const m = STYLES.match(re)
  if (m === null) throw new Error(`rule ${selector} not found in styles.css`)
  return m[1] ?? ''
}

describe('.outputs-editor__kind does not overflow the form column', () => {
  test('kind <select> overrides the inherited form-input width:100%', () => {
    const body = ruleBody('.outputs-editor__kind')
    expect(body).toMatch(/width:\s*auto/)
  })

  test('row + name allow shrinking below intrinsic content width', () => {
    expect(ruleBody('.outputs-editor__row')).toMatch(/min-width:\s*0/)
    expect(ruleBody('.outputs-editor__name')).toMatch(/min-width:\s*0/)
  })
})
