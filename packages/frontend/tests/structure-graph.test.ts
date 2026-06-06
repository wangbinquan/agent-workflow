// RFC-083 PR-F — class-collaboration graph model. A CARD = a class/file; it
// lists its changed members (badged by change type) + caller members (methods
// that call changed code elsewhere); edges run caller-card → changed-card. Locks
// the containment grouping, change-type carry-through, and the impact edges.

import { describe, expect, test } from 'vitest'
import { computeSummary, type StructuralDiff, type SymbolNode } from '@agent-workflow/shared'
import { buildStructureGraph, fileBase } from '../src/lib/structureGraph'

function sym(filePath: string, qn: string, kind: SymbolNode['kind']): SymbolNode {
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

function diffWith(
  files: StructuralDiff['files'],
  impact: StructuralDiff['impact'],
): StructuralDiff {
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'WORKTREE',
    engine: 'deep',
    status: 'ok',
    files,
    dependencyChanges: [],
    impact,
    summary: computeSummary(files, []),
  }
}

const file = (
  filePath: string,
  changes: StructuralDiff['files'][number]['changes'],
): StructuralDiff['files'][number] => ({
  filePath,
  lang: 'typescript',
  status: 'ok',
  edges: [],
  impact: [],
  changes,
})

describe('buildStructureGraph — cards', () => {
  test('a changed method becomes a member row inside its CLASS card', () => {
    const g = buildStructureGraph(
      diffWith(
        [
          file('svc.ts', [
            {
              changeType: 'modified',
              kind: 'method',
              after: sym('svc.ts', 'OrderService.charge', 'method'),
            },
            {
              changeType: 'added',
              kind: 'method',
              after: sym('svc.ts', 'OrderService.refund', 'method'),
            },
          ]),
        ],
        [],
      ),
    )
    expect(g.cards).toHaveLength(1)
    const card = g.cards[0]!
    expect(card.title).toBe('OrderService') // grouped under the class
    expect(card.isChanged).toBe(true)
    expect(card.members.map((m) => `${m.changeType} ${m.label}`).sort()).toEqual([
      'added refund',
      'modified charge',
    ])
  })

  test('a changed class sets the card changeType; top-level fn → a FILE card', () => {
    const g = buildStructureGraph(
      diffWith(
        [
          file('a.ts', [
            { changeType: 'added', kind: 'class', after: sym('a.ts', 'Widget', 'class') },
          ]),
          file('util.ts', [
            {
              changeType: 'modified',
              kind: 'function',
              after: sym('util.ts', 'helper', 'function'),
            },
          ]),
        ],
        [],
      ),
    )
    const widget = g.cards.find((c) => c.title === 'Widget')
    expect(widget?.kind).toBe('class')
    expect(widget?.changeType).toBe('added')
    const util = g.cards.find((c) => c.title === 'util.ts')
    expect(util?.kind).toBe('file') // top-level fn grouped under its file
    expect(util?.members[0]?.label).toBe('helper')
  })

  test('impact adds a caller card + a caller→changed edge', () => {
    const g = buildStructureGraph(
      diffWith(
        [
          file('svc.ts', [
            {
              changeType: 'modified',
              kind: 'method',
              after: sym('svc.ts', 'Svc.charge', 'method'),
            },
          ]),
        ],
        [
          {
            changedSymbolId: 'svc.ts#Svc.charge:method:1',
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
      ),
    )
    const checkout = g.cards.find((c) => c.title === 'Checkout')
    expect(checkout).toBeDefined()
    expect(checkout?.isChanged).toBe(false) // caller-only
    expect(checkout?.members[0]).toMatchObject({ label: 'pay', role: 'caller' })
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]).toMatchObject({ source: 'ctrl.ts::Checkout', target: 'svc.ts::Svc' })
  })

  test('many cards spread across multiple columns (use the canvas width)', () => {
    // 8 changed classes → the masonry must use ≥3 distinct columns, not 1–2.
    const changes = Array.from({ length: 8 }, (_, i) => ({
      changeType: 'modified' as const,
      kind: 'method' as const,
      after: sym('big.ts', `Class${i}.run`, 'method'),
    }))
    const g = buildStructureGraph(diffWith([file('big.ts', changes)], []))
    expect(g.cards).toHaveLength(8)
    const distinctX = new Set(g.cards.map((c) => c.x))
    expect(distinctX.size).toBeGreaterThanOrEqual(3)
  })

  test('only field/import changes → no cards (nothing graphable)', () => {
    const g = buildStructureGraph(
      diffWith(
        [
          file('m.py', [
            { changeType: 'added', kind: 'import', after: sym('m.py', 'os', 'import') },
          ]),
        ],
        [],
      ),
    )
    expect(g.cards).toEqual([])
  })

  test('fileBase strips the directory', () => {
    expect(fileBase('src/a/b.ts')).toBe('b.ts')
    expect(fileBase('b.ts')).toBe('b.ts')
  })
})
