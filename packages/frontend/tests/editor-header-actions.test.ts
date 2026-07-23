// 2026-07-21 editor header cleanup — locks two user-reported regressions:
//
// 1. The editor action strip must stay visually right-aligned. RFC-199 turned
//    it into a `justify-content: flex-start` scroll strip (so overflow stays
//    reachable), which left the buttons hugging the title on wide screens.
//    The fix is an auto start margin on the first action: right-aligned when
//    the row fits, collapses to 0 when it overflows. `flex-end` on the scroll
//    container is NOT an acceptable替代 — it clips the start side unreachably.
//
// 2. The header「从模板开始」button was removed (the empty-canvas
//    `workflow-empty-start-template` entry is the single starter entry now;
//    the tour anchors there too). Reintroducing the header duplicate should
//    be a deliberate decision, not a merge accident.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
const editorRoute = readFileSync(path.resolve(here, '../src/routes/workflows.edit.tsx'), 'utf8')
const tourScript = readFileSync(path.resolve(here, '../src/components/tour/tourScript.ts'), 'utf8')

describe('editor header action strip alignment', () => {
  test('first action carries the auto start margin that right-aligns the strip', () => {
    expect(css.includes('.editor-page-header > .page__actions > :first-child')).toBe(true)
    const rule = css.split('.editor-page-header > .page__actions > :first-child')[1]!
    expect(rule.slice(0, rule.indexOf('}'))).toContain('margin-inline-start: auto')
  })

  test('the strip itself stays a flex-start scroll container (overflow reachability)', () => {
    const block = css.split('.editor-page-header > .page__actions {')[1]!
    const body = block.slice(0, block.indexOf('}'))
    expect(body).toContain('justify-content: flex-start')
    expect(body).toContain('overflow-x: auto')
  })
})

describe('editor header starter entry removal', () => {
  test('workflows.edit.tsx no longer renders the header start-template button', () => {
    expect(editorRoute.includes('workflow-start-template')).toBe(false)
  })

  test('the tour anchors the template step at the empty-canvas starter button', () => {
    expect(tourScript.includes('data-testid="workflow-empty-start-template"')).toBe(true)
    expect(tourScript.includes('data-testid="workflow-start-template"')).toBe(false)
  })
})

describe('editor header add-step entry gating', () => {
  test('the add-step button renders only when the palette rail is absent', () => {
    // On wide the sidebar palette IS the entry (header duplicate removed by
    // user decision, 2026-07-21); below wide the header button must stay —
    // it is the sole free-insert entry there (390 mobile e2e depends on it).
    expect(editorRoute).toMatch(/\{!hasPaletteRail && \([\s\S]{0,400}?workflow-add-step/)
    expect(editorRoute.includes('workflow-add-step')).toBe(true)
  })
})
