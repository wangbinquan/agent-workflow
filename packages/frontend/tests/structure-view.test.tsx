// RFC-083 PR-D — structureView pure helpers (summaryRows / groupFileChanges /
// badges / signature tokens / file tree). The <StructuralDiffView> render
// sections that used to live here moved to change-review-panel.test.tsx when
// RFC-239 merged the view into the unified changes panel.

import { describe, expect, test } from 'vitest'
import { computeSummary } from '@agent-workflow/shared'
import type {
  FileStructuralDiff,
  StructuralDiff,
  SymbolNode,
  DependencyChange,
} from '@agent-workflow/shared'
import {
  summaryRows,
  groupFileChanges,
  badgeSymbol,
  fileTreeRows,
  diffSignatureTokens,
} from '../src/lib/structureView'

function sym(qn: string, kind: SymbolNode['kind'], degraded = false): SymbolNode {
  return {
    id: `f#${qn}:${kind}`,
    kind,
    name: qn.split('.').pop() ?? qn,
    qualifiedName: qn,
    lang: 'python',
    filePath: 'mod.py',
    confidence: degraded ? 'inferred' : 'extracted',
    degraded: degraded || undefined,
  }
}

function sampleDiff(): StructuralDiff {
  const files: FileStructuralDiff[] = [
    {
      filePath: 'mod.py',
      lang: 'python',
      status: 'ok',
      edges: [],
      impact: [],
      changes: [
        {
          changeType: 'modified',
          kind: 'method',
          after: sym('Animal.speak', 'method'),
          bodyChanged: true,
        },
        { changeType: 'added', kind: 'method', after: sym('Animal.walk', 'method') },
        { changeType: 'removed', kind: 'field', before: sym('Animal.legs', 'field') },
      ],
    },
    {
      filePath: 'w.cpp',
      lang: 'cpp',
      status: 'degraded',
      edges: [],
      impact: [],
      changes: [{ changeType: 'added', kind: 'class', after: sym('Widget', 'class', true) }],
    },
  ]
  const deps: DependencyChange[] = [
    {
      ecosystem: 'cargo',
      packageName: 'tokio',
      changeType: 'added',
      viaManifest: true,
      viaImport: false,
      versionAfter: '1.0',
    },
  ]
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files,
    dependencyChanges: deps,
    impact: [],
    classEdges: [],
    summary: computeSummary(files, deps),
  }
}

describe('structureView helpers', () => {
  test('summaryRows skips empty categories', () => {
    const s = computeSummary(sampleDiff().files, sampleDiff().dependencyChanges)
    const keys = summaryRows(s).map((r) => r.key)
    expect(keys).toContain('methods')
    expect(keys).toContain('fields')
    expect(keys).toContain('dependencies')
    expect(keys).not.toContain('imports') // none changed
  })

  test('groupFileChanges groups members under their container', () => {
    const file = sampleDiff().files[0]!
    const groups = groupFileChanges(file)
    const animal = groups.find((g) => g.container === 'Animal')
    expect(animal?.changes).toHaveLength(3)
  })

  test('badgeSymbol mapping', () => {
    expect(badgeSymbol('added')).toBe('+')
    expect(badgeSymbol('removed')).toBe('−')
    expect(badgeSymbol('modified')).toBe('~')
    expect(badgeSymbol('renamed')).toBe('→')
  })

  test('diffSignatureTokens splits into before/after rows; tokens reassemble', () => {
    const d = diffSignatureTokens('(a: number): void', '(a: string, b: number): void')
    expect(d).not.toBeNull()
    // removed-flagged tokens live ONLY on the before row, added ONLY on after
    expect(d!.before.some((t) => t.kind === 'added')).toBe(false)
    expect(d!.after.some((t) => t.kind === 'removed')).toBe(false)
    expect(d!.after.some((t) => t.kind === 'added')).toBe(true)
    // lossless: each row's tokens reassemble the original signature
    expect(d!.before.map((t) => t.text).join('')).toBe('(a: number): void')
    expect(d!.after.map((t) => t.text).join('')).toBe('(a: string, b: number): void')
  })

  test('diffSignatureTokens returns null when there is nothing to compare', () => {
    expect(diffSignatureTokens('(x)', '(x)')).toBeNull() // identical
    expect(diffSignatureTokens(undefined, '(x)')).toBeNull() // missing side
    expect(diffSignatureTokens('(x)', '')).toBeNull()
  })

  test('fileTreeRows groups by directory + compacts single-child chains', () => {
    const rows = fileTreeRows([
      { filePath: 'src/main/java/com/x/A.ts' },
      { filePath: 'src/main/java/com/x/B.ts' },
      { filePath: 'Top.ts' },
    ])
    // the deep single-child chain collapses to one directory row
    expect(rows.find((r) => r.fileIndex === undefined)?.name).toBe('src/main/java/com/x')
    // files render as basenames, indented under their directory
    const a = rows.find((r) => r.name === 'A.ts')
    expect(a?.fileIndex).toBe(0)
    expect(a?.depth).toBeGreaterThan(0)
    // a top-level file stays at depth 0
    expect(rows.find((r) => r.name === 'Top.ts')?.depth).toBe(0)
  })
})

// RFC-239 — the <StructuralDiffView> render sections that used to live here
// moved to change-review-panel.test.tsx (the view merged into the unified
// changes panel). The pure structureView helpers above are still consumed by
// the new panel (badges, signature tokens, file tree), so their locks stay.
