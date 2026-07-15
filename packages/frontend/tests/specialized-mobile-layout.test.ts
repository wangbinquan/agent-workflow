// RFC-198 — source lock for specialized multi-pane surfaces. Browser coverage
// exercises the shared viewport seams; this test keeps the less frequently
// seeded editor/task/review/workgroup layouts from silently returning to fixed
// desktop columns below the canonical 720px boundary.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')
const SPECIALIZED_MARKER =
  '/* RFC-198: specialized workspaces must degrade at the same 720px boundary as'

describe('RFC-198 specialized mobile layouts', () => {
  test('all fixed desktop rails and drawers join the canonical 720px stack', () => {
    const start = CSS.indexOf(SPECIALIZED_MARKER)
    expect(start).toBeGreaterThanOrEqual(0)
    const block = CSS.slice(
      start,
      CSS.indexOf('/* ---- RFC-198 responsive application shell ---- */', start),
    )

    for (const selector of [
      '.editor-layout',
      '.editor-layout--with-inspector',
      '.file-tree',
      '.task-canvas-layout--with-drawer',
      '.task-outputs-panel',
      '.worktree-files-panel',
      '.review-multidoc__body',
      '.workgroup-room',
      '.workgroup-room--with-drawer',
    ]) {
      expect(block, selector).toContain(selector)
    }
    expect(block).toContain('@media (max-width: 720px)')
    expect(block).toContain('grid-template-columns: minmax(0, 1fr)')
  })

  test('flex-based diff trees stack and mobile panes retain bounded reading regions', () => {
    const start = CSS.indexOf(SPECIALIZED_MARKER)
    const block = CSS.slice(
      start,
      CSS.indexOf('/* ---- RFC-198 responsive application shell ---- */', start),
    )

    expect(block).toMatch(/\.worktree-diff,\s*\.structure__tree\s*\{\s*flex-direction: column;/)
    expect(block).toMatch(/\.workgroup-room__main\s*\{\s*min-height: 32rem;/)
    expect(block).toMatch(/\.review-multidoc__pane\s*\{\s*min-height: 28rem;/)
    expect(block).toMatch(/\.wizard-summary__row\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/)
  })

  test('nested inspector rows and review actions remain reachable at mobile width', () => {
    const start = CSS.indexOf(SPECIALIZED_MARKER)
    const block = CSS.slice(
      start,
      CSS.indexOf('/* ---- RFC-198 responsive application shell ---- */', start),
    )

    expect(block).toMatch(
      /\.fanout-input-row,\s*\.inspector__output-port-row\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
    )
    expect(block).toMatch(
      /\.fanout-input-row > \.btn,\s*\.inspector__output-port-row > \.btn\s*\{\s*justify-self: end;/,
    )
    expect(block).toMatch(
      /\.review-detail__page-header-actions\s*\{[^}]*width: 100%;[^}]*flex-wrap: wrap;/,
    )
    expect(block).toMatch(
      /\.review-detail__decision-actions\s*\{[^}]*flex-wrap: wrap;[^}]*margin-left: 0;[^}]*border-left: 0;/,
    )
    expect(block).toMatch(/\.review-detail__decision-actions > \.btn\s*\{\s*flex: 1 1 9rem;/)
  })

  test('nested editors, toolbars, feeds and run logs also degrade inside the mobile stack', () => {
    const start = CSS.indexOf(SPECIALIZED_MARKER)
    const block = CSS.slice(
      start,
      CSS.indexOf('/* ---- RFC-198 responsive application shell ---- */', start),
    )

    expect(block).toMatch(/\.task-row\s*\{\s*grid-template-columns: minmax\(0, 1fr\) auto;/)
    expect(block).toMatch(
      /\.file-tree__path-bar,\s*\.task-outputs-panel__detail-header\s*\{[^}]*flex-direction: column;/,
    )
    expect(block).toMatch(
      /\.file-tree__add,\s*\.file-tree__actions,\s*\.task-outputs-panel__actions\s*\{\s*flex-wrap: wrap;/,
    )
    expect(block).toMatch(
      /\.md-editor,\s*\.memory-compare\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
    )
    expect(block).toMatch(
      /\.md-editor--fill\s*\{[^}]*grid-template-rows: minmax\(16rem, 1fr\) minmax\(16rem, 1fr\);[^}]*overflow-y: auto;/,
    )
    expect(block).toMatch(/\.workgroup-room__runlog-row\s*\{\s*flex-wrap: wrap;/)
  })

  test('review detail keeps the resizable width out of inline grid-template-columns', () => {
    const pane = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'components', 'review', 'ReviewDocPane.tsx'),
      'utf8',
    )
    expect(pane).toContain("'--review-sidebar-width'")
    expect(pane).not.toMatch(/style=\{[^}]*gridTemplateColumns/s)
    expect(CSS).toMatch(
      /@media \(max-width: 720px\)\s*\{\s*\.review-detail__layout\s*\{\s*grid-template-columns: 1fr;/,
    )
  })

  test('OIDC dialog form rows stack at 720 rather than a private breakpoint', () => {
    expect(CSS).toMatch(
      /@media \(max-width: 720px\)\s*\{\s*\.oidc-form__row--cols-2\s*\{\s*grid-template-columns: 1fr;/,
    )
    expect(CSS).not.toMatch(/@media \(max-width: 600px\)\s*\{\s*\.oidc-form__row--cols-2/)
  })
})
