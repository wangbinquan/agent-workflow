// RFC-246 — the three operational lists must keep sharing one chrome instead
// of drifting back into three route-private toolbars.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (path: string) =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', path), 'utf-8')

const TASKS = read('routes/tasks.tsx')
const SCHEDULED = read('routes/scheduled.tsx')
const REPOS = read('routes/repos.tsx')
const TOOLBAR = read('components/operations/OperationsToolbar.tsx')
const CSS = read('styles.css')

describe('RFC-246 shared operations surfaces', () => {
  test('all three pages use the public surface and toolbar', () => {
    for (const source of [TASKS, SCHEDULED, REPOS]) {
      expect(source).toContain('className="operations-surface"')
      expect(source).toContain('className="operations-surface__header"')
      expect(source).toContain('<OperationsToolbar<')
    }
    expect(TOOLBAR).toContain('<Segmented<V>')
    expect(TOOLBAR).toContain('<TextInput')
    expect(TOOLBAR).not.toContain('<input')
  })

  test('scheduled and repos rows keep the 56px desktop density target', () => {
    expect(CSS).toMatch(/\.operations-table tbody tr\s*\{[^}]*min-height:\s*56px/)
    expect(CSS).toMatch(/\.scheduled-operations__row\s*\{[^}]*cursor:\s*pointer/)
    expect(CSS).not.toMatch(/\.repo-operations__row\s*\{[^}]*cursor:\s*pointer/)
    expect(CSS).toMatch(/\.operations-toolbar__count\s*\{[^}]*opacity:\s*1/)
  })

  test('mobile reflows the same table rows and suppresses horizontal scrolling', () => {
    expect(CSS).toMatch(
      /\.operations-surface \.table-viewport__scroller\s*\{[^}]*overflow-x:\s*clip/,
    )
    expect(CSS).toMatch(/@media \(max-width:\s*720px\)[\s\S]*\.operations-table thead/)
    expect(CSS).toMatch(/\.scheduled-operations__row\s*\{[^}]*grid-template-areas:/)
    expect(CSS).toMatch(/\.repo-operations__row\s*\{[^}]*grid-template-areas:/)
    expect(SCHEDULED).toContain('className="operations-table__mobile-label"')
    expect(REPOS).toContain('className="operations-table__mobile-label"')
    expect(CSS).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.operations-table__mobile-label \{[\s\S]*?display: block;/,
    )
  })

  test('repos never fabricates detail navigation or raw URL rendering', () => {
    expect(REPOS).not.toContain('OperationsChevronIcon')
    expect(REPOS).not.toContain('shouldRowNavigate')
    expect(REPOS).toContain('item.urlRedacted')
    expect(REPOS).not.toMatch(/\bitem\.url\b/)
  })
})
