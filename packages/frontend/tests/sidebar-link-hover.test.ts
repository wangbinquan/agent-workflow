// Locks in the sidebar nav hover redesign the user requested:
//
//   "在左侧页签，被选中时蓝色，鼠标hover时是白色，风格很差，调整下hover颜色"
//
// Original .sidebar__link:hover used `var(--bg)` (#f8f9fb in light theme),
// which is almost indistinguishable from the panel background (#ffffff) and
// jarred against the bright-blue active state. The fix tints hover with the
// accent color so it reads as a clear preview of the upcoming active state,
// and pins the active+hover composite so :hover (specificity 0,2,0) cannot
// override the --active background (specificity 0,1,0).
//
// Source-text assertions only (per CLAUDE.md §Test-with-every-change
// "源代码层文本断言") — pixel/CSS regressions don't have a runnable handle
// in JSDOM.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')

describe('sidebar link hover — Issue: hover indistinguishable from panel + active flicker', () => {
  const css = readFileSync(STYLES_CSS, 'utf8')

  test('.sidebar__link:hover uses an accent-tinted background, not var(--bg)', () => {
    // The hover rule must not regress to the original `background: var(--bg)`
    // which had no contrast against the white panel.
    const hover = css.match(/\.sidebar__link:hover\s*\{[^}]*\}/)
    expect(hover, 'missing .sidebar__link:hover block').not.toBeNull()
    const block = hover![0]
    expect(block).not.toMatch(/background:\s*var\(--bg\)/)
    expect(block).toMatch(/color-mix\([^)]*var\(--accent\)/)
  })

  test('.sidebar__link--active:hover is pinned alongside --active so hover cannot override the blue', () => {
    // `.sidebar__link:hover` has higher specificity than
    // `.sidebar__link--active`, so without this composite the active row
    // would flicker to the hover tint when the user mouses over the currently
    // selected nav item. Listing both selectors on the same rule keeps the
    // active state stable.
    expect(css).toMatch(
      /\.sidebar__link--active\s*,\s*\.sidebar__link--active:hover\s*\{[^}]*background:\s*var\(--accent-fill\)/,
    )
  })
})
