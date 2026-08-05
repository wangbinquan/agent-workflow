// RFC-239 — the unified structural-change panel. Supersedes (with intent)
// the deleted worktree-diff-panel.test.tsx + structure-view.test.tsx render
// sections + call-chain-entry.test.tsx: the behaviors those files locked
// (file tabs + keyboard order + viewed progress + multi-repo grouping;
// severity chips + jump wiring; ⎇ call-chain entry) live in THIS panel now,
// each re-locked below against the merged UI. Legacy viewed-progress
// localStorage keys must keep matching (P1-4), and legacy tab URL values must
// redirect (validateTaskDetailSearch).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '../src/i18n'
import {
  computeSummary,
  type StructuralDiff,
  type SymbolNode,
  type TaskDiff,
} from '@agent-workflow/shared'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockImplementation((url: string) => {
        if (url.includes('/change-narrative')) {
          return Promise.reject(new actual.ApiError(404, 'narrative-not-found', 'none'))
        }
        if (url.includes('/file-symbols')) {
          return Promise.resolve({ lang: 'typescript', status: 'ok', symbols: [] })
        }
        if (url.includes('/file-content')) {
          return Promise.resolve({ exists: true, content: '# doc\n', size: 6 })
        }
        return Promise.resolve({ targets: [] })
      }),
      post: vi.fn().mockResolvedValue({ status: 'generating', startedAt: 1 }),
    },
  }
})

import { ChangeReviewPanel } from '../src/components/changes/ChangeReviewPanel'
import { ChangeNarrativeCard } from '../src/components/changes/ChangeNarrativeCard'
import { DrilldownOverlay } from '../src/components/changes/DrilldownOverlay'
import { validateTaskDetailSearch } from '../src/lib/task-detail-route-tabs'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
})
beforeEach(() => {
  window.localStorage.clear()
})

const DIFF_TEXT = `diff --git a/src/ui/a.ts b/src/ui/a.ts
index 1111..2222 100644
--- a/src/ui/a.ts
+++ b/src/ui/a.ts
@@ -1,2 +1,2 @@
-old line from a
+new line from a
 ctx a
diff --git a/src/ui/b.ts b/src/ui/b.ts
index 3333..4444 100644
--- a/src/ui/b.ts
+++ b/src/ui/b.ts
@@ -1,2 +1,2 @@
-old line from b
+new line from b
 ctx b
diff --git a/src/core/c.ts b/src/core/c.ts
index 5555..6666 100644
--- a/src/core/c.ts
+++ b/src/core/c.ts
@@ -1,2 +1,2 @@
-old line from c
+new line from c
 ctx c
diff --git a/src/core/d.ts b/src/core/d.ts
index 7777..8888 100644
--- a/src/core/d.ts
+++ b/src/core/d.ts
@@ -1,2 +1,2 @@
-old line from d
+new line from d
 ctx d
diff --git a/src/core/e.ts b/src/core/e.ts
index 9999..aaaa 100644
--- a/src/core/e.ts
+++ b/src/core/e.ts
@@ -1,2 +1,2 @@
-old line from e
+new line from e
 ctx e
diff --git a/README.md b/README.md
index bbbb..cccc 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # readme
+more docs
`

const taskDiff = (diff: string): TaskDiff => ({ diff, baseCommit: 'abc', truncated: false })

const sym = (qn: string, kind = 'method', file = 'src/ui/a.ts', line = 1): SymbolNode => ({
  id: `${file}#${qn}:${kind}:${line}`,
  kind: kind as SymbolNode['kind'],
  name: qn.split('.').pop() ?? qn,
  qualifiedName: qn,
  lang: 'typescript',
  filePath: file,
  confidence: 'extracted',
  range: { startLine: line, endLine: line + 1 },
})

function structural(overrides: Partial<StructuralDiff> = {}): StructuralDiff {
  const files: StructuralDiff['files'] = [
    {
      filePath: 'src/ui/a.ts',
      lang: 'typescript',
      status: 'ok',
      edges: [],
      impact: [],
      changes: [{ changeType: 'modified', kind: 'method', after: sym('A.run'), bodyChanged: true }],
    },
  ]
  return {
    scope: 'task',
    taskId: 't1',
    fromRef: 'abc',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files,
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    callChainAvailable: true,
    contentDigest: 'digest-1',
    summary: computeSummary(files, []),
    ...overrides,
  }
}

function renderPanel(
  opts: {
    diff?: TaskDiff
    structuralData?: StructuralDiff
    structuralError?: unknown
    storageKey?: string
  } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ChangeReviewPanel
        taskId="t1"
        storageKey={opts.storageKey}
        diff={'diff' in opts ? opts.diff : taskDiff(DIFF_TEXT)}
        diffTruncated={false}
        structural={{
          data: opts.structuralData,
          error: opts.structuralError ?? null,
          isLoading: false,
        }}
        scopeValue="task"
        scopeOptions={[{ value: 'task', label: '整任务' }]}
        onScopeChange={() => {}}
        engineMode="baseline"
        onEngineChange={() => {}}
      />
    </QueryClientProvider>,
  )
}

function fileSelectors(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.changes__file-tab'))
}

describe('ChangeReviewPanel — grouped sidebar', () => {
  test('code files group by module, docs group separately; counts + weight bars render', () => {
    renderPanel({ structuralData: structural() })
    const groups = screen.getAllByTestId('change-group')
    // 5 code files (>4) split by module: core (3 files) before ui (2) by
    // magnitude tie → both present; README.md lands in the docs group.
    const headers = groups.map((g) => within(g).getByRole('button', { expanded: true }))
    const titles = headers.map((h) => h.textContent ?? '')
    expect(titles.some((x) => x.includes('core'))).toBe(true)
    expect(titles.some((x) => x.includes('ui'))).toBe(true)
    expect(titles.some((x) => /文档|Docs/.test(x))).toBe(true)
    // file rows render basenames; the full path lives on the tab title
    const tabs = fileSelectors()
    expect(tabs.some((el) => el.getAttribute('title') === 'src/ui/a.ts')).toBe(true)
  })

  test('keyboard: file-button ArrowDown moves selection in visual order; Space toggles viewed', () => {
    renderPanel({ structuralData: structural(), storageKey: 'T-KEY' })
    const first = fileSelectors()[0]
    expect(first).toBeTruthy()
    fireEvent.click(first as HTMLElement)
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' })
    const selected = fileSelectors().find((el) => el.getAttribute('aria-current') === 'true')
    expect(selected).toBeTruthy()
    fireEvent.keyDown(selected as HTMLElement, { key: ' ' })
    const progress = screen.getByTestId('diff-viewed-progress')
    expect(progress.textContent).toMatch(/1\s*\/\s*6|已看 1/)
  })

  test('legacy viewed keys keep matching (P1-4: bare header format, per task)', () => {
    // Pre-merge WorktreeDiffPanel persisted bare headers under awf.diffViewed.
    window.localStorage.setItem('awf.diffViewed.T-LEGACY', JSON.stringify(['src/ui/a.ts']))
    renderPanel({ structuralData: structural(), storageKey: 'T-LEGACY' })
    const progress = screen.getByTestId('diff-viewed-progress')
    expect(progress.textContent).toMatch(/1/)
  })

  test('multi-repo markers prefix group keys so same-path files stay distinct', () => {
    const multi = `# === Repo: alpha ===
diff --git a/src/x.ts b/src/x.ts
@@ -1,1 +1,1 @@
-a
+b
# === Repo: beta ===
diff --git a/src/x.ts b/src/x.ts
@@ -1,1 +1,1 @@
-c
+d
`
    renderPanel({ diff: taskDiff(multi) })
    const titles = fileSelectors().map((el) => el.getAttribute('title'))
    expect(titles).toContain('alpha/src/x.ts')
    expect(titles).toContain('beta/src/x.ts')
  })
})

describe('ChangeReviewPanel — structural degradation + empty states', () => {
  test('structural failure only degrades: banner + plain file rows, diff intact', () => {
    renderPanel({ structuralError: new Error('boom') })
    expect(screen.getByRole('status').textContent).toMatch(
      /结构分析不可用|Structural analysis is unavailable/,
    )
    expect(fileSelectors().length).toBeGreaterThan(0)
  })

  test('emptyHint differentiates scratch-space from no-changes', () => {
    const empty = structural({ files: [], emptyHint: 'scratch-space', callChainAvailable: false })
    renderPanel({ diff: taskDiff(''), structuralData: empty })
    expect(screen.getByText(/临时空间|scratch space/)).toBeTruthy()
    cleanup()
    const none = structural({ files: [], emptyHint: 'no-changes', callChainAvailable: false })
    renderPanel({ diff: taskDiff(''), structuralData: none })
    expect(screen.getByText(/未修改任何文件|modified no files/)).toBeTruthy()
  })
})

describe('ChangeReviewPanel — detail pane', () => {
  test('symbol outline renders the changed method with jump affordance; added+safe rows carry no explanation', () => {
    renderPanel({ structuralData: structural() })
    const aTab = fileSelectors().find((el) => el.getAttribute('title') === 'src/ui/a.ts')
    fireEvent.click(aTab as HTMLElement)
    const outline = screen.getByTestId('symbol-outline')
    expect(within(outline).getByText('run')).toBeTruthy()
    // modified body-only row DOES render an explanation line
    expect(within(outline).getByText(/body changed|实现/i)).toBeTruthy()
  })

  test('rename shows the old path; ⎇ opens the call-chain drilldown', () => {
    const s = structural()
    const file = s.files[0]
    if (file !== undefined) file.renamedFrom = 'src/old/a.ts'
    renderPanel({ structuralData: s })
    const aTab = fileSelectors().find((el) => el.getAttribute('title') === 'src/ui/a.ts')
    fireEvent.click(aTab as HTMLElement)
    expect(screen.getByText(/src\/old\/a\.ts/)).toBeTruthy()
    const entries = screen.getAllByRole('button', { name: /调用链|call chain/i })
    const rowEntry = entries.find((el) => el.classList.contains('structure__callchain-entry'))
    expect(rowEntry).toBeTruthy()
    fireEvent.click(rowEntry as HTMLElement)
    expect(screen.getByTestId('drilldown-callchain')).toBeTruthy()
  })
})

describe('ChangeReviewPanel — all-added top-level fold', () => {
  // Locks the "nothing rendered" fix (debugged on task 01KZ0E7GT332N8K0G3JG73CRN8):
  // an all-new file whose symbols are ALL top-level (container '') collapsed
  // them under a group with NO header — no fold button, no symbol rows and no
  // ⎇ call-chain entry anywhere. The top-level group must render a labeled
  // fold header when allAdded collapses it; expanding reveals the rows + ⎇.
  test('all-added file: top-level group gets a fold header; expanding reveals ⎇ rows', () => {
    const files: StructuralDiff['files'] = [
      {
        filePath: 'src/ui/a.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          { changeType: 'added', kind: 'function', after: sym('verifyManifest', 'function') },
          {
            changeType: 'added',
            kind: 'function',
            after: sym('isObject', 'function', 'src/ui/a.ts', 5),
          },
        ],
      },
    ]
    renderPanel({ structuralData: structural({ files, summary: computeSummary(files, []) }) })
    const aTab = fileSelectors().find((el) => el.getAttribute('title') === 'src/ui/a.ts')
    fireEvent.click(aTab as HTMLElement)
    const outline = screen.getByTestId('symbol-outline')
    // collapsed by default (allAdded de-noising) — rows hidden, header present
    expect(within(outline).queryByText('verifyManifest')).toBeNull()
    const fold = within(outline).getByRole('button', { name: /顶层符号|Top-level symbols/ })
    fireEvent.click(fold)
    expect(within(outline).getByText('verifyManifest')).toBeTruthy()
    const entries = within(outline).getAllByRole('button', { name: /调用链|call chain/i })
    expect(entries.some((el) => el.classList.contains('structure__callchain-entry'))).toBe(true)
  })
})

describe('ChangeReviewPanel — drilldown gating + narrative states', () => {
  test('impact/deps buttons appear only with data; graph opens a FULL-size dialog', () => {
    renderPanel({ structuralData: structural() })
    expect(screen.queryByRole('button', { name: /影响面|Impact/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /依赖变更|Dependency changes/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /关系图|Graph/ }))
    expect(screen.getByTestId('drilldown-graph')).toBeTruthy()
    // canvas-like drilldowns use the whole viewport ("弹窗太小" feedback):
    // graph/callchain get size=full; the list drilldowns stay lg.
    expect(document.querySelector('.dialog--full')).toBeTruthy()
  })

  test('narrative starts in the button state (404 → generate CTA)', async () => {
    renderPanel({ structuralData: structural() })
    expect(await screen.findByRole('button', { name: /生成 AI 导读|Generate AI/ })).toBeTruthy()
  })
})

describe('ChangeReviewPanel — survives-GC fallback', () => {
  test('text diff missing (410) but structural data present → renders structural-only entries', () => {
    renderPanel({ diff: undefined, structuralData: structural() })
    // the structural-only entry appears in the sidebar; its detail pane notes
    // the missing text diff instead of dead-ending on a loading state
    const tab = fileSelectors().find((el) => el.getAttribute('title') === 'src/ui/a.ts')
    expect(tab).toBeTruthy()
    expect(screen.getByTestId('symbol-outline')).toBeTruthy()
    expect(screen.getByText(/文本 diff|text diff/i)).toBeTruthy()
  })
})

describe('ChangeReviewPanel — impl-gate P2 regressions', () => {
  test('Space on a group header folds the group instead of toggling viewed', () => {
    renderPanel({ structuralData: structural(), storageKey: 'T-SPACE' })
    const header = screen.getAllByTestId('change-group')[0]
    const headerButton = within(header as HTMLElement).getByRole('button', { expanded: true })
    headerButton.focus()
    // dispatch ON the header so the event bubbles into the tablist handler
    fireEvent.keyDown(headerButton, { key: ' ' })
    const progress = screen.getByTestId('diff-viewed-progress')
    expect(progress.textContent).toMatch(/^0|已看 0/)
  })

  test('call-chain drill button stays hidden until a ⎇ picked a root', () => {
    renderPanel({ structuralData: structural() })
    const drillButtons = screen
      .queryAllByRole('button', { name: /调用链|call chain/i })
      .filter((el) => el.classList.contains('btn'))
    expect(drillButtons).toHaveLength(0)
  })

  test('group headers surface the change magnitude (± lines)', () => {
    renderPanel({ structuralData: structural() })
    const header = screen.getAllByTestId('change-group')[0]
    expect((header as HTMLElement).textContent).toMatch(/\+\d/)
  })
})

describe('RFC-250 ChangeReview semantic boundaries', () => {
  test('group disclosures, file navigation, and viewed checkboxes are separate native controls', () => {
    renderPanel({ structuralData: structural(), storageKey: 'T-SEMANTICS' })

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0)

    const firstFile = fileSelectors()[0]
    expect(firstFile?.getAttribute('aria-current')).toBe('true')
    expect(firstFile?.getAttribute('aria-keyshortcuts')).toBe('Space')
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBe(fileSelectors().length)
    expect(
      checkboxes.every((checkbox) => checkbox.parentElement?.classList.contains('form-checkbox')),
    ).toBe(true)
  })

  test('clicking the shared viewed checkbox does not activate the adjacent file button', () => {
    renderPanel({ structuralData: structural(), storageKey: 'T-CLICK-BOUNDARY' })
    const selectedBefore = fileSelectors().find((button) => button.getAttribute('aria-current'))
    const otherRow = fileSelectors().find((button) => button !== selectedBefore)?.parentElement
    expect(otherRow).toBeTruthy()
    const checkbox = within(otherRow as HTMLElement).getByRole('checkbox')

    fireEvent.click(checkbox)

    expect(fileSelectors().find((button) => button.getAttribute('aria-current'))).toBe(
      selectedBefore,
    )
    expect(screen.getByTestId('diff-viewed-progress').textContent).toMatch(/1\s*\/\s*6|已看 1/)
  })

  test('Arrow/Home/End on group headers and viewed checkboxes are not intercepted', () => {
    renderPanel({ structuralData: structural(), storageKey: 'T-NATIVE-KEYS' })
    const selectedBefore = fileSelectors().find((button) => button.getAttribute('aria-current'))
    const header = screen.getAllByTestId('change-group')[0]
    const headerButton = within(header as HTMLElement).getByRole('button', { expanded: true })
    const checkbox = within(header as HTMLElement).getAllByRole('checkbox')[0]

    expect(fireEvent.keyDown(headerButton, { key: 'End' })).toBe(true)
    expect(fireEvent.keyDown(checkbox as HTMLElement, { key: 'ArrowDown' })).toBe(true)
    expect(fileSelectors().find((button) => button.getAttribute('aria-current'))).toBe(
      selectedBefore,
    )
  })

  test('collapsing the group that contains focus returns focus to its disclosure', () => {
    renderPanel({ structuralData: structural(), storageKey: 'T-FOLD-FOCUS' })
    const group = screen.getAllByTestId('change-group')[0] as HTMLElement
    const header = within(group).getByRole('button', { expanded: true })
    const checkbox = within(group).getAllByRole('checkbox')[0] as HTMLInputElement

    checkbox.focus()
    expect(document.activeElement).toBe(checkbox)
    fireEvent.click(header)
    expect(document.activeElement).toBe(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('RFC-258 — full-file view + line-level impact jumps', () => {
  test('code files get the 改动/全文 Segmented; switching renders the CodeViewer shell', async () => {
    renderPanel({ structuralData: structural() })
    const aTab = fileSelectors().find((el) => el.getAttribute('title') === 'src/ui/a.ts')
    fireEvent.click(aTab as HTMLElement)
    const fullBtn = screen.getByRole('radio', { name: /全文|Full file/ })
    fireEvent.click(fullBtn)
    await waitFor(() => expect(document.querySelector('.code-viewer')).toBeTruthy())
    // switching back restores the hunk view
    fireEvent.click(screen.getByRole('radio', { name: /改动|Changes/ }))
    expect(document.querySelector('.code-viewer')).toBeNull()
  })

  test('graph member ‹› opens the split source pane WITHOUT unmounting the graph (F-12 keep-alive)', async () => {
    renderPanel({ structuralData: structural() })
    fireEvent.click(screen.getByRole('button', { name: /关系图|Graph/ }))
    // class level so member rows render
    const classBtn = [...document.querySelectorAll('.structure-graph__level button')].find((b) =>
      /类级|Classes/.test(b.textContent ?? ''),
    )
    fireEvent.click(classBtn as Element)
    const src = [...document.querySelectorAll('.sg-card__callchain')].find((b) =>
      /查看源码|View source/.test(b.getAttribute('title') ?? ''),
    )
    expect(src).toBeTruthy()
    const vpBefore =
      document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? ''
    fireEvent.click(src as Element)
    expect(await screen.findByTestId('drill-source-pane')).toBeTruthy()
    // the graph pane is still mounted beside the source pane
    expect(document.querySelector('.changes__drill-graphpane')).toBeTruthy()
    expect(document.querySelector('.changes__drill--split')).toBeTruthy()
    // P1-9① — keep-alive means the viewport transform is BYTE-identical
    const vpAfter =
      document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? ''
    expect(vpAfter).toBe(vpBefore)
    // P1-9② — closing the dialog resets the pane (kind→null explicit reset)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /关系图|Graph/ }))
    expect(screen.queryByTestId('drill-source-pane')).toBeNull()
  })

  test('hunk-owner click keeps its single existing action — no code-intel query (P1-9③/F-11)', async () => {
    const apiModule = await import('../src/api/client')
    const spy = apiModule.api.get as ReturnType<typeof vi.fn>
    renderPanel({ structuralData: structural() })
    const aTab = fileSelectors().find((el) => el.getAttribute('title') === 'src/ui/a.ts')
    fireEvent.click(aTab as HTMLElement)
    const owner = document.querySelector('.changes__hunk-owner') as HTMLElement
    expect(owner).toBeTruthy()
    const callsBefore = spy.mock.calls.filter((c) => String(c[0]).includes('code-intel')).length
    fireEvent.click(owner)
    const callsAfter = spy.mock.calls.filter((c) => String(c[0]).includes('code-intel')).length
    expect(callsAfter).toBe(callsBefore)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('impact drilldown rows carry the caller LINE (filePath:line jump)', () => {
    renderPanel({
      structuralData: structural({
        impact: [
          {
            changedSymbolId: 'src/ui/a.ts#A.run:method:1',
            confidence: 'inferred',
            callers: [{ filePath: 'src/ui/b.ts', range: { startLine: 3, endLine: 4 } }],
          },
        ],
      }),
    })
    fireEvent.click(screen.getByRole('button', { name: /影响面|Impact/ }))
    const caller = document.querySelector('.changes__impact-caller') as HTMLElement
    expect(caller.getAttribute('title')).toBe('src/ui/b.ts:3')
  })
})

describe('DrilldownOverlay — call-chain back navigation', () => {
  // User feedback: ⎇ inside the GRAPH dialog swapped the content to the call
  // chain with no way back — closing and reopening was the only "return".
  // When (and only when) the chain was entered from the graph, a back button
  // must restore the graph drilldown.
  test('back button renders only with onBackToGraph and fires it', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onBack = vi.fn()
    const props = {
      kind: 'callchain' as const,
      onClose: () => {},
      data: structural(),
      taskId: 't1',
      callRoot: { ref: 'src/ui/a.ts#A.run', label: 'run()' },
      currentFileKey: null,
    }
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <DrilldownOverlay {...props} onBackToGraph={onBack} />
      </QueryClientProvider>,
    )
    const back = screen.getByRole('button', { name: /返回关系图|Back to graph/ })
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
    // entered from the ⎇ of a symbol row (not the graph): no back affordance
    rerender(
      <QueryClientProvider client={qc}>
        <DrilldownOverlay {...props} />
      </QueryClientProvider>,
    )
    expect(screen.queryByRole('button', { name: /返回关系图|Back to graph/ })).toBeNull()
  })

  // Follow-up feedback: "返回" landed on a REMOUNTED default graph (package
  // level, all-focus) instead of the pre-jump view. The graph pane must stay
  // mounted (hidden) while the chain is shown so its state survives.
  test('graph pane stays mounted (hidden) under the call chain when it can go back', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const props = {
      kind: 'callchain' as const,
      onClose: () => {},
      data: structural(),
      taskId: 't1',
      callRoot: { ref: 'src/ui/a.ts#A.run', label: 'run()' },
      currentFileKey: null,
    }
    render(
      <QueryClientProvider client={qc}>
        <DrilldownOverlay {...props} onBackToGraph={() => {}} />
      </QueryClientProvider>,
    )
    const pane = document.querySelector('.changes__drill-graphpane') as HTMLElement
    expect(pane).toBeTruthy()
    expect(pane.style.display).toBe('none')
  })
})

describe('ChangeNarrativeCard — collapsible', () => {
  // User feedback: the AI walkthrough box is tall and cannot be put away once
  // read. The ready card gets a fold header; the fold is remembered per task.
  test('ready card folds/unfolds and remembers the fold per task', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const status = {
      status: 'ready',
      narrative: {
        overview: 'OVERVIEW-SENTENCE',
        readingOrder: [{ ref: 'src/ui/a.ts', why: 'start here' }],
        groups: [],
        inputDigest: 'digest-1',
      },
    } as never
    const view = (
      <QueryClientProvider client={qc}>
        <ChangeNarrativeCard taskId="t-fold" status={status} contentDigest="digest-1" />
      </QueryClientProvider>
    )
    const r = render(view)
    expect(screen.getByText('OVERVIEW-SENTENCE')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /AI 导读|AI walkthrough/ }))
    expect(screen.queryByText('OVERVIEW-SENTENCE')).toBeNull()
    // remembered: a fresh mount for the same task starts folded
    r.unmount()
    render(view)
    expect(screen.queryByText('OVERVIEW-SENTENCE')).toBeNull()
    expect(screen.getByRole('button', { name: /AI 导读|AI walkthrough/ })).toBeTruthy()
  })
})

describe('RFC-239 legacy tab URL redirect', () => {
  test('worktree-diff / worktree-structure normalize to changes; junk drops', () => {
    expect(validateTaskDetailSearch({ tab: 'worktree-diff' })).toEqual({ tab: 'changes' })
    expect(validateTaskDetailSearch({ tab: 'worktree-structure' })).toEqual({ tab: 'changes' })
    expect(validateTaskDetailSearch({ tab: 'changes' })).toEqual({ tab: 'changes' })
    expect(validateTaskDetailSearch({ tab: 'bogus' })).toEqual({})
  })
})
