// RFC-083 PR-F/PR-G — class-collaboration graph model. Cards = classes/files
// with member rows; edges come from classEdges (inherits/references) + impact
// (calls); dagre lays the cards out top→down by those edges (hierarchy). Locks
// the grouping, edge derivation + kind precedence, and the hierarchy ordering.

import { describe, expect, test } from 'vitest'
import {
  computeSummary,
  type StructuralDiff,
  type SymbolNode,
  type ClassEdge,
} from '@agent-workflow/shared'
import {
  buildStructureGraph,
  fileBase,
  packageOf,
  packageLabel,
  relatedMembers,
  memberVisibility,
  memberSignature,
  groupMembersByVisibility,
  type GraphCardEdge,
  type GraphMember,
} from '../src/lib/structureGraph'

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
const cls = (file: string, name: string): StructuralDiff['files'][number] => ({
  filePath: file,
  lang: 'typescript',
  status: 'ok',
  edges: [],
  impact: [],
  changes: [{ changeType: 'added', kind: 'class', after: sym(file, name, 'class') }],
})

function diffWith(
  files: StructuralDiff['files'],
  opts: { impact?: StructuralDiff['impact']; classEdges?: ClassEdge[] } = {},
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
    impact: opts.impact ?? [],
    classEdges: opts.classEdges ?? [],
    summary: computeSummary(files, []),
  }
}

describe('buildStructureGraph — cards + members', () => {
  test('a changed method becomes a member row inside its CLASS card', () => {
    const g = buildStructureGraph(
      diffWith([
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
              after: sym('svc.ts', 'OrderService.charge', 'method'),
            },
            {
              changeType: 'added',
              kind: 'method',
              after: sym('svc.ts', 'OrderService.refund', 'method'),
            },
          ],
        },
      ]),
    )
    const card = g.cards.find((c) => c.title === 'OrderService')
    expect(card?.isChanged).toBe(true)
    expect(card?.members.map((m) => `${m.changeType} ${m.label}`).sort()).toEqual([
      'added refund',
      'modified charge',
    ])
  })

  test('non-graphable kinds (only an import) → no cards', () => {
    const g = buildStructureGraph(
      diffWith([
        {
          filePath: 'm.py',
          lang: 'python',
          status: 'ok',
          edges: [],
          impact: [],
          changes: [{ changeType: 'added', kind: 'import', after: sym('m.py', 'os', 'import') }],
        },
      ]),
    )
    expect(g.cards).toEqual([])
  })
})

describe('buildStructureGraph — edges', () => {
  test('classEdges become graph edges with their kind', () => {
    const edge: ClassEdge = { from: 'a.ts::A', to: 'b.ts::B', kind: 'inherits' }
    const g = buildStructureGraph(
      diffWith([cls('a.ts', 'A'), cls('b.ts', 'B')], { classEdges: [edge] }),
    )
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]).toMatchObject({ source: 'a.ts::A', target: 'b.ts::B', kind: 'inherits' })
  })

  test('references edge: a link per upstream member + per (public) downstream member used', () => {
    const member = (
      qn: string,
      kind: 'constructor' | 'method',
      signature: string,
    ): StructuralDiff['files'][number]['changes'][number] => ({
      changeType: 'added',
      kind,
      after: { ...sym('b.ts', qn, kind), signature },
    })
    const g = buildStructureGraph(
      diffWith(
        [
          cls('a.ts', 'A'),
          {
            filePath: 'b.ts',
            lang: 'java',
            status: 'ok',
            edges: [],
            impact: [],
            changes: [
              { changeType: 'added', kind: 'class', after: sym('b.ts', 'B', 'class') },
              member('B.ctor', 'constructor', 'public B()'),
              member('B.foo', 'method', 'public void foo()'),
            ],
          },
        ],
        {
          classEdges: [
            {
              from: 'a.ts::A',
              to: 'b.ts::B',
              kind: 'references',
              fromMembers: ['a.ts#A.m1:method:1', 'a.ts#A.m2:method:1'],
              toMembers: ['b.ts#B.ctor:constructor:1', 'b.ts#B.foo:method:1'],
            },
          ],
        },
      ),
    )
    const e = g.edges.find((x) => x.source === 'a.ts::A' && x.target === 'b.ts::B')
    expect(e?.memberLinks).toEqual([
      { source: 'a.ts#A.m1:method:1' },
      { source: 'a.ts#A.m2:method:1' },
      { target: 'b.ts#B.ctor:constructor:1' },
      { target: 'b.ts#B.foo:method:1' },
    ])
  })

  test('references downstream drops PRIVATE members but keeps public/protected (reachable)', () => {
    const meth = (qn: string, signature: string) => ({
      changeType: 'added' as const,
      kind: 'method' as const,
      after: { ...sym('b.ts', qn, 'method'), signature },
    })
    const g = buildStructureGraph(
      diffWith(
        [
          cls('a.ts', 'A'),
          {
            filePath: 'b.ts',
            lang: 'java',
            status: 'ok',
            edges: [],
            impact: [],
            changes: [
              { changeType: 'added', kind: 'class', after: sym('b.ts', 'B', 'class') },
              meth('B.foo', 'public void foo()'),
              meth('B.helper', 'protected void helper()'),
              meth('B.secret', 'private void secret()'),
            ],
          },
        ],
        {
          classEdges: [
            {
              from: 'a.ts::A',
              to: 'b.ts::B',
              kind: 'references',
              toMembers: [
                'b.ts#B.foo:method:1',
                'b.ts#B.helper:method:1',
                'b.ts#B.secret:method:1',
              ],
            },
          ],
        },
      ),
    )
    const e = g.edges.find((x) => x.source === 'a.ts::A' && x.target === 'b.ts::B')
    const targets = (e?.memberLinks ?? []).map((l) => l.target).filter(Boolean)
    expect(targets).toContain('b.ts#B.foo:method:1') // public kept
    expect(targets).toContain('b.ts#B.helper:method:1') // protected kept (subclass-reachable)
    expect(targets).not.toContain('b.ts#B.secret:method:1') // private dropped
  })

  test('a references edge also surfaces the callee methods X calls into D (downstream)', () => {
    const g = buildStructureGraph(
      diffWith(
        [
          cls('a.ts', 'A'),
          {
            filePath: 'b.ts',
            lang: 'typescript',
            status: 'ok',
            edges: [],
            impact: [],
            changes: [
              { changeType: 'added', kind: 'class', after: sym('b.ts', 'B', 'class') },
              { changeType: 'modified', kind: 'method', after: sym('b.ts', 'B.foo', 'method') },
            ],
          },
        ],
        {
          classEdges: [
            {
              from: 'a.ts::A',
              to: 'b.ts::B',
              kind: 'references',
              fromMembers: ['a.ts#A.m:method:1'],
            },
          ],
          impact: [
            {
              changedSymbolId: 'b.ts#B.foo:method:1',
              confidence: 'extracted',
              callers: [
                {
                  symbolId: 'a.ts#A.m:method:3',
                  filePath: 'a.ts',
                  range: { startLine: 3, endLine: 4 },
                },
              ],
            },
          ],
        },
      ),
      new Set(['references']), // calls OFF — yet the callee still shows downstream
    )
    const e = g.edges.find((x) => x.source === 'a.ts::A' && x.target === 'b.ts::B')
    expect(e?.kind).toBe('references')
    expect(e?.memberLinks?.some((l) => l.target === 'b.ts#B.foo:method:1')).toBe(true)
  })

  test('inherits wins over a calls edge for the same pair', () => {
    const g = buildStructureGraph(
      diffWith([cls('a.ts', 'A'), cls('b.ts', 'B')], {
        classEdges: [{ from: 'a.ts::A', to: 'b.ts::B', kind: 'inherits' }],
        impact: [], // even if a call edge existed, inherits ranks higher
      }),
    )
    expect(g.edges.filter((e) => e.source === 'a.ts::A' && e.target === 'b.ts::B')).toHaveLength(1)
    expect(g.edges[0]?.kind).toBe('inherits')
  })

  test('impact yields a caller card + a calls edge', () => {
    const g = buildStructureGraph(
      diffWith(
        [
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
                after: sym('svc.ts', 'Svc.charge', 'method'),
              },
            ],
          },
        ],
        {
          impact: [
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
        },
      ),
    )
    expect(g.cards.find((c) => c.title === 'Checkout')?.isChanged).toBe(false)
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]).toMatchObject({
      source: 'ctrl.ts::Checkout',
      target: 'svc.ts::Svc',
      kind: 'calls',
    })
    // the calls edge records the linked member rows (caller pay → callee charge),
    // so highlighting the edge can also highlight those methods
    expect(g.edges[0]?.memberLinks).toEqual([
      { source: 'ctrl.ts::Checkout::pay', target: 'svc.ts#Svc.charge:method:1' },
    ])
  })
})

describe('buildStructureGraph — hierarchy layout (dagre)', () => {
  test('A → B (A depends on B) puts A above B', () => {
    const g = buildStructureGraph(
      diffWith([cls('a.ts', 'A'), cls('b.ts', 'B')], {
        classEdges: [{ from: 'a.ts::A', to: 'b.ts::B', kind: 'references' }],
      }),
    )
    const a = g.cards.find((c) => c.title === 'A')!
    const b = g.cards.find((c) => c.title === 'B')!
    expect(a.y).toBeLessThan(b.y) // top→down hierarchy
  })
})

test('fileBase strips the directory', () => {
  expect(fileBase('src/a/b.ts')).toBe('b.ts')
})

describe('member visibility + signature', () => {
  test('memberVisibility from the signature keyword (Java) + defaults', () => {
    expect(memberVisibility('public int getScore(GameContext ctx)', 'getScore', 'java')).toBe(
      'public',
    )
    expect(memberVisibility('private Color bg', 'bg', 'java')).toBe('private')
    expect(memberVisibility('protected void run()', 'run', 'java')).toBe('protected')
    expect(memberVisibility('int compute(int x)', 'compute', 'java')).toBe('package') // java default
    expect(memberVisibility('compute(x)', 'compute', 'typescript')).toBe('public') // ts default
  })

  test('memberVisibility language conventions (python `_`, go capitalisation)', () => {
    expect(memberVisibility(undefined, '__secret', 'python')).toBe('private')
    expect(memberVisibility(undefined, '_helper', 'python')).toBe('protected')
    expect(memberVisibility(undefined, 'Exported', 'go')).toBe('public')
    expect(memberVisibility(undefined, 'unexported', 'go')).toBe('private')
  })

  test('memberSignature strips the visibility keyword, keeps params/return', () => {
    expect(memberSignature('public int getScore(GameContext ctx)', 'getScore')).toBe(
      'int getScore(GameContext ctx)',
    )
    expect(memberSignature('private Color backgroundColor;', 'backgroundColor')).toBe(
      'Color backgroundColor',
    )
    expect(memberSignature(undefined, 'foo')).toBe('foo')
  })

  test('groupMembersByVisibility orders public→protected→package→private, callers last', () => {
    const m = (
      id: string,
      visibility: GraphMember['visibility'],
      role: GraphMember['role'] = 'changed',
    ): GraphMember => ({
      id,
      label: id,
      kind: 'method',
      role,
      visibility,
    })
    const groups = groupMembersByVisibility([
      m('a', 'private'),
      m('b', 'public'),
      m('c', undefined, 'caller'),
      m('d', 'protected'),
    ])
    expect(groups.map((g) => g.visibility)).toEqual(['public', 'protected', 'private', 'callers'])
  })
})

describe('package grouping', () => {
  test('cards group into a package per directory', () => {
    const g = buildStructureGraph(
      diffWith([
        cls('src/a/Foo.ts', 'Foo'),
        cls('src/a/Bar.ts', 'Bar'),
        cls('src/b/Baz.ts', 'Baz'),
      ]),
    )
    expect(g.packages.map((p) => p.id).sort()).toEqual(['src/a', 'src/b'])
    expect(g.cards.find((c) => c.title === 'Foo')?.pkg).toBe('src/a')
    expect(g.cards.find((c) => c.title === 'Baz')?.pkg).toBe('src/b')
  })

  test('packageOf / packageLabel', () => {
    expect(packageOf('src/a/b/C.ts')).toBe('src/a/b')
    expect(packageOf('Top.ts')).toBe('(root)')
    // strip the java source root → dotted package
    expect(packageLabel('app/src/main/java/com/wbq/snake/ai')).toBe('com.wbq.snake.ai')
    expect(packageLabel('src/lib/util')).toBe('lib.util')
  })
})

describe('relatedMembers (highlight ONLY the methods an active edge involves)', () => {
  const edges: GraphCardEdge[] = [
    {
      id: 'A=>B',
      source: 'A',
      target: 'B',
      kind: 'calls',
      memberLinks: [{ source: 'A::pay', target: 'B::charge' }],
    },
    // a 'references' edge attributed to the referencing member (source only)
    {
      id: 'C=>D',
      source: 'C',
      target: 'D',
      kind: 'references',
      memberLinks: [{ source: 'C::ctor' }],
    },
    // a class-level edge with NO member info (e.g. inheritance) → highlights nothing
    { id: 'E=>F', source: 'E', target: 'F', kind: 'inherits' },
  ]

  test('calls edge → exactly the caller + callee methods', () => {
    expect([...relatedMembers(edges, new Set(['A=>B']))].sort()).toEqual(['A::pay', 'B::charge'])
  })

  test('references edge → exactly the referencing member (not the whole class)', () => {
    expect([...relatedMembers(edges, new Set(['C=>D']))]).toEqual(['C::ctor'])
  })

  test('edge with no member info → nothing (never a whole class)', () => {
    expect(relatedMembers(edges, new Set(['E=>F'])).size).toBe(0)
  })

  test('no active edge → nothing', () => {
    expect(relatedMembers(edges, new Set()).size).toBe(0)
  })
})
