// RFC-083 PR-D — structural-diff view: pure helpers (summaryRows / groupFileChanges
// / badges) + a render smoke that the tree, badges, dependency panel, degraded
// banner, and per-file selection all wire up. Assertions are language-agnostic
// (symbol/package names, badge glyphs, ARIA roles) so i18n changes don't flake.

import { describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { computeSummary } from '@agent-workflow/shared'
import type {
  FileStructuralDiff,
  StructuralDiff,
  SymbolNode,
  DependencyChange,
} from '@agent-workflow/shared'
import '../src/i18n'
import { StructuralDiffView } from '../src/components/structure/StructuralDiffView'
import {
  summaryRows,
  groupFileChanges,
  badgeSymbol,
  fileTreeRows,
  diffSignatureTokens,
} from '../src/lib/structureView'

afterEach(() => cleanup())

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

describe('<StructuralDiffView />', () => {
  test('renders tree, badges, and degraded banner', () => {
    render(<StructuralDiffView data={sampleDiff()} />)
    // left file list shows both changed files
    expect(screen.getByText('mod.py')).toBeTruthy()
    expect(screen.getByText('w.cpp')).toBeTruthy()
    // selected file (first) shows its container + symbols
    expect(screen.getByText('Animal')).toBeTruthy()
    expect(screen.getByText('speak')).toBeTruthy()
    expect(screen.getByText('walk')).toBeTruthy()
    // degraded banner present (a cpp file is best-effort)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  test('dependency changes show under the 依赖 view toggle (not always-on)', () => {
    const { container } = render(<StructuralDiffView data={sampleDiff()} />)
    expect(screen.queryByText('tokio')).toBeNull() // folded into the toggle, not shown by default
    const buttons = container.querySelectorAll('.structure__view-toggle button')
    const depsBtn = [...buttons].find((b) => /依赖|Deps/.test(b.textContent ?? ''))
    fireEvent.click(depsBtn as Element)
    expect(screen.getByText('tokio')).toBeTruthy()
  })

  test('selecting another file swaps the body', () => {
    render(<StructuralDiffView data={sampleDiff()} />)
    expect(screen.queryByText('Widget')).toBeNull() // cpp not selected yet
    fireEvent.click(screen.getByText('w.cpp'))
    expect(screen.getByText('Widget')).toBeTruthy()
  })

  test('clicking a symbol with a hunkAnchor invokes onJumpToHunk (text↔structure)', () => {
    const data = sampleDiff()
    const change = data.files[0]?.changes[0]
    if (change !== undefined) change.hunkAnchor = { filePath: 'mod.py', startLine: 3, endLine: 4 }
    let jumped: { filePath: string; startLine: number; endLine: number } | null = null
    render(
      <StructuralDiffView
        data={data}
        onJumpToHunk={(a) => {
          jumped = a
        }}
      />,
    )
    fireEvent.click(screen.getByText('speak'))
    expect(jumped).toEqual({ filePath: 'mod.py', startLine: 3, endLine: 4 })
  })

  test('impact panel (within-file callers) shows under the 影响面 view toggle', () => {
    const data = sampleDiff()
    data.impact = [
      {
        changedSymbolId: 'mod.py#Animal.speak:method:3',
        callers: [
          {
            symbolId: 'mod.py#Animal.greet:method:8',
            filePath: 'mod.py',
            range: { startLine: 8, endLine: 9 },
          },
        ],
        confidence: 'inferred',
      },
    ]
    const { container } = render(<StructuralDiffView data={data} />)
    // impact is folded into the view toggle (not an always-on panel) → 3rd option
    expect(screen.queryByText('Animal.speak')).toBeNull()
    const impactBtn = container.querySelectorAll('.structure__view-toggle button')[2]
    fireEvent.click(impactBtn as Element)
    expect(screen.getByText('Animal.speak')).toBeTruthy() // impact target (full qn)
    expect(screen.getByText(/Animal\.greet/)).toBeTruthy() // caller
  })

  test('deep-fallback banner shows when deep was requested but fell back', () => {
    const data = sampleDiff()
    data.engine = 'baseline'
    data.degradedReason = 'indexer-missing'
    data.files = data.files.filter((f) => f.status !== 'degraded') // drop the cpp degraded banner
    const { container } = render(<StructuralDiffView data={data} />)
    expect(container.querySelectorAll('.structure__banner')).toHaveLength(1)
  })

  test('impact panel renders a precise tag for extracted confidence', () => {
    const data = sampleDiff()
    data.impact = [
      {
        changedSymbolId: 'a.ts#A.m:method:1',
        callers: [
          { symbolId: 'b.ts#B.n:method:2', filePath: 'b.ts', range: { startLine: 2, endLine: 3 } },
        ],
        confidence: 'extracted',
      },
    ]
    const { container } = render(<StructuralDiffView data={data} />)
    const impactBtn = container.querySelectorAll('.structure__view-toggle button')[2]
    fireEvent.click(impactBtn as Element)
    const tag = container.querySelector('.structure__impact .structure__tag')
    expect(tag?.textContent).toBeTruthy() // precise label rendered (vs heuristic)
  })

  test('view toggle switches from the tree to the read-only graph (PR-F)', () => {
    const data = sampleDiff()
    // give it a caller so the graph has a band to draw (else it's the empty state)
    data.impact = [
      {
        changedSymbolId: data.files[0]!.changes[0]!.after!.id,
        confidence: 'inferred',
        callers: [
          {
            symbolId: 'mod.py#Animal.greet:method:8',
            filePath: 'mod.py',
            range: { startLine: 8, endLine: 9 },
          },
        ],
      },
    ]
    const { container } = render(<StructuralDiffView data={data} />)
    expect(container.querySelector('.structure__tree')).toBeTruthy() // tree by default
    expect(container.querySelector('[data-testid="structure-graph"]')).toBeNull()
    const toggle = container.querySelector('.structure__view-toggle')
    const graphBtn = toggle?.querySelectorAll('button')[1] // [tree, graph]
    fireEvent.click(graphBtn as Element)
    expect(container.querySelector('[data-testid="structure-graph"]')).toBeTruthy()
    expect(container.querySelector('.structure__tree')).toBeNull() // tree swapped out
  })

  test('a signature change renders the before→after token diff and suppresses the bare tag (Q1)', () => {
    const data = sampleDiff()
    const ch = data.files[0]!.changes[0]! // modified method Animal.speak
    ch.signatureChanged = true
    ch.before = sym('Animal.speak', 'method')
    ch.before.signature = '(loud: bool): None'
    ch.after = sym('Animal.speak', 'method')
    ch.after.signature = '(loud: bool, times: int): None'
    const { container } = render(<StructuralDiffView data={data} />)
    const sig = container.querySelector('[data-testid="sigdiff"]')
    expect(sig).toBeTruthy()
    // the inserted param is flagged on the after row...
    expect(sig?.querySelector('.structure__sigtok--added')).toBeTruthy()
    // ...and a pure insertion leaves no removed token on the before row
    expect(sig?.querySelector('.structure__sigtok--removed')).toBeNull()
    // the redundant "signature changed" tag is suppressed when the detail shows
    // (language-agnostic: the tag is the only `.structure__tag` in the tree view)
    expect(container.querySelector('.structure__tag')).toBeNull()
  })

  test('empty diff renders an empty state', () => {
    const empty: StructuralDiff = {
      ...sampleDiff(),
      files: [],
      dependencyChanges: [],
      summary: computeSummary([], []),
    }
    const { container } = render(<StructuralDiffView data={empty} />)
    expect(container.querySelector('.structure__tree')).toBeNull()
  })
})
