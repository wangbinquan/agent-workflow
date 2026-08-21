import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const styles = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')

describe('design-system capsule labels', () => {
  test('the global invariant prevents every chip, badge, pill, and contract tag from wrapping', () => {
    const block = styles.match(
      /\/\* Design-system invariant: chips, badges, and pills[\s\S]*?\n\}\n/,
    )?.[0]

    expect(block).toBeDefined()
    expect(block).toContain("[class$='-chip']")
    expect(block).toContain("[class$='__badge']")
    expect(block).toContain("[class$='-pill']")
    expect(block).toContain('.execution-contract-field__required')
    expect(block).toMatch(/white-space:\s*nowrap\s*!important/)
  })
})
