// RFC-083 PR-A — locks the pure symbol-graph set-diff (`graphDiff`) and summary
// aggregation. These are the deterministic core of the structural-diff feature;
// if a future refactor of the extraction layer changes identity/rename
// semantics, these go red and show intent. No tree-sitter / I/O here — graphs
// are hand-built, which is exactly the assertable surface the RFC calls for.

import { describe, expect, test } from 'bun:test'
import {
  graphDiff,
  computeSummary,
  normalizeSignature,
  nameSimilarity,
  type SymbolNode,
  type SymbolKind,
  type FileStructuralDiff,
  type DependencyChange,
} from '@agent-workflow/shared'

let seq = 0
function sym(p: Partial<SymbolNode> & { kind: SymbolKind; qualifiedName: string }): SymbolNode {
  seq += 1
  const name = p.name ?? p.qualifiedName.split('.').pop() ?? p.qualifiedName
  return {
    id: p.id ?? `${p.filePath ?? 'f.ts'}#${p.qualifiedName}:${p.kind}:${seq}`,
    kind: p.kind,
    name,
    qualifiedName: p.qualifiedName,
    signature: p.signature,
    bodyHash: p.bodyHash,
    lang: p.lang ?? 'typescript',
    filePath: p.filePath ?? 'f.ts',
    range: p.range,
    parentId: p.parentId,
    confidence: p.confidence ?? 'extracted',
    degraded: p.degraded,
  }
}

describe('graphDiff — add / remove / unchanged', () => {
  test('added: in new only', () => {
    const out = graphDiff([], [sym({ kind: 'method', qualifiedName: 'A.foo', bodyHash: 'h1' })])
    expect(out).toHaveLength(1)
    expect(out[0]?.changeType).toBe('added')
    expect(out[0]?.after?.qualifiedName).toBe('A.foo')
  })

  test('removed: in old only', () => {
    const out = graphDiff([sym({ kind: 'field', qualifiedName: 'A.x', bodyHash: 'h1' })], [])
    expect(out).toHaveLength(1)
    expect(out[0]?.changeType).toBe('removed')
    expect(out[0]?.before?.qualifiedName).toBe('A.x')
  })

  test('unchanged: identical identity + bodyHash emits nothing', () => {
    const a = sym({ kind: 'method', qualifiedName: 'A.foo', signature: '(x: int)', bodyHash: 'h1' })
    const b = sym({ kind: 'method', qualifiedName: 'A.foo', signature: '(x: int)', bodyHash: 'h1' })
    expect(graphDiff([a], [b])).toEqual([])
  })

  test('unchanged: both bodyHash undefined → no false-positive modify', () => {
    const a = sym({ kind: 'class', qualifiedName: 'A', signature: 'class A' })
    const b = sym({ kind: 'class', qualifiedName: 'A', signature: 'class A' })
    expect(graphDiff([a], [b])).toEqual([])
  })
})

describe('graphDiff — modified', () => {
  test('body changed (same identity) → modified + bodyChanged', () => {
    const a = sym({ kind: 'method', qualifiedName: 'A.foo', signature: '(x: int)', bodyHash: 'h1' })
    const b = sym({ kind: 'method', qualifiedName: 'A.foo', signature: '(x: int)', bodyHash: 'h2' })
    const out = graphDiff([a], [b])
    expect(out).toHaveLength(1)
    expect(out[0]?.changeType).toBe('modified')
    expect(out[0]?.bodyChanged).toBe(true)
    expect(out[0]?.signatureChanged).toBe(false)
  })

  test('signature changed, same name+body → phase-2 modified (not add+remove)', () => {
    const a = sym({ kind: 'method', qualifiedName: 'A.foo', signature: '(x: int)', bodyHash: 'h1' })
    const b = sym({
      kind: 'method',
      qualifiedName: 'A.foo',
      signature: '(x: long)',
      bodyHash: 'h1',
    })
    const out = graphDiff([a], [b])
    expect(out).toHaveLength(1)
    expect(out[0]?.changeType).toBe('modified')
    expect(out[0]?.signatureChanged).toBe(true)
    expect(out[0]?.bodyChanged).toBe(false)
  })
})

describe('graphDiff — rename / move', () => {
  test('renamed: identical body, different name → renamed (phase 3a)', () => {
    const a = sym({ kind: 'function', qualifiedName: 'calc', bodyHash: 'hbody' })
    const b = sym({ kind: 'function', qualifiedName: 'compute', bodyHash: 'hbody' })
    const out = graphDiff([a], [b])
    expect(out).toHaveLength(1)
    expect(out[0]?.changeType).toBe('renamed')
    expect(out[0]?.renamedFrom).toBe('calc')
    expect(out[0]?.after?.qualifiedName).toBe('compute')
  })

  test('moved: same leaf name, different container/file → moved', () => {
    const a = sym({
      kind: 'method',
      qualifiedName: 'A.ping',
      name: 'ping',
      parentId: 'clsA',
      filePath: 'a.ts',
      bodyHash: 'hbody',
    })
    const b = sym({
      kind: 'method',
      qualifiedName: 'B.ping',
      name: 'ping',
      parentId: 'clsB',
      filePath: 'b.ts',
      bodyHash: 'hbody',
    })
    const out = graphDiff([a], [b])
    expect(out).toHaveLength(1)
    expect(out[0]?.changeType).toBe('moved')
    expect(out[0]?.renamedFrom).toBe('A.ping')
  })

  test('fuzzy rename: similar name, different body → renamed (phase 3b)', () => {
    const a = sym({ kind: 'function', qualifiedName: 'getUserName', bodyHash: 'h1' })
    const b = sym({ kind: 'function', qualifiedName: 'getUsername', bodyHash: 'h2' })
    const out = graphDiff([a], [b])
    expect(out).toHaveLength(1)
    expect(out[0]?.changeType).toBe('renamed')
    expect(out[0]?.renamedFrom).toBe('getUserName')
  })

  test('dissimilar names + different body → add + remove (no false rename)', () => {
    const a = sym({ kind: 'function', qualifiedName: 'alpha', bodyHash: 'h1' })
    const b = sym({ kind: 'function', qualifiedName: 'zzzzz', bodyHash: 'h2' })
    const out = graphDiff([a], [b])
    expect(out.map((c) => c.changeType).sort()).toEqual(['added', 'removed'])
  })
})

describe('graphDiff — overloads stay distinct', () => {
  test('two same-name overloads unchanged → no changes', () => {
    const olds = [
      sym({ kind: 'method', qualifiedName: 'A.run', signature: '(x: int)', bodyHash: 'h1' }),
      sym({ kind: 'method', qualifiedName: 'A.run', signature: '(x: str)', bodyHash: 'h2' }),
    ]
    const news = [
      sym({ kind: 'method', qualifiedName: 'A.run', signature: '(x: int)', bodyHash: 'h1' }),
      sym({ kind: 'method', qualifiedName: 'A.run', signature: '(x: str)', bodyHash: 'h2' }),
    ]
    expect(graphDiff(olds, news)).toEqual([])
  })

  test('removing one overload → exactly one removed', () => {
    const olds = [
      sym({ kind: 'method', qualifiedName: 'A.run', signature: '(x: int)', bodyHash: 'h1' }),
      sym({ kind: 'method', qualifiedName: 'A.run', signature: '(x: str)', bodyHash: 'h2' }),
    ]
    const news = [
      sym({ kind: 'method', qualifiedName: 'A.run', signature: '(x: int)', bodyHash: 'h1' }),
    ]
    const out = graphDiff(olds, news)
    expect(out).toHaveLength(1)
    expect(out[0]?.changeType).toBe('removed')
    expect(normalizeSignature(out[0]?.before?.signature)).toBe('(x: str)')
  })
})

describe('helpers', () => {
  test('normalizeSignature collapses whitespace', () => {
    expect(normalizeSignature('  (x:   int,\n y: long )  ')).toBe('(x: int, y: long )')
    expect(normalizeSignature(undefined)).toBe('')
  })

  test('nameSimilarity', () => {
    expect(nameSimilarity('abc', 'abc')).toBe(1)
    expect(nameSimilarity('', '')).toBe(1)
    expect(nameSimilarity('getUserName', 'getUsername')).toBeGreaterThan(0.85)
    expect(nameSimilarity('alpha', 'zzzzz')).toBeLessThan(0.3)
  })
})

describe('computeSummary', () => {
  test('aggregates per category + dependencies', () => {
    const files: FileStructuralDiff[] = [
      {
        filePath: 'a.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          { changeType: 'added', kind: 'class' },
          { changeType: 'modified', kind: 'interface' },
          { changeType: 'added', kind: 'method' },
          { changeType: 'removed', kind: 'function' },
          { changeType: 'renamed', kind: 'method' },
          { changeType: 'added', kind: 'field' },
          { changeType: 'moved', kind: 'property' },
          { changeType: 'added', kind: 'import' },
        ],
      },
      {
        filePath: 'b.cpp',
        lang: 'cpp',
        status: 'degraded',
        edges: [],
        impact: [],
        changes: [{ changeType: 'added', kind: 'struct' }],
      },
    ]
    const deps: DependencyChange[] = [
      {
        ecosystem: 'cargo',
        packageName: 'tokio',
        changeType: 'added',
        viaManifest: true,
        viaImport: true,
      },
      {
        ecosystem: 'cargo',
        packageName: 'old',
        changeType: 'removed',
        viaManifest: true,
        viaImport: false,
      },
      {
        ecosystem: 'npm',
        packageName: 'left',
        changeType: 'updated',
        viaManifest: true,
        viaImport: false,
      },
    ]
    const s = computeSummary(files, deps)
    expect(s.files).toBe(2)
    expect(s.classes).toEqual({ added: 2, modified: 1, removed: 0, renamed: 0 }) // class+interface+struct
    expect(s.methods).toEqual({ added: 1, modified: 0, removed: 1, renamed: 1 }) // method+function
    expect(s.fields).toEqual({ added: 1, modified: 0, removed: 0, renamed: 1 }) // field+property(moved→renamed)
    expect(s.imports).toEqual({ added: 1, modified: 0, removed: 0, renamed: 0 })
    expect(s.dependencies).toEqual({ added: 1, modified: 1, removed: 1, renamed: 0 }) // updated→modified
  })

  test('empty input', () => {
    expect(computeSummary([], [])).toEqual({
      files: 0,
      classes: { added: 0, modified: 0, removed: 0, renamed: 0 },
      methods: { added: 0, modified: 0, removed: 0, renamed: 0 },
      fields: { added: 0, modified: 0, removed: 0, renamed: 0 },
      imports: { added: 0, modified: 0, removed: 0, renamed: 0 },
      dependencies: { added: 0, modified: 0, removed: 0, renamed: 0 },
    })
  })
})
