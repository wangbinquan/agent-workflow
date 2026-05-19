// Locks in the visual fix for the launcher's "Local path / Remote URL"
// segmented control: the .tabs--segment box lives inside .repo-source-tabs,
// which is `display: flex; flex-direction: column`. Without `align-self`,
// flex items default to `align-items: stretch`, so the segmented control's
// bordered frame stretched across the full row width regardless of its
// `inline-flex` display — leaving a huge empty bordered area to the right
// of the two tabs.
//
// If `align-self: flex-start` (or an equivalent shrink-to-fit) is removed,
// the bug returns. Keep this test red until a deliberate replacement is in
// place.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

describe('.tabs--segment shrink-to-fit inside flex column parents', () => {
  test('.tabs--segment block declares align-self so it does not stretch', () => {
    const match = css.match(/\.tabs--segment\s*\{[^}]*\}/)
    expect(match, '.tabs--segment block must exist').not.toBeNull()
    const block = match![0]
    expect(block).toContain('align-self')
  })
})
