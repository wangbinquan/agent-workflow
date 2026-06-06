// RFC-083 PR-G — class-level inherit/reference edges. Locks: a class that
// constructs/uses another → 'references'; extends/implements (Java/TS) + Python
// `class X(Base)` → 'inherits' (and inheritance wins over a plain reference for
// the same pair); unrelated classes → no edge.

import { describe, expect, test } from 'bun:test'
import {
  collectClassNodes,
  collectClassMembers,
  computeClassEdges,
  type ClassNode,
} from '../src/services/structuralDiff/classGraph'
import type { FileStructuralDiff, SymbolNode } from '@agent-workflow/shared'

const node = (key: string, name: string, file: string, a: number, b: number): ClassNode => ({
  key,
  name,
  file,
  range: { startLine: a, endLine: b },
})

describe('computeClassEdges', () => {
  test('A constructs B → references edge (one-directional)', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 5), node('b.ts::B', 'B', 'b.ts', 1, 3)]
    const fileText = new Map([
      ['a.ts', 'class A {\n  m() {\n    return new B()\n  }\n}'],
      ['b.ts', 'class B {\n  k() {}\n}'],
    ])
    const edges = computeClassEdges(nodes, fileText)
    expect(edges).toEqual([{ from: 'a.ts::A', to: 'b.ts::B', kind: 'references' }])
  })

  test('a references edge is attributed to the member where the reference sits (fromMember)', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 6), node('b.ts::B', 'B', 'b.ts', 1, 3)]
    const fileText = new Map([
      // A.foo (lines 2-4) constructs B on line 3; A.bar (line 5) does not
      ['a.ts', 'class A {\n  foo() {\n    return new B()\n  }\n  bar() {}\n}'],
      ['b.ts', 'class B {\n  k() {}\n}'],
    ])
    const members = new Map([
      [
        'a.ts::A',
        [
          {
            id: 'a.ts#A.foo:method:1',
            name: 'foo',
            kind: 'method' as const,
            startLine: 2,
            endLine: 4,
          },
          {
            id: 'a.ts#A.bar:method:1',
            name: 'bar',
            kind: 'method' as const,
            startLine: 5,
            endLine: 5,
          },
        ],
      ],
    ])
    const edges = computeClassEdges(nodes, fileText, members)
    expect(edges).toEqual([
      { from: 'a.ts::A', to: 'b.ts::B', kind: 'references', fromMembers: ['a.ts#A.foo:method:1'] },
    ])
  })

  test('a reference appearing in several members lists them ALL (fromMembers, not just the first)', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 8), node('b.ts::B', 'B', 'b.ts', 1, 2)]
    const fileText = new Map([
      // B is used in BOTH foo (line 3) and bar (line 6)
      ['a.ts', 'class A {\n  foo() {\n    new B()\n  }\n  bar() {\n    new B()\n  }\n}'],
      ['b.ts', 'class B {\n}'],
    ])
    const members = new Map([
      [
        'a.ts::A',
        [
          {
            id: 'a.ts#A.foo:method:1',
            name: 'foo',
            kind: 'method' as const,
            startLine: 2,
            endLine: 4,
          },
          {
            id: 'a.ts#A.bar:method:1',
            name: 'bar',
            kind: 'method' as const,
            startLine: 5,
            endLine: 7,
          },
        ],
      ],
    ])
    const edges = computeClassEdges(nodes, fileText, members)
    expect(edges[0]?.fromMembers).toEqual(['a.ts#A.foo:method:1', 'a.ts#A.bar:method:1'])
  })

  test('a references edge points downstream to the referenced class constructor (toMembers)', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 4), node('b.ts::B', 'B', 'b.ts', 1, 4)]
    const fileText = new Map([
      ['a.ts', 'class A {\n  make() {\n    return new B()\n  }\n}'],
      ['b.ts', 'class B {\n  constructor() {}\n  k() {}\n}'],
    ])
    const members = new Map([
      [
        'a.ts::A',
        [
          {
            id: 'a.ts#A.make:method:1',
            name: 'make',
            kind: 'method' as const,
            startLine: 2,
            endLine: 4,
          },
        ],
      ],
      [
        'b.ts::B',
        [
          {
            id: 'b.ts#B.ctor:constructor:1',
            name: 'B',
            kind: 'constructor' as const,
            startLine: 2,
            endLine: 2,
          },
        ],
      ],
    ])
    const edges = computeClassEdges(nodes, fileText, members)
    expect(edges).toEqual([
      {
        from: 'a.ts::A',
        to: 'b.ts::B',
        kind: 'references',
        fromMembers: ['a.ts#A.make:method:1'],
        toMembers: ['b.ts#B.ctor:constructor:1'],
      },
    ])
  })

  test('a references edge lists the referenced class methods USED by name (toMembers)', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 5), node('b.ts::B', 'B', 'b.ts', 1, 5)]
    const fileText = new Map([
      // A holds a B and calls b.foo() + b.bar(); baz() is never called
      ['a.ts', 'class A {\n  b = new B()\n  run() {\n    this.b.foo(); this.b.bar()\n  }\n}'],
      ['b.ts', 'class B {\n  foo() {}\n  bar() {}\n  baz() {}\n}'],
    ])
    const members = new Map([
      [
        'a.ts::A',
        [
          { id: 'a.ts#A.b:field:1', name: 'b', kind: 'field' as const, startLine: 2, endLine: 2 },
          {
            id: 'a.ts#A.run:method:1',
            name: 'run',
            kind: 'method' as const,
            startLine: 3,
            endLine: 5,
          },
        ],
      ],
      [
        'b.ts::B',
        [
          {
            id: 'b.ts#B.foo:method:1',
            name: 'foo',
            kind: 'method' as const,
            startLine: 2,
            endLine: 2,
          },
          {
            id: 'b.ts#B.bar:method:1',
            name: 'bar',
            kind: 'method' as const,
            startLine: 3,
            endLine: 3,
          },
          {
            id: 'b.ts#B.baz:method:1',
            name: 'baz',
            kind: 'method' as const,
            startLine: 4,
            endLine: 4,
          },
        ],
      ],
    ])
    const ref = computeClassEdges(nodes, fileText, members).find(
      (e) => e.from === 'a.ts::A' && e.to === 'b.ts::B',
    )
    expect(ref?.toMembers?.sort()).toEqual(['b.ts#B.bar:method:1', 'b.ts#B.foo:method:1']) // baz NOT used
  })

  test('collectClassMembers groups changed members under their enclosing class key', () => {
    const sym = (qn: string, a: number, b: number): SymbolNode => ({
      id: `a.ts#${qn}:method:1`,
      kind: 'method',
      name: qn.split('.').pop() ?? qn,
      qualifiedName: qn,
      lang: 'typescript',
      filePath: 'a.ts',
      confidence: 'extracted',
      range: { startLine: a, endLine: b },
    })
    const files: FileStructuralDiff[] = [
      {
        filePath: 'a.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          { changeType: 'added', kind: 'method', after: sym('A.foo', 2, 4) },
          { changeType: 'modified', kind: 'method', after: sym('A.bar', 5, 6) },
        ],
      },
    ]
    const members = collectClassMembers(files)
    expect(members.get('a.ts::A')?.map((m) => m.id)).toEqual([
      'a.ts#A.foo:method:1',
      'a.ts#A.bar:method:1',
    ])
  })

  test('A extends B → inheritance edge, and it wins over a reference for the pair', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 3), node('b.ts::B', 'B', 'b.ts', 1, 2)]
    const fileText = new Map([
      ['a.ts', 'class A extends B {\n  m() { return new B() }\n}'],
      ['b.ts', 'class B {}'],
    ])
    const edges = computeClassEdges(nodes, fileText)
    expect(edges.filter((e) => e.from === 'a.ts::A' && e.to === 'b.ts::B')).toEqual([
      { from: 'a.ts::A', to: 'b.ts::B', kind: 'inherits' },
    ])
  })

  test('Python class(Base) → inheritance', () => {
    const nodes = [
      node('m.py::Dog', 'Dog', 'm.py', 1, 2),
      node('m.py::Animal', 'Animal', 'm.py', 4, 5),
    ]
    const fileText = new Map([
      ['m.py', 'class Dog(Animal):\n    pass\n\nclass Animal:\n    pass\n'],
    ])
    expect(computeClassEdges(nodes, fileText)).toContainEqual({
      from: 'm.py::Dog',
      to: 'm.py::Animal',
      kind: 'inherits',
    })
  })

  test('unrelated classes → no edges', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 2), node('b.ts::B', 'B', 'b.ts', 1, 2)]
    const fileText = new Map([
      ['a.ts', 'class A { m() { return 1 } }'],
      ['b.ts', 'class B { k() { return 2 } }'],
    ])
    expect(computeClassEdges(nodes, fileText)).toEqual([])
  })

  test('fewer than 2 classes → no edges', () => {
    expect(
      computeClassEdges([node('a::A', 'A', 'a', 1, 2)], new Map([['a', 'class A {}']])),
    ).toEqual([])
  })
})

describe('collectClassNodes', () => {
  test('picks changed class symbols with ranges', () => {
    const cls = (qn: string): SymbolNode => ({
      id: `f.ts#${qn}:class:1`,
      kind: 'class',
      name: qn,
      qualifiedName: qn,
      lang: 'typescript',
      filePath: 'f.ts',
      range: { startLine: 1, endLine: 4 },
      confidence: 'extracted',
    })
    const files: FileStructuralDiff[] = [
      {
        filePath: 'f.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          { changeType: 'added', kind: 'class', after: cls('Widget') },
          // a method change must NOT become a class node
          {
            changeType: 'modified',
            kind: 'method',
            after: { ...cls('Widget.run'), kind: 'method', qualifiedName: 'Widget.run' },
          },
        ],
      },
    ]
    const nodes = collectClassNodes(files)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ key: 'f.ts::Widget', name: 'Widget', file: 'f.ts' })
  })
})
