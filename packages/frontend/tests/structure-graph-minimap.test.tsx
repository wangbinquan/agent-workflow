// RFC-083 — MiniMap on the structural architecture graph (Q3). Two guards:
// (1) `changeTypeColor` (pure) maps each change type to the `.structure__delta`
//     palette so the minimap reads as a "where are the changes" heatmap;
// (2) the MiniMap actually mounts at BOTH the package overview and the class
//     detail levels (a `.react-flow__minimap` in the DOM), so large graphs stay
//     navigable. Before this change both flows only had Background + Controls.

import { describe, expect, test, afterEach } from 'vitest'
import { cleanup, render, fireEvent } from '@testing-library/react'
import { computeSummary, type StructuralDiff, type SymbolNode } from '@agent-workflow/shared'
import '../src/i18n'
import { StructuralGraph } from '../src/components/structure/StructuralGraph'
import { changeTypeColor } from '../src/lib/structureGraph'

afterEach(() => cleanup())

describe('changeTypeColor', () => {
  test('maps change types to the structure delta palette', () => {
    expect(changeTypeColor('added')).toBe('var(--success)')
    expect(changeTypeColor('removed')).toBe('var(--danger)')
    expect(changeTypeColor('modified')).toBe('#d99100')
    expect(changeTypeColor('renamed')).toBe('var(--accent)')
    expect(changeTypeColor('moved')).toBe('var(--accent)')
  })

  test('unchanged / undefined falls back to a muted border tone', () => {
    expect(changeTypeColor(undefined)).toBe('var(--border)')
  })
})

function m(filePath: string, qn: string, kind: SymbolNode['kind']): SymbolNode {
  return {
    id: `${filePath}#${qn}:${kind}:1`,
    kind,
    name: qn.includes('.') ? (qn.split('.').pop() ?? qn) : qn,
    qualifiedName: qn,
    lang: 'typescript',
    filePath,
    confidence: 'extracted',
  }
}

function sampleDiff(): StructuralDiff {
  const files: StructuralDiff['files'] = [
    {
      filePath: 'svc.ts',
      lang: 'typescript',
      status: 'ok',
      edges: [],
      impact: [],
      changes: [
        {
          changeType: 'modified',
          kind: 'method',
          after: m('svc.ts', 'OrderService.charge', 'method'),
        },
        {
          changeType: 'added',
          kind: 'method',
          after: m('svc.ts', 'OrderService.refund', 'method'),
        },
      ],
    },
  ]
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'WORKTREE',
    engine: 'deep',
    status: 'ok',
    files,
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: computeSummary(files, []),
  }
}

describe('<StructuralGraph /> minimap', () => {
  test('mounts a minimap at the package level and survives switching to class level', () => {
    const { container } = render(<StructuralGraph data={sampleDiff()} />)
    // package overview (default)
    expect(container.querySelector('.react-flow__minimap')).toBeTruthy()
    // class detail
    const classBtn = [...container.querySelectorAll('.structure-graph__level button')].find((b) =>
      /类级|Classes/.test(b.textContent ?? ''),
    )
    fireEvent.click(classBtn as Element)
    expect(container.querySelector('.react-flow__minimap')).toBeTruthy()
  })
})
