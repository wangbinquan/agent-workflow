// RFC-072 — source guards locking the Outputs tab redesign in place.
//
//   1. The old fixed-height card grid is gone (no `.task-outputs__grid {` /
//      `.task-output-card__body {` rules, no `max-height: 240px`), replaced by
//      the two-pane `.task-outputs-panel` namespace.
//   2. The Copy button goes through the shared copyText helper, never a bare
//      `navigator.clipboard.writeText` (which threw silently in non-secure
//      contexts — the bug this RFC fixes).
//   3. Download reuses RFC-071's lib (no forked URL builder in the panel).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')
const PANEL = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'components', 'TaskOutputPanel.tsx'),
  'utf8',
)

describe('RFC-072 — Outputs tab source guards', () => {
  test('old card-grid CSS rules are gone', () => {
    expect(CSS).not.toMatch(/\.task-outputs__grid\s*\{/)
    expect(CSS).not.toMatch(/\.task-output-card__body\s*\{/)
    expect(CSS).not.toContain('max-height: 240px')
  })

  test('new two-pane namespace exists', () => {
    expect(CSS).toMatch(/\.task-outputs-panel\s*\{/)
    expect(CSS).toMatch(/\.task-outputs-panel__pre\s*\{/)
  })

  test('port selector is a complete vertical tab widget, never a half-listbox', () => {
    expect(PANEL).toContain('role="tablist"')
    expect(PANEL).toContain('aria-orientation="vertical"')
    expect(PANEL).toContain('role="tab"')
    expect(PANEL).toContain('role="tabpanel"')
    expect(PANEL).toContain('aria-controls={ids.panelId}')
    expect(PANEL).not.toContain('role="listbox"')
    expect(PANEL).not.toContain('role="option"')
  })

  test('Copy goes through copyText, never a bare navigator.clipboard', () => {
    expect(PANEL).toContain("from '@/lib/clipboard'")
    expect(PANEL).toContain('copyText(')
    expect(PANEL).not.toContain('navigator.clipboard')
  })

  test('Download reuses the shared worktree-download lib (no forked URL builder)', () => {
    expect(PANEL).toContain("from '@/lib/worktree-download'")
    expect(PANEL).not.toContain('/api/worktree-files/')
  })
})
