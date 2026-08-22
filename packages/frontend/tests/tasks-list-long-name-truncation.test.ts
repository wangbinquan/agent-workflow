// RFC-244 — long task content stays bounded in the dense operations grid.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')

function rule(selector: string): string {
  const match = CSS.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`))
  if (match === null) throw new Error(`selector not found: ${selector}`)
  return match[0]
}

describe('tasks operations list — long content containment', () => {
  test("task names keep the prototype's recoverable one-line density", () => {
    const body = rule('\\.task-operations__name')
    expect(body).toMatch(/display:\s*block/)
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
    expect(body).toMatch(/white-space:\s*nowrap/)
  })

  test('metadata and execution detail ellipsize instead of widening the grid', () => {
    expect(CSS).toMatch(/\.task-operations__meta\s*\{\s*overflow:\s*hidden/)
    expect(CSS).toMatch(
      /\.task-operations__detail\s*\{\s*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/,
    )
  })

  test('short id cannot absorb the task metadata row', () => {
    expect(rule('\\.task-operations__id')).toMatch(/flex:\s*none/)
  })

  test('ordinary owner labels stay compact without disabling wrapping', () => {
    const body = rule('\\.task-operations__owner')
    expect(body).toMatch(/font-size:\s*var\(--font-sm\)/)
    expect(body).toMatch(/overflow-wrap:\s*anywhere/)
  })

  test('the task link exposes the full name through its title', () => {
    const link = SRC.match(
      /<a[\s\S]*?className="data-table__link task-operations__name"[\s\S]*?>[\s\S]*?\{item\.title\}[\s\S]*?<\/a>/,
    )
    expect(link).not.toBeNull()
    expect(link?.[0]).toMatch(/title=\{item\.title\}/)
  })
})
