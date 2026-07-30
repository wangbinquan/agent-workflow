// RFC-239 — pure-function matrices for the unified change view:
//  - buildChangeEntries: text/structural join (multi-repo label alignment,
//    single-side retention, kind classification, rename + pureMove, viewed-key
//    byte-compat with the pre-merge format)
//  - parseHunks / blockTextStats
//  - hunkForSymbol / symbolAtLine (design gate P0-1 input domain: moved side
//    choice, empty zero-count ranges, missing range → null, endpoint-equality
//    overlap, nearest-hunk tie-break to the smaller start)

import { describe, expect, test } from 'vitest'
import type {
  FileStructuralDiff,
  StructuralDiff,
  SymbolChange,
  SymbolNode,
} from '@agent-workflow/shared'
import { computeSummary } from '@agent-workflow/shared'
import { splitByRepo } from '../src/components/DiffViewer'
import {
  blockTextStats,
  buildChangeEntries,
  buildDiffSegments,
  parseHunks,
  toGroupEntries,
} from '../src/lib/changeReview'
import { hunkForSymbol, symbolAtLine } from '../src/lib/hunkSymbolMap'
import type { HunkInfo } from '../src/lib/changeReview'

const node = (
  qn: string,
  opts: {
    kind?: SymbolNode['kind']
    file?: string
    start?: number
    end?: number
    noRange?: boolean
  } = {},
): SymbolNode => ({
  id: `${opts.file ?? 'f.ts'}#${qn}:${opts.kind ?? 'method'}:${opts.start ?? 1}`,
  kind: opts.kind ?? 'method',
  name: qn.split('.').pop() ?? qn,
  qualifiedName: qn,
  lang: 'typescript',
  filePath: opts.file ?? 'f.ts',
  confidence: 'extracted',
  ...(opts.noRange === true
    ? {}
    : { range: { startLine: opts.start ?? 1, endLine: opts.end ?? (opts.start ?? 1) + 4 } }),
})

function structuralWith(files: FileStructuralDiff[]): StructuralDiff {
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files,
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: computeSummary(files, []),
  }
}

describe('parseHunks / blockTextStats', () => {
  test('parses multi-hunk headers with implicit counts; stats count ± lines only', () => {
    const lines = [
      'diff --git a/f.ts b/f.ts',
      'index 1..2 100644',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -3,2 +3,4 @@',
      ' ctx',
      '+added one',
      '+added two',
      '-removed',
      '@@ -20 +22,0 @@',
      '-only removal',
    ]
    const hunks = parseHunks(lines)
    expect(hunks).toEqual([
      { headerIndex: 4, oldStart: 3, oldCount: 2, newStart: 3, newCount: 4 },
      { headerIndex: 9, oldStart: 20, oldCount: 1, newStart: 22, newCount: 0 },
    ])
    expect(blockTextStats(lines)).toEqual({ added: 2, removed: 2 })
  })
})

describe('buildChangeEntries — join', () => {
  const MULTI = `# === Repo: alpha ===
diff --git a/src/x.ts b/src/x.ts
@@ -1,1 +1,1 @@
-a
+b
# === Repo: beta ===
diff --git a/docs/note.md b/docs/note.md
@@ -1,0 +1,2 @@
+hello
+world
`

  test('multi-repo: structural label/ prefixes join by exact label; kinds classify', () => {
    const structural = structuralWith([
      {
        filePath: 'alpha/src/x.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          {
            changeType: 'modified',
            kind: 'method',
            after: node('X.m', { file: 'alpha/src/x.ts' }),
          },
        ],
      },
    ])
    const entries = buildChangeEntries(splitByRepo(MULTI), structural)
    const x = entries.find((e) => e.key === 'alpha/src/x.ts')
    expect(x?.structural).toBeDefined()
    expect(x?.kind).toBe('code')
    expect(x?.viewedKey).toBe('alpha::src/x.ts')
    const md = entries.find((e) => e.key === 'beta/docs/note.md')
    expect(md?.kind).toBe('doc')
    expect(md?.structural).toBeUndefined()
    expect(md?.textStats).toEqual({ added: 2, removed: 0 })
  })

  test('structural-only files (text truncated away) are retained with empty hunks', () => {
    const structural = structuralWith([
      {
        filePath: 'lost.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [{ changeType: 'added', kind: 'method', after: node('L.m', { file: 'lost.ts' }) }],
      },
    ])
    const entries = buildChangeEntries(splitByRepo(''), structural)
    expect(entries.map((e) => e.key)).toEqual(['lost.ts'])
    expect(entries[0]?.hunks).toEqual([])
    expect(entries[0]?.block).toBeUndefined()
  })

  test('rename: header `old → new` places the file at the new path with renamedFrom; zero-change rename is a pureMove', () => {
    const RENAME = `diff --git a/old/name.md b/new/name.md
similarity index 100%
rename from old/name.md
rename to new/name.md
`
    const entries = buildChangeEntries(splitByRepo(RENAME), undefined)
    expect(entries[0]?.filePath).toBe('new/name.md')
    expect(entries[0]?.renamedFrom).toBe('old/name.md')
    expect(entries[0]?.pureMove).toBe(true)
    // viewed key stays the FULL pre-merge header form (`old → new`)
    expect(entries[0]?.viewedKey).toBe('old/name.md → new/name.md')
  })

  test('toGroupEntries folds renamed+moved symbol counts and forwards severity', () => {
    const structural = structuralWith([
      {
        filePath: 'f.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          { changeType: 'renamed', kind: 'method', after: node('A.x'), before: node('A.y') },
          { changeType: 'moved', kind: 'method', after: node('A.z'), before: node('B.z') },
        ],
      },
    ])
    const SIMPLE = `diff --git a/f.ts b/f.ts
@@ -1,1 +1,1 @@
-a
+b
`
    const groupEntries = toGroupEntries(buildChangeEntries(splitByRepo(SIMPLE), structural))
    expect(groupEntries[0]?.symbolCounts).toEqual({ added: 0, modified: 0, removed: 0, renamed: 2 })
    expect(groupEntries[0]?.severity.risky).toBeGreaterThan(0)
  })
})

describe('hunkForSymbol — P0-1 input domain', () => {
  const hunks: HunkInfo[] = [
    { headerIndex: 4, oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 },
    { headerIndex: 10, oldStart: 40, oldCount: 0, newStart: 41, newCount: 5 }, // pure add
    { headerIndex: 16, oldStart: 90, oldCount: 4, newStart: 95, newCount: 0 }, // pure delete
  ]
  const change = (
    ct: SymbolChange['changeType'],
    opts: { before?: SymbolNode; after?: SymbolNode } = {},
  ): SymbolChange => ({ changeType: ct, kind: 'method', ...opts })

  test('declaration untouched, body-deep change → nearest hunk (not null)', () => {
    // symbol spans 20..30; no hunk overlaps; nearest by new-side distance is
    // hunk[1] (start 41, distance 11) vs hunk[0] (end 3, distance 17)
    const c = change('modified', { after: node('A.m', { start: 20, end: 30 }) })
    expect(hunkForSymbol(c, hunks)).toBe(hunks[1])
  })

  test('moved picks the after/new side; removed picks before/old; empty sides never match', () => {
    const moved = change('moved', {
      before: node('B.m', { start: 90, end: 93 }),
      after: node('A.m', { start: 42, end: 44 }),
    })
    expect(hunkForSymbol(moved, hunks)).toBe(hunks[1]) // overlap on the NEW side
    const removed = change('removed', { before: node('B.m', { start: 91, end: 92 }) })
    expect(hunkForSymbol(removed, hunks)).toBe(hunks[2]) // old side of the pure delete
    // a pure-delete hunk has an EMPTY new side: an added symbol at 95.. must
    // not match it via the new side
    const added = change('added', { after: node('C.m', { start: 96, end: 97 }) })
    expect(hunkForSymbol(added, hunks)).not.toBe(hunks[0])
  })

  test('endpoint equality overlaps; missing range / no hunks → null', () => {
    const touch = change('modified', { after: node('A.m', { start: 3, end: 3 }) })
    expect(hunkForSymbol(touch, hunks)).toBe(hunks[0])
    const noRange = change('modified', { after: node('A.m', { noRange: true }) })
    expect(hunkForSymbol(noRange, hunks)).toBeNull()
    expect(hunkForSymbol(touch, [])).toBeNull()
  })
})

describe('symbolAtLine', () => {
  test('innermost (smallest span) symbol wins; side picks the node', () => {
    const outer: SymbolChange = {
      changeType: 'modified',
      kind: 'class',
      after: node('A', { kind: 'class', start: 1, end: 50 }),
    }
    const inner: SymbolChange = {
      changeType: 'modified',
      kind: 'method',
      after: node('A.m', { start: 10, end: 20 }),
    }
    expect(symbolAtLine([outer, inner], 'new', 15)).toBe(inner)
    expect(symbolAtLine([outer, inner], 'new', 40)).toBe(outer)
    expect(symbolAtLine([outer, inner], 'new', 99)).toBeNull()
  })
})

// impl-gate P2 regressions
describe('buildDiffSegments (impl-gate P2: bodies must stay with their hunk)', () => {
  test('two hunks → preamble + one segment per hunk spanning through the next header', () => {
    const lines = [
      'diff --git a/f b/f', // 0
      'index 1..2', // 1
      '@@ -1,1 +1,1 @@', // 2
      '-a', // 3
      '+b', // 4
      '@@ -9,1 +9,1 @@', // 5
      '-c', // 6
      '+d', // 7
    ]
    const hunks = parseHunks(lines)
    const segments = buildDiffSegments(lines, hunks)
    expect(segments).toEqual([
      { start: 0, end: 2, hunk: null },
      { start: 2, end: 5, hunk: hunks[0] },
      { start: 5, end: 8, hunk: hunks[1] },
    ])
    // every hunk body line lives inside its own hunk's segment
    expect(segments[1]?.start).toBe(2)
    expect(segments[1]?.end).toBe(5)
  })

  test('no hunks → one null segment covering the whole block', () => {
    expect(buildDiffSegments(['x', 'y'], [])).toEqual([{ start: 0, end: 2, hunk: null }])
  })
})

describe('buildChangeEntries — structural-only multi-repo identity (impl-gate P2)', () => {
  test("fromRef='multi' keeps label/rel keys split when the text diff is gone", () => {
    const structural = structuralWith([
      {
        filePath: 'alpha/src/x.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          { changeType: 'added', kind: 'method', after: node('X.m', { file: 'alpha/src/x.ts' }) },
        ],
      },
    ])
    const entries = buildChangeEntries(splitByRepo(''), { ...structural, fromRef: 'multi' })
    expect(entries[0]?.repoLabel).toBe('alpha')
    expect(entries[0]?.filePath).toBe('src/x.ts')
    expect(entries[0]?.viewedKey).toBe('alpha::src/x.ts')
  })
})
