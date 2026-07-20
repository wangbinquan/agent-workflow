import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  workflowEditorWorkspaceMode,
  workspaceHasInspectorRail,
  workspaceHasPaletteRail,
} from '../src/lib/workflow-editor-workspace'

describe('workflow editor workspace modes', () => {
  test.each([
    [1536, 'wide'],
    [1535, 'medium'],
    [1180, 'medium'],
    [1179, 'compact'],
    [721, 'compact'],
    [720, 'phone'],
  ] as const)('%ipx resolves to %s', (width, expected) => {
    expect(workflowEditorWorkspaceMode(width)).toBe(expected)
  })

  test('only wide keeps palette rail; wide and medium keep inspector rail', () => {
    expect(workspaceHasPaletteRail('wide')).toBe(true)
    expect(workspaceHasPaletteRail('medium')).toBe(false)
    expect(workspaceHasInspectorRail('wide')).toBe(true)
    expect(workspaceHasInspectorRail('medium')).toBe(true)
    expect(workspaceHasInspectorRail('compact')).toBe(false)
    expect(workspaceHasInspectorRail('phone')).toBe(false)
  })

  test('CSS locks the approved desktop tracks and side/fullscreen surfaces', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')
    expect(css).toMatch(
      /\.editor-layout--wide\.editor-layout--with-inspector\s*\{[^}]*240px minmax\(520px, 1fr\) clamp\(360px, 27vw, 420px\)/s,
    )
    expect(css).toMatch(
      /\.editor-layout--medium\.editor-layout--with-inspector\s*\{[^}]*minmax\(520px, 1fr\) clamp\(360px, 30vw, 420px\)/s,
    )
    expect(css).toMatch(
      /\.dialog__panel\.workflow-editor-surface-dialog\s*\{[^}]*width: min\(88vw, 420px\)[^}]*height: 100dvh/s,
    )
    expect(css).toMatch(
      /\.dialog__panel\.workflow-editor-surface-dialog--phone\s*\{[^}]*width: 100vw[^}]*border-radius: 0/s,
    )
  })
})
