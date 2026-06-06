// RFC-083 PR-F — render check for the class-collaboration graph: mounting it
// actually produces class CARDS with member rows + an edge in the DOM (not just
// a blank canvas). This is the "does the graph really render" guard.

import { describe, expect, test, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
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
    summary: computeSummary(files, []),
  }
}

describe('<StructuralGraph /> renders cards', () => {
  test('a class card with member rows + a caller card + an edge appear in the DOM', () => {
    const { container } = render(<StructuralGraph data={sampleDiff()} />)
    // the changed class card
    const cards = container.querySelectorAll('.sg-card')
    expect(cards.length).toBeGreaterThanOrEqual(2) // OrderService + Checkout (caller)
    // member rows rendered inside cards
    const members = container.querySelectorAll('.sg-card__member')
    expect(members.length).toBeGreaterThanOrEqual(2) // charge + refund (+ caller pay)
    // a changed member carries a change-type class (color)
    expect(
      container.querySelector('.sg-card__member--ct-modified, .sg-card__member--ct-added'),
    ).toBeTruthy()
    // the card titles are present as text
    expect(container.textContent).toContain('OrderService')
    expect(container.textContent).toContain('charge')
    // edges are wired into the flow (the path geometry needs real node
    // measurement → only drawn in a browser; the model test covers edge data)
    expect(container.querySelector('.react-flow__edges')).toBeTruthy()
  })

  test('empty state when nothing graphable', () => {
    const empty: StructuralDiff = { ...sampleDiff(), files: [], impact: [] }
    const { container } = render(<StructuralGraph data={empty} />)
    expect(container.querySelector('.structure-graph__empty')).toBeTruthy()
    expect(container.querySelector('.sg-card')).toBeNull()
  })
})
