// Locks in the vertical-centering fix the user reported on the resource
// split-page cards (agents / skills / mcps / plugins) and the workgroup member
// gallery: the "owner" label sat visually HIGHER than the pills next to it.
//
// Root cause: `.chip-row` (the shared badges row) had no `align-items`, so it
// fell back to the flex default `stretch`. The bare-text owner span
// (`.data-table__owner`, no padding/border) got stretched to the row height set
// by the taller bordered pills (`.chip` / `.status-chip`, padding 1-2px + 1px
// border), and its single line of text renders at the TOP of that stretched box
// — so it no longer lined up with the pills' vertically-centered text.
// `align-items: center` centers every item's box on the row centerline, so the
// owner text and the pill text share the same vertical center again.
//
// Source-text assertion only (per CLAUDE.md §Test-with-every-change
// "源代码层文本断言") — this is a pure CSS/pixel issue on the `.chip-row`
// primitive, which every badges row (ResourceSplitPage cards +
// WorkgroupMemberGallery) composes. Pinning the rule is the cheap regression
// guard.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')

describe('chip-row alignment — Issue: owner label misaligned with left pills', () => {
  test('.chip-row centers mixed-height children (bare-text labels vs bordered pills)', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    // Without this the flex default `stretch` top-aligns the bare owner text.
    expect(css).toMatch(/\.chip-row\s*\{[^}]*align-items:\s*center/)
  })

  test('.chip-row neutralizes the owner label`s table-only margin-left', () => {
    // `.data-table__owner` keeps `margin-left: 8px` for its <td> host; inside a
    // chip-row that would stack on the row`s own `gap: 4px` and give the owner a
    // 12px asymmetric lead. The scoped override drops it back to the flex gap.
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.chip-row\s+\.data-table__owner\s*\{[^}]*margin-left:\s*0/)
  })
})
