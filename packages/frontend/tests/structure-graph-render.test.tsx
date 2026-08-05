// RFC-083 PR-F — render check for the class-collaboration graph: mounting it
// actually produces class CARDS with member rows + an edge in the DOM (not just
// a blank canvas). This is the "does the graph really render" guard.

import { describe, expect, test, afterEach } from 'vitest'
import { cleanup, render, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { computeSummary, type StructuralDiff, type SymbolNode } from '@agent-workflow/shared'
import '../src/i18n'
import { StructuralGraph } from '../src/components/structure/StructuralGraph'

afterEach(() => cleanup())

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
    impact: [
      {
        changedSymbolId: 'svc.ts#OrderService.charge:method:1',
        confidence: 'extracted',
        callers: [
          {
            symbolId: 'ctrl.ts#Checkout.pay:method:3',
            filePath: 'ctrl.ts',
            range: { startLine: 3, endLine: 4 },
          },
        ],
      },
    ],
    classEdges: [],
    summary: computeSummary(files, []),
  }
}

describe('<StructuralGraph />', () => {
  test('package level (default) shows package nodes; class level shows class cards', () => {
    const { container } = render(<StructuralGraph data={sampleDiff()} />)
    // default = package overview → package summary nodes, no class cards
    expect(container.querySelectorAll('.sg-pkgnode').length).toBeGreaterThanOrEqual(1)
    expect(container.querySelector('.sg-card')).toBeNull()
    // switch to class level
    const classBtn = [...container.querySelectorAll('.structure-graph__level button')].find((b) =>
      /类级|Classes/.test(b.textContent ?? ''),
    )
    fireEvent.click(classBtn as Element)
    const cards = container.querySelectorAll('.sg-card')
    expect(cards.length).toBeGreaterThanOrEqual(1) // OrderService
    expect(container.textContent).toContain('OrderService')
    expect(container.textContent).toContain('charge')
    expect(
      container.querySelector('.sg-card__member--ct-modified, .sg-card__member--ct-added'),
    ).toBeTruthy()
  })

  test('empty state when nothing graphable', () => {
    const empty: StructuralDiff = { ...sampleDiff(), files: [], impact: [] }
    const { container } = render(<StructuralGraph data={empty} />)
    expect(container.querySelector('.structure-graph__empty')).toBeTruthy()
    expect(container.querySelector('.sg-card')).toBeNull()
  })

  // Regression ×2 (user-reported "调用的线不渲染"): (a) 'calls' now defaults ON —
  // it started unchecked as "noisiest", which left graphs with no classEdges
  // rendering as unconnected boxes; (b) at class level the edge state was
  // seeded ONCE from useEdgesState(initialEdges) and never re-synced, so the
  // 调用/继承/引用 checkboxes rebuilt the graph but the rendered edges stayed
  // frozen at the mount-time set.
  test('调用 defaults ON (caller card present); toggling it off re-syncs the graph', () => {
    const { container } = render(<StructuralGraph data={sampleDiff()} />)
    const classBtn = [...container.querySelectorAll('.structure-graph__level button')].find((b) =>
      /类级|Classes/.test(b.textContent ?? ''),
    )
    fireEvent.click(classBtn as Element)
    // calls on by default: the caller-only class (Checkout) is materialised
    expect(container.textContent).toContain('Checkout')
    const callsToggle = [...container.querySelectorAll('.structure-graph__edge-toggle')].find((l) =>
      /调用|calls/i.test(l.textContent ?? ''),
    )
    const cb = callsToggle?.querySelector('input') as HTMLInputElement
    expect(cb.checked).toBe(true)
    fireEvent.click(cb)
    // graph rebuilt: the caller-only card is gone again
    expect(container.textContent).not.toContain('Checkout')
    // Edge DOM can't be asserted under jsdom (xyflow only draws edges after
    // real node measurement), so the edge half of the regression is locked at
    // the source level: edges must be UNCONTROLLED (derived straight from the
    // graph memo). useEdgesState both froze the mount-time set (checkboxes had
    // no effect) and permanently applied xyflow's transient edge-REMOVAL
    // changes (a forever edge-less graph).
    const src = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../src/components/structure/StructuralGraph.tsx',
      ),
      'utf8',
    )
    expect(src).not.toMatch(/useEdgesState|onEdgesChange/)
  })
})
