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

  test('the approved prototype is one unified operations surface', () => {
    expect(SRC).toContain('className="operations-surface"')
    expect(SRC).toContain('className="operations-surface__header"')
    expect(SRC).toContain('<OperationsToolbar<TaskListView>')
    expect(CSS).toMatch(
      /\.operations-surface\s*\{[^}]*border:\s*1px solid var\(--border\)[^}]*box-shadow:/,
    )
  })

  test('hierarchy expands beside the name while a separate trailing chevron opens detail', () => {
    const row = SRC.slice(
      SRC.indexOf('function TaskOperationsRow'),
      SRC.indexOf('function executionDetail'),
    )
    expect(row).toMatch(
      /task-operations__task-main[\s\S]*task-operations__expand-button[\s\S]*task-operations__name/,
    )
    expect(row).toMatch(/task-operations__owner[\s\S]*task-operations__nav/)
  })

  test('expanded children use the prototype inset well and branch rail', () => {
    expect(CSS).toMatch(
      /\.task-operations__children\s*\{[^}]*margin:\s*0 22px 8px 55px[^}]*border-left:[^}]*background:/,
    )
  })
})
