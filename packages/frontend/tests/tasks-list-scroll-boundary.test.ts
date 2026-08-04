// Regression lock for the /tasks scroll owner (user report 2026-08-04).
//
// The dense operations list once grew the shared `.content` container to the
// height of every rendered task. Its scrollbar therefore looked global and
// moved the title + filters together with the rows. happy-dom has no layout
// engine, so pin the CSS height chain that keeps the page in the viewport and
// makes only the native task list the vertical scroll container.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')

function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`)
  expect(start, `${selector} block exists`).toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('}', start))
}

describe('/tasks viewport scroll boundary', () => {
  test('the task page consumes the available content height without scrolling the page shell', () => {
    expect(block('.content:has(.page--task-operations)')).toContain('overflow: hidden')

    const page = block('.page--task-operations')
    expect(page).toContain('display: flex')
    expect(page).toContain('flex-direction: column')
    expect(page).toContain('height: 100%')
    expect(page).toContain('min-height: 0')
  })

  test('the operations surface passes remaining height down to the task list', () => {
    const layout = block(
      '.page--task-operations .operations-surface,\n.page--task-operations .task-operations',
    )
    expect(layout).toContain('display: flex')
    expect(layout).toContain('flex: 1 1 auto')
    expect(layout).toContain('flex-direction: column')
    expect(layout).toContain('min-height: 0')
  })

  test('only the task rows own vertical scrolling and scroll chaining is contained', () => {
    const list = block('.page--task-operations .task-operations__list')
    expect(list).toContain('flex: 1 1 auto')
    expect(list).toContain('min-height: 0')
    expect(list).toContain('overflow-y: auto')
    expect(list).toContain('overscroll-behavior-y: contain')
    expect(list).toContain('scrollbar-gutter: stable')
  })
})
