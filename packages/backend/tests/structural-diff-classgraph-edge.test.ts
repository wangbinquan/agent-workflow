// RFC-089 / RFC-083 / RFC-086 — supplementary edge-case locks for the class
// relationship graph (packages/backend/src/modules/workspace-insight/domain/structuralDiff/classGraph.ts).
//
// These cover two SUBTLE NEGATIVE invariants that the existing
// structural-diff-class-graph.test.ts / structural-diff-anon-class.test.ts suites
// never exercise — both are "drop the edge" guards that can silently regress to
// emitting a phantom edge without any current test going red:
//
//  GAP 1 [classgraph-same-name-skip] — computeClassEdges' same-leaf-name guard at
//    classGraph.ts:278 (`if (d.key === c.key || d.name === c.name) continue
//    // skip self + same-name (ambiguous)`). Two CHANGED classes sharing a leaf
//    name (e.g. a.ts::Repo + b.ts::Repo) must NOT get an edge even when one
//    constructs `new Repo()`, because a bare-name regex can't disambiguate which
//    `Repo` is meant — exactly the monorepo / multi-repo name collision RFC-089
//    cares about. The guard is name-specific: rename one to Store and the edge
//    appears.
//
//  GAP 2 [anon-creation-orphan-no-enclosing-container] — computeAnonCreationEdges'
//    walk-up drop at classGraph.ts:192 (`if (cur === undefined) continue`). An
//    anonymous class whose parentId chain never reaches a CONTAINER_KINDS node
//    (anon under a free function with no enclosing class, OR a dangling parentId)
//    must be dropped, so the graph never grows a dangling edge to a non-existent
//    'from' card.

import { describe, expect, test } from 'bun:test'
import {
  computeClassEdges,
  computeAnonCreationEdges,
} from '../src/modules/workspace-insight/domain/structuralDiff/classGraph'
import type { ClassNode } from '../src/modules/workspace-insight/domain/structuralDiff/classGraph'
import type { FileStructuralDiff, SymbolNode } from '@agent-workflow/shared'

const node = (key: string, name: string, file: string, a: number, b: number): ClassNode => ({
  key,
  name,
  file,
  range: { startLine: a, endLine: b },
})

describe('computeClassEdges — same-leaf-name ambiguity guard (classGraph.ts:278)', () => {
  test('two CHANGED classes sharing leaf name "Repo" get NO edge despite new Repo()', () => {
    // a.ts::Repo's body constructs `new Repo()`. Because b.ts::Repo shares the
    // leaf name, the bare-name regex cannot tell which Repo is meant, so the guard
    // suppresses any references/inherits edge between the two.
    const nodes = [
      node('a.ts::Repo', 'Repo', 'a.ts', 1, 3),
      node('b.ts::Repo', 'Repo', 'b.ts', 1, 3),
    ]
    const fileText = new Map([
      ['a.ts', 'class Repo {\n m(){ return new Repo() }\n}'],
      ['b.ts', 'class Repo {}'],
    ])
    expect(computeClassEdges(nodes, fileText)).toEqual([])
  })

  test('renaming the second class to "Store" (distinct name) DOES produce the references edge', () => {
    // Confirms the guard is name-specific, not a blanket suppression: once the
    // names differ, `new Store()` in a.ts::Repo links to b.ts::Store.
    const nodes = [
      node('a.ts::Repo', 'Repo', 'a.ts', 1, 3),
      node('b.ts::Store', 'Store', 'b.ts', 1, 3),
    ]
    const fileText = new Map([
      ['a.ts', 'class Repo {\n m(){ return new Store() }\n}'],
      ['b.ts', 'class Store {}'],
    ])
    expect(computeClassEdges(nodes, fileText)).toEqual([
      { from: 'a.ts::Repo', to: 'b.ts::Store', kind: 'references' },
    ])
  })
})

// Minimal SymbolNode builder for the anon-edge fixtures (mirrors the field set the
// existing class-graph test's `sym()` helper uses).
const sym = (
  over: Partial<SymbolNode> & Pick<SymbolNode, 'id' | 'kind' | 'qualifiedName'>,
): SymbolNode => ({
  name: over.qualifiedName.split('.').pop() ?? over.qualifiedName,
  lang: 'typescript',
  filePath: 'a.ts',
  confidence: 'extracted',
  ...over,
})

const fileWith = (changes: SymbolNode[]): FileStructuralDiff => ({
  filePath: 'a.ts',
  lang: 'typescript',
  status: 'ok',
  edges: [],
  impact: [],
  changes: changes.map((after) => ({ changeType: 'added', kind: after.kind, after })),
})

describe('computeAnonCreationEdges — orphan anon with no enclosing container (classGraph.ts:192)', () => {
  test('anon class under a free function (no enclosing class) is dropped → []', () => {
    // `make` is a top-level function (a MEMBER_KIND, not a CONTAINER_KIND). The anon
    // class' parentId points at `make`; the walk sets creator=make then walks to
    // undefined (make has no parent) → cur === undefined → edge skipped.
    const make: SymbolNode = sym({
      id: 'a.ts#make:function',
      kind: 'function',
      qualifiedName: 'make',
    })
    const anon: SymbolNode = sym({
      id: 'a.ts#make.$anon1_1:class',
      kind: 'class',
      qualifiedName: 'make.$anon1_1',
      name: 'Base',
      anonymous: true,
      parentId: make.id,
    })
    expect(computeAnonCreationEdges([fileWith([make, anon])])).toEqual([])
  })

  test('anon class with a DANGLING parentId (absent from the change set) is dropped → []', () => {
    // byId.get('NONEXISTENT_ID') is undefined → cur starts undefined → the walk-up
    // loop body never runs → line 192 fires → no edge.
    const anon: SymbolNode = sym({
      id: 'a.ts#orphan.$anon1_1:class',
      kind: 'class',
      qualifiedName: 'orphan.$anon1_1',
      name: 'Base',
      anonymous: true,
      parentId: 'NONEXISTENT_ID',
    })
    expect(computeAnonCreationEdges([fileWith([anon])])).toEqual([])
  })
})
