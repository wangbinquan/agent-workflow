// Regression: on /mcps, long names + long descriptions must NOT wrap — same
// policy as /agents and /skills (single-line scan-friendly rows). Lock the
// cell classes textually so any future refactor that drops them turns red.
//
// Sibling tests:
//   - agents-list-cell-wrapping.test.ts
//   - skills-list-cell-wrapping.test.ts
// The CSS that backs these classes lives in styles.css:
//   .data-table__nowrap   → name column, no line break on the link
//   .data-table__truncate → description column, single-line + ellipsis

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ROUTE_SRC = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../src/routes/mcps.tsx',
)

describe('/mcps list — name cell does not wrap, description cell truncates to one line', () => {
  test('name <td> carries data-table__nowrap', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    expect(src).toMatch(/<td className="data-table__nowrap">\s*<Link to="\/mcps\/\$name"/)
  })

  test('description <td> carries data-table__truncate (and keeps the muted color)', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    expect(src).toMatch(/className="data-table__muted data-table__truncate"/)
  })

  test('description <td> has a title attribute so the full text is reachable on hover', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    // Without this, truncation would silently hide content.
    expect(src).toMatch(/title=\{m\.description \|\| undefined\}/)
  })
})
