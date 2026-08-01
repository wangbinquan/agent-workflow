// RFC-244 — the dense list is a native nested list whose rows share one grid.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')
const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')

describe('routes/tasks.tsx — operations-grid row alignment', () => {
  test('native ol/li owns hierarchy and no table cell is used', () => {
    expect(SRC).toContain('<ol className="task-operations__list"')
    expect(SRC).toContain('className="task-operations__item"')
    expect(SRC).not.toContain('<td')
    expect(SRC).not.toContain('<table')
  })

  test('the visual header and every row share the same grid declaration', () => {
    expect(CSS).toMatch(
      /\.task-operations__head,\s*\.task-operations__row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:/,
    )
  })

  test('all four content cells keep min-width zero for safe alignment', () => {
    expect(CSS).toMatch(/\.task-operations__cell\s*\{[^}]*min-width:\s*0/)
  })
})
