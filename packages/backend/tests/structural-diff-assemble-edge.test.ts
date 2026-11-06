// RFC-083 / RFC-089 — structural-diff assemble edge coverage.
//
// Locks two correlation/merge branches that the existing tests never exercise:
//
//   1. applyViaImport (assemble.ts:99-118) — the `group:artifact` ARTIFACT-SEGMENT
//      match (line 112-114), the REMOVED-dep short-circuit (line 110), and the
//      `c.length >= 3` floor (line 116). structural-diff-assemble.test.ts only
//      covers a full-name npm miss (zod → false) and a full-name rust hit (tokio
//      via `use tokio::time`); none of the three branches below are touched there.
//
//   2. mergeStructuralDiffs (assemble.ts:211-239) — the N=0 boundary (empty
//      parts → zeroed summary, empty arrays, vacuous callChainAvailable=false)
//      and the N=1 case where label prefixing is STILL applied (no count-based
//      bypass). structural-diff-multi-repo-merge.test.ts only ever calls it with
//      exactly two parts, so both boundaries are unverified.
//
// If any of these flip, the dependency-correlation hint and the multi-repo graph
// namespace silently regress.

import { describe, expect, test } from 'bun:test'
import type {
  StructuralDiff,
  FileStructuralDiff,
  SymbolNode,
  ClassEdge,
} from '@agent-workflow/shared'
import { computeSummary } from '@agent-workflow/shared'
import {
  assembleStructuralDiff,
  mergeStructuralDiffs,
} from '../src/modules/workspace-insight/engine/structuralDiff/assemble'

describe('assembleStructuralDiff — applyViaImport edge branches (RFC-083)', () => {
  test('maven group:artifact dep flips viaImport via the ARTIFACT segment (not full name)', async () => {
    // The Java import token is `com.google.common.Guava` (lowercased contains
    // `guava`). The full dep name `com.google.guava:guava` is NOT a substring of
    // that token, so the only way viaImport flips is the `:`-split artifact
    // candidate `guava` — exercising assemble.ts:112-114.
    const newMap: Record<string, string> = {
      'A.java': 'import com.google.common.Guava;\nclass A {}\n',
      'pom.xml':
        '<project><dependencies><dependency>' +
        '<groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>32</version>' +
        '</dependency></dependencies></project>',
    }
    const diff = await assembleStructuralDiff({
      taskId: 't',
      scope: 'task',
      fromRef: 'a',
      toRef: 'WORKTREE',
      changedFiles: ['A.java', 'pom.xml'],
      readOld: async () => null,
      readNew: async (p) => newMap[p] ?? null,
    })
    const guava = diff.dependencyChanges.find((d) => d.packageName === 'com.google.guava:guava')
    expect(guava?.changeType).toBe('added')
    expect(guava?.viaManifest).toBe(true)
    // matched only via the `guava` artifact segment candidate
    expect(guava?.viaImport).toBe(true)
    // sanity: the full dep name really is NOT contained in the import token, so
    // the artifact-segment branch is what does the work here.
    expect('com.google.common.guava'.includes('com.google.guava:guava')).toBe(false)
  })

  test('a REMOVED dep never flips viaImport, even when an added import mentions it', async () => {
    // old pom declares `org.x:guava`; new pom drops it (changeType 'removed').
    // A Java import whose token contains `guava` is added in the same diff —
    // assemble.ts:110 short-circuits removed deps before the import match.
    const oldMap: Record<string, string> = {
      'pom.xml':
        '<project><dependencies><dependency>' +
        '<groupId>org.x</groupId><artifactId>guava</artifactId><version>1</version>' +
        '</dependency></dependencies></project>',
    }
    const newMap: Record<string, string> = {
      'A.java': 'import some.Guava;\nclass A {}\n',
      'pom.xml': '<project><dependencies></dependencies></project>',
    }
    const diff = await assembleStructuralDiff({
      taskId: 't',
      scope: 'task',
      fromRef: 'a',
      toRef: 'WORKTREE',
      changedFiles: ['A.java', 'pom.xml'],
      readOld: async (p) => oldMap[p] ?? null,
      readNew: async (p) => newMap[p] ?? null,
    })
    const removed = diff.dependencyChanges.find((d) => d.packageName === 'org.x:guava')
    expect(removed?.changeType).toBe('removed')
    expect(removed?.viaImport).toBe(false)
  })

  test('a 2-char package token does NOT match (>=3-char candidate floor)', async () => {
    // npm dep `go` (2 chars). An added TS import `google-stuff` literally
    // contains the substring `go`, so the only thing keeping viaImport false is
    // the `c.length >= 3` floor at assemble.ts:116.
    const newMap: Record<string, string> = {
      'm.ts': 'import x from "google-stuff"\n',
      'package.json': '{"dependencies":{"go":"1"}}',
    }
    const diff = await assembleStructuralDiff({
      taskId: 't',
      scope: 'task',
      fromRef: 'a',
      toRef: 'WORKTREE',
      changedFiles: ['m.ts', 'package.json'],
      readOld: async () => null,
      readNew: async (p) => newMap[p] ?? null,
    })
    const go = diff.dependencyChanges.find((d) => d.packageName === 'go')
    expect(go?.changeType).toBe('added')
    // `go` is a substring of `google-stuff` but only 2 chars → no match
    expect(go?.viaImport).toBe(false)
  })
})

// --- mergeStructuralDiffs boundaries (RFC-089) -----------------------------
// Fixtures mirror structural-diff-multi-repo-merge.test.ts (the model test).

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

describe('mergeStructuralDiffs — N=0 and N=1 boundaries (RFC-089)', () => {
  test('zero parts → empty arrays, zeroed summary, callChainAvailable false', () => {
    const merged = mergeStructuralDiffs(BASE, [])
    expect(merged.files).toEqual([])
    expect(merged.dependencyChanges).toEqual([])
    expect(merged.impact).toEqual([])
    expect(merged.classEdges).toEqual([])
    // parts.some over [] is vacuously false
    expect(merged.callChainAvailable).toBe(false)
    // computeSummary([],[]) — all-zero counts, files: 0
    expect(merged.summary).toEqual(computeSummary([], []))
    // base fields preserved
    expect(merged.scope).toBe('task')
    expect(merged.fromRef).toBe('multi')
    expect(merged.engine).toBe('baseline')
  })

  test('single part is STILL label-prefixed (no N=1 bypass)', () => {
    const merged = mergeStructuralDiffs(BASE, [{ label: 'only', diff: repoDiff() }])
    expect(merged.files).toHaveLength(1)
    expect(merged.files[0]?.filePath).toBe('only/src/x.ts')
    expect(merged.classEdges).toHaveLength(1)
    expect(merged.classEdges[0]?.from).toBe('only/src/x.ts::Foo')
    expect(merged.classEdges[0]?.to).toBe('only/src/x.ts::Bar')
    // impact + symbol ids prefixed too (single-part merge is not a passthrough)
    expect(merged.impact[0]?.changedSymbolId).toBe('only/src/x.ts#Foo:class')
  })
})
