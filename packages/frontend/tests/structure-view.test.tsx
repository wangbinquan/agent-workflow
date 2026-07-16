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
  HunkAnchor,
} from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { StructuralDiffView } from '../src/components/structure/StructuralDiffView'
import {
  summaryRows,
  groupFileChanges,
  badgeSymbol,
  fileTreeRows,
  diffSignatureTokens,
} from '../src/lib/structureView'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

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
    const tabs = screen.getAllByRole('tab')
    const panel = screen.getByRole('tabpanel')
    expect(tabs[0]?.id).toBe('structural-file-tab-0')
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.id).toBe('structural-file-panel-0')
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id)
    for (const [index, tab] of tabs.entries()) {
      const controlled = document.getElementById(tab.getAttribute('aria-controls') ?? '')
      expect(controlled).not.toBeNull()
      expect(controlled?.getAttribute('aria-labelledby')).toBe(tab.id)
      expect((controlled as HTMLElement | null)?.hidden).toBe(index !== 0)
    }
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
    expect(screen.getByRole('tabpanel').id).toBe('structural-file-panel-1')
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

// RFC-088 — semantics overlay: severity chips + plain-language explanation,
// risk-first sort + severity filter + clickable breaking card, and the
// walkthrough strip. Assertions use class/glyph anchors (locale-agnostic).
describe('<StructuralDiffView /> RFC-088 semantics overlay', () => {
  const pub = (qn: string): SymbolNode => ({
    ...sym(qn, 'method'),
    filePath: 'svc.ts',
    visibility: 'public',
  })

  function semDiff(): StructuralDiff {
    const files: FileStructuralDiff[] = [
      {
        filePath: 'svc.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          {
            changeType: 'removed',
            kind: 'method',
            before: pub('Svc.gone'),
            hunkAnchor: { filePath: 'svc.ts', startLine: 1, endLine: 2 },
          },
          { changeType: 'added', kind: 'method', after: pub('Svc.fresh') },
        ],
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
      dependencyChanges: [],
      impact: [],
      classEdges: [],
      summary: computeSummary(files, []),
    }
  }

  test('tree rows carry a severity chip + a plain-language explanation', () => {
    const { container } = render(<StructuralDiffView data={semDiff()} />)
    // removed public method → breaking chip; every row gets an explanation line
    expect(
      container.querySelector('.structure__changes .structure__severity--breaking'),
    ).toBeTruthy()
    expect(container.querySelector('.structure__explain')).toBeTruthy()
  })

  test('default risk-first sort puts the breaking change at the top of the tree', () => {
    const { container } = render(<StructuralDiffView data={semDiff()} />)
    const firstRow = container.querySelector('.structure__changes .structure__symbol')
    expect(firstRow?.textContent ?? '').toContain('gone') // breaking before safe 'fresh'
  })

  test('walkthrough strip lists breaking first and jumps to the hunk on click', () => {
    let jumped: HunkAnchor | null = null
    const { container } = render(
      <StructuralDiffView
        data={semDiff()}
        onJumpToHunk={(a) => {
          jumped = a
        }}
      />,
    )
    const card = container.querySelector('[data-testid="structure-walkthrough"]')
    expect(card).toBeTruthy()
    expect(card!.querySelector('.structure__severity')?.className).toContain(
      'structure__severity--breaking',
    )
    fireEvent.click(card!.querySelector('.structure__walkthrough-jump') as Element)
    expect(jumped).toEqual({ filePath: 'svc.ts', startLine: 1, endLine: 2 })
  })

  test('clicking the breaking summary card filters the tree to breaking only', () => {
    const { container } = render(<StructuralDiffView data={semDiff()} />)
    expect(container.querySelector('.structure__changes')?.textContent ?? '').toContain('fresh')
    const card = container.querySelector('.structure__card--breaking') as Element
    expect(card).toBeTruthy()
    fireEvent.click(card)
    const tree = container.querySelector('.structure__changes')
    expect(tree?.textContent ?? '').toContain('gone') // breaking stays
    expect(tree?.textContent ?? '').not.toContain('fresh') // safe filtered out
  })

  test('no walkthrough / breaking card when every change is safe', () => {
    const d = semDiff()
    d.files[0]!.changes = [{ changeType: 'added', kind: 'method', after: pub('Svc.fresh') }]
    d.summary = computeSummary(d.files, [])
    const { container } = render(<StructuralDiffView data={d} />)
    expect(container.querySelector('[data-testid="structure-walkthrough"]')).toBeNull()
    expect(container.querySelector('.structure__card--breaking')).toBeNull()
  })
})

// Keyboard file switching in the structural tree's left file list (mirrors the
// WorktreeDiffPanel behavior). The list is a vertical `role="tablist"`; Up/Down
// (+ Home/End) step between FILE rows in their VISUAL order, skipping directory
// header rows, and follow the rendered tree — NOT the `files` array order, which
// fileTreeRows reorders by directory. The handler is list-SCOPED (onKeyDown on
// the tablist), never a global window listener, so Arrow keys can't hijack
// scrolling. Selection assertions read aria-selected → locale-agnostic.
describe('<StructuralDiffView /> keyboard file switching', () => {
  const selectedFileName = (): string | null =>
    screen
      .getAllByRole('tab')
      .find((tb) => tb.getAttribute('aria-selected') === 'true')
      ?.querySelector('.structure__file-name')?.textContent ?? null

  test('ArrowDown / ArrowUp move between files and swap the body', () => {
    render(<StructuralDiffView data={sampleDiff()} />)
    const tablist = screen.getByRole('tablist', {
      name: i18n.t('tasks.structFileSelectorLabel'),
    })
    // first file (mod.py) selected by default
    expect(selectedFileName()).toBe('mod.py')
    expect(screen.getByText('speak')).toBeTruthy()

    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(selectedFileName()).toBe('w.cpp')
    expect(screen.getByText('Widget')).toBeTruthy() // body swapped to w.cpp
    expect(screen.queryByText('speak')).toBeNull()

    fireEvent.keyDown(tablist, { key: 'ArrowUp' })
    expect(selectedFileName()).toBe('mod.py')
    expect(screen.getByText('speak')).toBeTruthy()
  })

  test('roving tab stop + focus follow the selected file', () => {
    render(<StructuralDiffView data={sampleDiff()} />)
    const tablist = screen.getByRole('tablist')
    const tabs = (): HTMLElement[] => screen.getAllByRole('tab')
    expect(tabs().map((tb) => tb.tabIndex)).toEqual([0, -1])
    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(tabs().map((tb) => tb.tabIndex)).toEqual([-1, 0])
    expect(document.activeElement).toBe(tabs()[1])
  })

  test('modifier + Arrow is ignored so browser / OS shortcuts pass through', () => {
    render(<StructuralDiffView data={sampleDiff()} />)
    const tablist = screen.getByRole('tablist')
    fireEvent.keyDown(tablist, { key: 'ArrowDown', metaKey: true })
    expect(selectedFileName()).toBe('mod.py') // unchanged
  })

  // The critical case: directory grouping reorders files relative to the `files`
  // array, so Up/Down must follow the TREE (visual) order and skip directory rows.
  function treeFile(filePath: string, className: string): FileStructuralDiff {
    return {
      filePath,
      lang: 'typescript',
      status: 'ok',
      edges: [],
      impact: [],
      changes: [
        {
          changeType: 'added',
          kind: 'class',
          after: {
            id: `${filePath}#${className}:class`,
            kind: 'class',
            name: className,
            qualifiedName: className,
            lang: 'typescript',
            filePath,
            confidence: 'extracted',
          },
        },
      ],
    }
  }
  function treeDiff(): StructuralDiff {
    // array order: B(0), A(1), C(2); tree order: src/a/A, src/a/C, src/b/B.
    const files = [
      treeFile('src/b/B.ts', 'Bbb'),
      treeFile('src/a/A.ts', 'Aaa'),
      treeFile('src/a/C.ts', 'Ccc'),
    ]
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

  test('navigation follows visual tree order (not the files array) and skips dir rows', () => {
    const { container } = render(<StructuralDiffView data={treeDiff()} />)
    const tablist = screen.getByRole('tablist')
    // tabs render in tree order (dirs grouped + alpha-sorted), not array order
    expect(
      screen
        .getAllByRole('tab')
        .map((tb) => tb.querySelector('.structure__file-name')?.textContent),
    ).toEqual(['A.ts', 'C.ts', 'B.ts'])
    const bodyText = (): string =>
      container.querySelector('.structure__body:not([hidden])')?.textContent ?? ''

    // Home → first VISUAL file (A.ts), even though files[0] is B.ts
    fireEvent.keyDown(tablist, { key: 'Home' })
    expect(selectedFileName()).toBe('A.ts')
    expect(bodyText()).toContain('Aaa') // body actually swapped, not just the highlight

    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(selectedFileName()).toBe('C.ts') // src/a/C.ts — next visual row
    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(selectedFileName()).toBe('B.ts') // src/b/B.ts — last visual row
    // clamp at the bottom (no wraparound)
    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(selectedFileName()).toBe('B.ts')

    fireEvent.keyDown(tablist, { key: 'End' })
    expect(selectedFileName()).toBe('B.ts')
    fireEvent.keyDown(tablist, { key: 'Home' })
    expect(selectedFileName()).toBe('A.ts')
  })

  // Source-level backstop (repo test policy): the file-switch handler must hang
  // off the tablist, never a window 'keydown' listener — a global listener would
  // steal Arrow keys everywhere and break scrolling.
  test('Arrow handler is list-scoped, not a global window listener', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(
      path.resolve(here, '../src/components/structure/StructuralDiffView.tsx'),
      'utf8',
    )
    expect(src).toMatch(/onKeyDown=\{onTablistKeyDown\}/)
    expect(src).not.toMatch(/addEventListener\(\s*['"]keydown['"]/)
  })
})
