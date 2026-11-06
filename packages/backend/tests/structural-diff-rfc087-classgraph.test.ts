// RFC-087 — classGraph consumes structural heritage (Go/Rust) for inherits edges
// and matches every member-access operator (`.`, C++ `->`, Rust/C++ `::`) when
// attributing used methods. Locks the audit gaps: Rust/Go inheritance was
// misclassified as 'references', and `->`/`::` calls were missed by the dot-only
// regex. Pure-function tests over computeClassEdges (no I/O).
import { describe, expect, test } from 'bun:test'
import {
  computeClassEdges,
  type ClassNode,
  type MemberRange,
} from '../src/modules/workspace-insight/domain/structuralDiff/classGraph'

describe('RFC-087 heritage → inherits edge (not references)', () => {
  test('a class whose heritage names another changed class yields inherits, even if the name is not in its body', async () => {
    const nodes: ClassNode[] = [
      {
        key: 's.rs::S',
        name: 'S',
        file: 's.rs',
        range: { startLine: 1, endLine: 1 },
        heritage: ['Display'],
      },
      { key: 's.rs::Display', name: 'Display', file: 's.rs', range: { startLine: 3, endLine: 3 } },
    ]
    // S's body text does NOT mention Display (the `impl Display for S` lives apart) —
    // heritage is what makes this an inherits edge.
    const fileText = new Map([['s.rs', 'struct S {}\n\ntrait Display {}']])
    const edges = computeClassEdges(nodes, fileText)
    expect(edges).toContainEqual(
      expect.objectContaining({ from: 's.rs::S', to: 's.rs::Display', kind: 'inherits' }),
    )
  })
})

describe('RFC-087 call-operator matching (-> and ::)', () => {
  test('C++ p->foo() and D::bar() are attributed as used members of D', () => {
    const src = [
      'class C {', // 1
      '  void m(D* d) { d->foo(); D::bar(); }', // 2
      '};', // 3
      '', // 4
      'class D {', // 5
      '  void foo(); static void bar();', // 6
      '};', // 7
    ].join('\n')
    const nodes: ClassNode[] = [
      { key: 'x.cpp::C', name: 'C', file: 'x.cpp', range: { startLine: 1, endLine: 3 } },
      { key: 'x.cpp::D', name: 'D', file: 'x.cpp', range: { startLine: 5, endLine: 7 } },
    ]
    const members = new Map<string, MemberRange[]>([
      ['x.cpp::C', [{ id: 'C.m', name: 'm', kind: 'method', startLine: 2, endLine: 2 }]],
      [
        'x.cpp::D',
        [
          { id: 'D.foo', name: 'foo', kind: 'method', startLine: 6, endLine: 6 },
          { id: 'D.bar', name: 'bar', kind: 'method', startLine: 6, endLine: 6 },
        ],
      ],
    ])
    const edges = computeClassEdges(nodes, new Map([['x.cpp', src]]), members)
    const ref = edges.find((e) => e.from === 'x.cpp::C' && e.to === 'x.cpp::D')
    expect(ref?.kind).toBe('references')
    // The dot-only regex would miss BOTH `->foo` and `::bar`; the RFC-087 operator
    // set catches them.
    expect(ref?.toMembers).toEqual(expect.arrayContaining(['D.foo', 'D.bar']))
    expect(ref?.fromMembers).toEqual(expect.arrayContaining(['C.m']))
  })
})
