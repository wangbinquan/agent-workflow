// RFC-199 B4 selection regression: semantic canvas mutations must publish one
// coherent selection to local xyflow highlighting and the route inspector.
// Previously paste/duplicate/wrap only called setSelection, leaving the
// immediate definition rebuild and parent onSelect on stale subjects.

import { describe, expect, test } from 'vitest'
import { applySelection, buildCanvasSelectionSync } from '../src/components/canvas/WorkflowCanvas'

describe('buildCanvasSelectionSync', () => {
  test('one selected node drives both xyflow highlight and route inspector', () => {
    const sync = buildCanvasSelectionSync(['copy-a'], [])
    const flowNodes = applySelection<{ id: string; selected?: boolean }>(
      [{ id: 'existing' }, { id: 'copy-a' }],
      sync.local.nodes,
    )

    expect(sync).toEqual({
      local: { nodes: ['copy-a'], edges: [] },
      route: { kind: 'node', id: 'copy-a' },
      signature: 'node:copy-a',
    })
    expect(flowNodes.filter((node) => node.selected).map((node) => node.id)).toEqual(['copy-a'])
  })

  test('multi-node paste highlights the whole slice and closes a stale single-subject inspector', () => {
    const sync = buildCanvasSelectionSync(['copy-a', 'copy-b'], [])
    const flowNodes = applySelection<{ id: string; selected?: boolean }>(
      [{ id: 'existing' }, { id: 'copy-a' }, { id: 'copy-b' }],
      sync.local.nodes,
    )

    expect(sync.route).toBeNull()
    expect(sync.signature).toBe('null')
    expect(flowNodes.filter((node) => node.selected).map((node) => node.id)).toEqual([
      'copy-a',
      'copy-b',
    ])
  })
})

describe('WorkflowCanvas mutation selection wiring', () => {
  test('paste, duplicate, wrap, and palette insert reuse the same local/route publisher', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const src = await fs.readFile(
      path.join(here, '../src/components/canvas/WorkflowCanvas.tsx'),
      'utf8',
    )

    const bodyBetween = (startMarker: string, endMarker: string): string => {
      const start = src.indexOf(startMarker)
      expect(start).toBeGreaterThan(-1)
      const end = src.indexOf(endMarker, start)
      expect(end).toBeGreaterThan(start)
      return src.slice(start, end)
    }

    const publisher = bodyBetween(
      'const syncCanvasSelection = useCallback(',
      '// A canvas mounted inside a hidden tab pane',
    )
    expect(publisher).toMatch(/selectionRef\.current\s*=\s*next\.local/)
    expect(publisher).toMatch(/setSelection\(next\.local\)/)
    expect(publisher).toMatch(/lastEmittedSelectionSig\.current\s*=\s*next\.signature/)
    expect(publisher).toMatch(/onSelect\?\.\(next\.route\)/)

    const mutationBodies = [
      bodyBetween('const pasteFromClipboard = useCallback(', 'const selectAll = useCallback('),
      bodyBetween('const duplicateNode = useCallback(', '// P-3-04: wrap the current selection'),
      bodyBetween('const wrapSelection = useCallback(', 'const decomposeWrapper = useCallback('),
      bodyBetween('const insertPaletteItem = useCallback(', 'const addPaletteItemAtViewportCenter'),
    ]
    for (const body of mutationBodies) {
      expect(body).toMatch(/syncCanvasSelection\(/)
      expect(body).toMatch(/const accepted = commitChange\(/)
      expect(body).toMatch(/if \(!accepted\) return/)
      expect(body.indexOf('syncCanvasSelection(')).toBeGreaterThan(
        body.indexOf('if (!accepted) return'),
      )
    }
  })
})
