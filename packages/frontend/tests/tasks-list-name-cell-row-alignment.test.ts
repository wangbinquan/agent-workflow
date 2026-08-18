// RFC-244 — the dense list is a native nested list whose rows share one grid.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')
const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')

describe('routes/tasks.tsx — operations-grid row alignment', () => {
  test('list roles own hierarchy and no table cell is used', () => {
    // RFC-311：顶层列表进 VirtualList 窗口化,容器/行从 <ol>/<li> 改为
    // role="list"/"listitem" 的 div(sizer div 不能作 <ol> 子元素)——
    // 层级仍由 list 语义持有,依旧不是表格布局。
    expect(SRC).toContain('<VirtualList<TaskOperationsListItem>')
    expect(SRC).toContain("className: 'task-operations__list'")
    expect(SRC).toContain("role: 'list'")
    expect(SRC).toContain("'task-operations__item'")
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
      /task-operations__task-main[\s\S]*OperationsExpandButton[\s\S]*task-operations__name/,
    )
    expect(row).toMatch(/task-operations__owner[\s\S]*task-operations__nav/)
  })

  test('expanded children use the prototype inset well and branch rail', () => {
    expect(CSS).toMatch(
      /\.task-operations__children\s*\{[^}]*margin:\s*0 22px 8px 55px[^}]*border-left:[^}]*background:/,
    )
  })
})
