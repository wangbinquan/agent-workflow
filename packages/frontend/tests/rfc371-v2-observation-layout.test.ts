// RFC-371 v2 (design/RFC-371-run-observability/redesign-v2-20261014.md §6):
// layout rules the first hosted run (CI 38601555205 / visual 38601555259) found.
//  - Row headers (`<th scope="row">`) in the shared data table read as the row's
//    first cell: agent and model names keep their own case instead of taking the
//    uppercase column-title style (the settings price table showed "TEST/MODEL").
//  - The daily chart's day columns fill a scrolling box edge to edge, so their
//    focus ring is drawn inset; an outset ring was cut on every side
//    (e2e/focus-ring-clip.spec.ts).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = resolve(import.meta.dirname, '..', 'src')
const read = (path: string): string => readFileSync(resolve(SRC, path), 'utf8')

/** The declarations of the one rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('RFC-371 v2 observation layout', () => {
  test('a data-table row header is a body cell, not a column title', () => {
    const css = read('styles.css')
    const header = rule(css, '.data-table tbody th')
    expect(header).toContain('text-transform: none;')
    expect(header).toContain('letter-spacing: normal;')
    expect(header).toContain('white-space: normal;')
    expect(header).toContain('color: inherit;')
    expect(header).toContain('font-size: 14px;')
    // Later and as specific: compact tables keep their smaller cells.
    expect(css.indexOf('\n.data-table--compact tbody th {')).toBeGreaterThan(
      css.indexOf('\n.data-table tbody th {'),
    )
    expect(rule(css, '.data-table--compact tbody th')).toContain('font-size: var(--font-sm);')
    expect(rule(css, '.data-table tbody tr:last-child th')).toContain('border-bottom: none;')
    // The swimlane no longer carries its own copy of the reset.
    expect(read('components/ExecutionSwimlane.css')).not.toContain('.execution-swimlane tbody th')
  })

  test('a selected call row highlights its row header too', () => {
    // `.data-table tbody th` (0,1,2) would otherwise reset the header cell to transparent.
    expect(
      rule(
        read('components/observability/RunObservability.css'),
        '.observability__selected > td,\n.data-table .observability__selected > th',
      ),
    ).toContain('background: color-mix(')
  })

  test('the day columns of the daily chart draw their focus ring inset', () => {
    const css = read('components/observability/RunObservability.css')
    expect(rule(css, '.observability-chart__day:focus-visible')).toContain(
      'outline-offset: var(--focus-ring-offset-inset);',
    )
  })
})
