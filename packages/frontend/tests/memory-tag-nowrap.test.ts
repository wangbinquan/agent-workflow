// Regression: every compact label on a memory card must stay as one intact
// pill on narrow screens. The tag list / row head may wrap between pills, but
// without `white-space: nowrap` flexbox shrinks labels such as "Repository"
// and "Approved" and wraps their text inside the pill on mobile.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} rule must exist`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start) + 1)
}

describe('/memory compact labels stay intact on narrow screens', () => {
  test.each([
    '.memory-row__tag',
    '.memory-row__scope',
    '.memory-row__status',
    '.memory-row__fused',
    '.memory-row__lang',
    '.memory-candidate-card__action-tag',
  ])('%s prevents text from wrapping inside its pill', (selector) => {
    expect(rule(selector)).toMatch(/white-space:\s*nowrap/)
  })

  test('the row head wraps whole pills instead of overflowing the card', () => {
    expect(rule('.memory-row__head')).toMatch(/flex-wrap:\s*wrap/)
  })
})
