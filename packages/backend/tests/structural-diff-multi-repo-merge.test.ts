// RFC-089 P2 — mergeStructuralDiffs must produce ONE consistent label-prefixed
// id namespace for multi-repo tasks, so the class graph's cards (built from a
// symbol's OWN filePath: `${sym.filePath}::${qn}`) line up with classEdges, and
// same-path files across repos never collide. Pre-RFC-089 the merge prefixed
// only `file.filePath` and DROPPED classEdges (`classEdges: []`) because the
// edge keys no longer matched the prefixed cards — this locks the fix.

import { describe, expect, test } from 'bun:test'
import type {
  StructuralDiff,
  FileStructuralDiff,
  SymbolNode,
  ClassEdge,
} from '@agent-workflow/shared'
import { computeSummary } from '@agent-workflow/shared'
import { mergeStructuralDiffs, prefixIdPath } from '../src/services/structuralDiff/assemble'

function sym(filePath: string, qn: string, kind: 'class' | 'method'): SymbolNode {
  return {
    id: `${filePath}#${qn}:${kind}`,
    kind,
    name: qn.slice(qn.lastIndexOf('.') + 1),
    qualifiedName: qn,
    lang: 'typescript',
    filePath,
    confidence: 'extracted',
  }
}

// One per-repo diff: file `src/x.ts` adds class `Foo` (+ method `Foo.m`), Foo
// inherits Bar, plus an impact item pointing back at Foo. Same shape per repo so
// the merge is exercised on identical paths/names (the collision case).
function repoDiff(): StructuralDiff {
  const foo = sym('src/x.ts', 'Foo', 'class')
  const fooM: SymbolNode = { ...sym('src/x.ts', 'Foo.m', 'method'), parentId: foo.id }
  const file: FileStructuralDiff = {
    filePath: 'src/x.ts',
    lang: 'typescript',
    status: 'ok',
    changes: [
      { changeType: 'added', kind: 'class', after: foo },
      { changeType: 'added', kind: 'method', after: fooM },
    ],
    edges: [{ from: fooM.id, to: 'src/x.ts#Bar.q:method', kind: 'calls', confidence: 'extracted' }],
    impact: [
      {
        changedSymbolId: foo.id,
        callers: [{ symbolId: fooM.id, filePath: 'src/x.ts', range: { startLine: 1, endLine: 2 } }],
        confidence: 'extracted',
      },
    ],
  }
  const edge: ClassEdge = {
    from: 'src/x.ts::Foo',
    to: 'src/x.ts::Bar',
    kind: 'inherits',
    fromMembers: [fooM.id],
    toMembers: ['src/x.ts#Bar.q:method'],
  }
  return {
    scope: 'task',
    taskId: 't1',
    fromRef: 'A',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files: [file],
    dependencyChanges: [],
    impact: file.impact,
    classEdges: [edge],
    summary: computeSummary([file], []),
  }
}

const BASE = {
  scope: 'task' as const,
  taskId: 't1',
  fromRef: 'multi',
  toRef: 'WORKTREE',
  engine: 'baseline' as const,
  status: 'ok' as const,
}

describe('prefixIdPath', () => {
  test('prefixes the filePath segment of a symbol id (delim #)', () => {
    expect(prefixIdPath('repo-a', 'src/x.ts#Foo:class', '#')).toBe('repo-a/src/x.ts#Foo:class')
  })
  test('prefixes the filePath segment of a card id (delim ::)', () => {
    expect(prefixIdPath('repo-a', 'src/x.ts::Foo', '::')).toBe('repo-a/src/x.ts::Foo')
  })
  test('prefixes a bare path (no delimiter) whole', () => {
    expect(prefixIdPath('repo-a', 'src/x.ts', '#')).toBe('repo-a/src/x.ts')
  })
  test('splits on the FIRST delimiter only', () => {
    expect(prefixIdPath('r', 'a/b.ts#X#Y', '#')).toBe('r/a/b.ts#X#Y')
  })
})

describe('mergeStructuralDiffs — RFC-089 P2 prefixing', () => {
  const merged = mergeStructuralDiffs(BASE, [
    { label: 'repo-a', diff: repoDiff() },
    { label: 'repo-b', diff: repoDiff() },
  ])

  test('classEdges are NOT dropped and are label-prefixed per repo', () => {
    expect(merged.classEdges).toHaveLength(2)
    expect(merged.classEdges.map((e) => e.from).sort()).toEqual([
      'repo-a/src/x.ts::Foo',
      'repo-b/src/x.ts::Foo',
    ])
    expect(merged.classEdges[0]?.fromMembers).toEqual(['repo-a/src/x.ts#Foo.m:method'])
    expect(merged.classEdges[0]?.toMembers).toEqual(['repo-a/src/x.ts#Bar.q:method'])
  })

  test('file paths + symbol ids/parentIds are prefixed', () => {
    expect(merged.files.map((f) => f.filePath).sort()).toEqual([
      'repo-a/src/x.ts',
      'repo-b/src/x.ts',
    ])
    const aMethod = merged.files
      .find((f) => f.filePath === 'repo-a/src/x.ts')!
      .changes.find((c) => c.kind === 'method')!
    expect(aMethod.after?.id).toBe('repo-a/src/x.ts#Foo.m:method')
    expect(aMethod.after?.parentId).toBe('repo-a/src/x.ts#Foo:class')
    expect(aMethod.after?.filePath).toBe('repo-a/src/x.ts')
  })

  test('impact + file edges are prefixed', () => {
    const i = merged.impact.find((x) => x.changedSymbolId.startsWith('repo-a/'))!
    expect(i.changedSymbolId).toBe('repo-a/src/x.ts#Foo:class')
    expect(i.callers[0]?.symbolId).toBe('repo-a/src/x.ts#Foo.m:method')
    expect(i.callers[0]?.filePath).toBe('repo-a/src/x.ts')
    const aEdge = merged.files.find((f) => f.filePath === 'repo-a/src/x.ts')!.edges[0]!
    expect(aEdge.from).toBe('repo-a/src/x.ts#Foo.m:method')
  })

  test('GRAPH CONSISTENCY: classEdge endpoint == the card id the graph derives from the matching symbol', () => {
    // The exact invariant the pre-fix code violated: the graph builds a card id
    // as `${sym.filePath}::${qn}`; the edge endpoint must equal that, or the
    // edge dangles (which is why classEdges had to be emptied for multi-repo).
    const edge = merged.classEdges.find((e) => e.from === 'repo-a/src/x.ts::Foo')!
    const fooSym = merged.files
      .find((f) => f.filePath === 'repo-a/src/x.ts')!
      .changes.find((c) => c.kind === 'class')!.after!
    expect(`${fooSym.filePath}::${fooSym.qualifiedName}`).toBe(edge.from)
  })

  test('same-path same-name classes across repos do NOT collide', () => {
    expect(new Set(merged.classEdges.map((e) => e.from)).size).toBe(2)
  })
})
