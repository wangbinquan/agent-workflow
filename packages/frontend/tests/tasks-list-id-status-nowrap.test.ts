// Regression: on /tasks the ID cell and the status chip must render on a
// single line. Before this lock, the generic `.data-table td code` rule
// (`overflow-wrap: anywhere; word-break: break-word`) wrapped the 10-char ID,
// and `.status-chip` had no `white-space` rule so Chinese status labels like
// "等待审核" broke inside the pill when the column was narrow. Lock both rules
// textually in styles.css so any future cleanup that drops them turns red.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const STYLES_CSS = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/styles.css')

describe('/tasks list — ID cell and status chip stay on a single line', () => {
  test('.status-chip declares white-space: nowrap', async () => {
    const css = await fs.readFile(STYLES_CSS, 'utf8')
    const block = css.match(/\.status-chip\s*\{[^}]*\}/)
    expect(block, '.status-chip rule must exist').not.toBeNull()
    expect(block![0]).toMatch(/white-space:\s*nowrap/)
  })

  test('.data-table__id and its inner <code> declare white-space: nowrap (overriding the generic td code break-word rule)', async () => {
    const css = await fs.readFile(STYLES_CSS, 'utf8')
    const idBlock = css.match(/\.data-table__id\s*\{[^}]*\}/)
    expect(idBlock, '.data-table__id rule must exist').not.toBeNull()
    expect(idBlock![0]).toMatch(/white-space:\s*nowrap/)

    const idCodeBlock = css.match(/\.data-table__id code\s*\{[^}]*\}/)
    expect(idCodeBlock, '.data-table__id code override rule must exist').not.toBeNull()
    expect(idCodeBlock![0]).toMatch(/white-space:\s*nowrap/)
    expect(idCodeBlock![0]).toMatch(/word-break:\s*normal/)
  })
})
