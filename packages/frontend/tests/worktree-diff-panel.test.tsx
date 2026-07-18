// RFC-021: WorktreeDiffPanel — vertical file tabs + single-file body.
//
// Why this exists: the legacy `DiffViewer` stacked every file's hunks
// vertically, which on real tasks (often 30+ files) blew out the page.
// This test file locks the per-file tab interaction and the self-heal
// behavior when the diff string changes mid-session.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import i18n from '@/i18n'
import { WorktreeDiffPanel } from '../src/components/WorktreeDiffPanel'

const THREE_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111..2222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old line from a
+new line from a
 ctx a
diff --git a/src/b.ts b/src/b.ts
index 3333..4444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-old line from b
+new line from b
 ctx b
diff --git a/src/c.ts b/src/c.ts
index 5555..6666 100644
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,2 +1,2 @@
-old line from c
+new line from c
 ctx c
`

describe('WorktreeDiffPanel', () => {
  test('renders one tab per file, defaults to selecting the first', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('false')
    const panel = screen.getByRole('tabpanel')
    expect(tabs[0]?.id).toBe('worktree-diff-file-tab-0')
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.id).toBe('worktree-diff-file-panel-0')
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id)
    for (const [index, tab] of tabs.entries()) {
      const controlled = document.getElementById(tab.getAttribute('aria-controls') ?? '')
      expect(controlled).not.toBeNull()
      expect(controlled?.getAttribute('aria-labelledby')).toBe(tab.id)
      expect((controlled as HTMLElement | null)?.hidden).toBe(index !== 0)
    }
    // RFC-091: the file column is a folder tree — tabs show basenames under a
    // single compacted `src` directory header row; the full path stays in title.
    expect(tabs.map((t) => t.textContent)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(tabs[0]?.getAttribute('title')).toBe('src/a.ts')
    expect(
      [...document.querySelectorAll('.worktree-diff__tree-dir')].map((d) => d.textContent),
    ).toEqual(['src'])
    // Right pane shows the first file's hunks only.
    expect(screen.getByText('+new line from a')).toBeTruthy()
    expect(screen.queryByText('+new line from b')).toBeNull()
  })

  test('clicking a different file tab swaps the right-pane body', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    const tabs = screen.getAllByRole('tab')
    fireEvent.click(tabs[1]!)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-controls')).toBe('worktree-diff-file-panel-1')
    expect(screen.getByRole('tabpanel').id).toBe('worktree-diff-file-panel-1')
    expect(document.getElementById('worktree-diff-file-panel-0')).not.toBeNull()
    expect((document.getElementById('worktree-diff-file-panel-0') as HTMLElement).hidden).toBe(true)
    expect(screen.getByText('+new line from b')).toBeTruthy()
    expect(screen.queryByText('+new line from a')).toBeNull()
  })

  test('empty diff string renders the empty fallback with no tablist', () => {
    const { container } = render(<WorktreeDiffPanel diff="" />)
    const fallback = container.querySelector('.diff--empty')
    expect(fallback?.textContent?.trim()).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  test('truncated banner appears in the left file list, NOT the right pane', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} truncated />)
    const aside = document.querySelector('.worktree-diff__files')
    expect(aside).toBeTruthy()
    expect(within(aside as HTMLElement).getByText(/1 MiB/)).toBeTruthy()
    const body = document.querySelector('.worktree-diff__body')
    expect(body).toBeTruthy()
    expect(within(body as HTMLElement).queryByText(/1 MiB/)).toBeNull()
  })

  test('selectedKey self-heals when the diff string changes and the prior file is gone', () => {
    const { rerender } = render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    // Select the 3rd file (src/c.ts)
    fireEvent.click(screen.getAllByRole('tab')[2]!)
    expect(screen.getByText('+new line from c')).toBeTruthy()

    // Diff updates: now only a single unrelated file remains.
    const NEW_DIFF = `diff --git a/src/z.ts b/src/z.ts
index 9999..AAAA 100644
--- a/src/z.ts
+++ b/src/z.ts
@@ -1 +1 @@
-old z
+new z
`
    rerender(<WorktreeDiffPanel diff={NEW_DIFF} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('+new z')).toBeTruthy()
  })

  test('empty / truncated banners localize across zh-CN and en-US', async () => {
    await i18n.changeLanguage('en-US')
    const { rerender, unmount } = render(<WorktreeDiffPanel diff="" />)
    expect(screen.getByText(/No changes since the task started/i)).toBeTruthy()
    rerender(<WorktreeDiffPanel diff={THREE_FILE_DIFF} truncated />)
    expect(screen.getByText(/Diff truncated at 1 MiB/i)).toBeTruthy()
    unmount()

    await i18n.changeLanguage('zh-CN')
    const { rerender: rerenderZh } = render(<WorktreeDiffPanel diff="" />)
    expect(screen.getByText('自任务启动以来没有改动。')).toBeTruthy()
    rerenderZh(<WorktreeDiffPanel diff={THREE_FILE_DIFF} truncated />)
    expect(screen.getByText(/Diff 已截断至 1 MiB/)).toBeTruthy()
  })

  test('100-file diff renders in well under a second (perf smoke)', () => {
    const parts: string[] = []
    for (let i = 0; i < 100; i++) {
      parts.push(
        [
          `diff --git a/src/f${i}.ts b/src/f${i}.ts`,
          'index 0000..1111 100644',
          `--- a/src/f${i}.ts`,
          `+++ b/src/f${i}.ts`,
          '@@ -1 +1 @@',
          `-old ${i}`,
          `+new ${i}`,
        ].join('\n'),
      )
    }
    const big = parts.join('\n') + '\n'
    const t0 = performance.now()
    render(<WorktreeDiffPanel diff={big} />)
    const elapsed = performance.now() - t0
    // 100 file tabs but only one body — DOM stays small. 1 second budget
    // is generous; on dev machines this renders in ~10–30ms.
    expect(elapsed).toBeLessThan(1000)
    expect(screen.getAllByRole('tab')).toHaveLength(100)
  })
})

// RFC-021 (Q5) — per-file "viewed" review progress. Number assertions (not the
// localized label) keep these locale-agnostic.
describe('WorktreeDiffPanel — viewed progress (Q5)', () => {
  test('a checkbox marks a file viewed, updates the N/M counter, and persists by storageKey', () => {
    localStorage.clear()
    const { unmount } = render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} storageKey="taskV" />)
    expect(screen.getByTestId('diff-viewed-progress').textContent).toMatch(/0\/3/)
    const checks = screen.getAllByRole('checkbox')
    expect(checks).toHaveLength(3)
    expect((checks[0] as HTMLInputElement).checked).toBe(false)
    fireEvent.click(checks[0]!)
    expect((checks[0] as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('diff-viewed-progress').textContent).toMatch(/1\/3/)
    unmount()
    // remount with the SAME storageKey → the viewed file is restored from storage
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} storageKey="taskV" />)
    expect(screen.getByTestId('diff-viewed-progress').textContent).toMatch(/1\/3/)
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true)
  })

  test('without a storageKey, viewed state stays in-memory (nothing persisted)', () => {
    localStorage.clear()
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(screen.getByTestId('diff-viewed-progress').textContent).toMatch(/1\/3/)
    expect(localStorage.length).toBe(0)
  })
})

// RFC-066 multi-repo: getTaskDiff concatenates per-repo diffs behind
// `# === Repo: <name> ===` markers. The panel must group the file column per
// repo and keep same-path files across repos distinct (selection + viewed).
describe('WorktreeDiffPanel — multi-repo grouping (RFC-066)', () => {
  // Both repos changed the SAME path (src/index.ts) — the case that rendered as
  // two indistinguishable tabs + a swallowed marker before the fix.
  const MULTI_REPO_DIFF = `# === Repo: repo-a ===
diff --git a/src/index.ts b/src/index.ts
index 1111..2222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-alpha old
+alpha new
# === Repo: repo-b ===
diff --git a/src/index.ts b/src/index.ts
index 3333..4444 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-beta old
+beta new
`

  test('renders a heading per repo and one tab per file', () => {
    render(<WorktreeDiffPanel diff={MULTI_REPO_DIFF} />)
    const headings = document.querySelectorAll('.worktree-diff__repo')
    expect([...headings].map((h) => h.textContent)).toEqual(['repo-a', 'repo-b'])
    // Two distinct file tabs even though both files are `src/index.ts`.
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    // RFC-091: tab labels are basenames now (full path in the title); each repo
    // renders its own `src` directory header row in its own folder tree.
    expect(tabs.every((t) => t.textContent === 'index.ts')).toBe(true)
    expect(tabs.every((t) => t.getAttribute('title') === 'src/index.ts')).toBe(true)
    expect(
      [...document.querySelectorAll('.worktree-diff__tree-dir')].map((d) => d.textContent),
    ).toEqual(['src', 'src'])
    // First repo's file selected by default → its body, not repo-b's.
    expect(screen.getByText('+alpha new')).toBeTruthy()
    expect(screen.queryByText('+beta new')).toBeNull()
  })

  test('selecting repo-b file swaps to its body (same path, different repo)', () => {
    render(<WorktreeDiffPanel diff={MULTI_REPO_DIFF} />)
    fireEvent.click(screen.getAllByRole('tab')[1]!)
    expect(screen.getByText('+beta new')).toBeTruthy()
    expect(screen.queryByText('+alpha new')).toBeNull()
  })

  test('viewed state is per-repo: checking repo-a does not check repo-b', () => {
    localStorage.clear()
    render(<WorktreeDiffPanel diff={MULTI_REPO_DIFF} storageKey="multi" />)
    // Two same-path files must count as two (a bare-header key would dedupe to 1).
    expect(screen.getByTestId('diff-viewed-progress').textContent).toMatch(/0\/2/)
    const checks = screen.getAllByRole('checkbox')
    expect(checks).toHaveLength(2)
    fireEvent.click(checks[0]!)
    expect((checks[0] as HTMLInputElement).checked).toBe(true)
    expect((checks[1] as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('diff-viewed-progress').textContent).toMatch(/1\/2/)
  })
})

// Keyboard file switching. The file column is a vertical `role="tablist"`, whose
// ARIA contract is Up/Down to move between tabs (Home/End to the ends). These
// lock that behavior plus the two decisions that keep it tame: a roving tab stop
// (only the active tab is Tab-reachable) and a list-SCOPED handler (onKeyDown on
// the tablist, never a global window listener) so Arrow keys can never hijack
// scrolling the diff body on the right. Selection assertions read `aria-selected`
// so they stay locale-agnostic (tab labels are file basenames, not translated).
// RFC-091: the file column is a folder tree, so Up/Down step through files in
// VISUAL (tree) order, skipping directory header rows. For THREE_FILE_DIFF
// (src/a,b,c.ts) the tree order a→b→c equals the diff order, so these hold; the
// `folder tree ordering` test below locks the case where the two differ.
describe('WorktreeDiffPanel — keyboard file switching', () => {
  const selectedTabLabel = (): string | null =>
    screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')
      ?.textContent ?? null

  test('ArrowDown / ArrowUp move to the next / previous file', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    const tablist = screen.getByRole('tablist', { name: i18n.t('tasks.diffFileSelectorLabel') })
    expect(selectedTabLabel()).toBe('a.ts')

    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(selectedTabLabel()).toBe('b.ts')
    // The right pane swaps to the newly selected file.
    expect(screen.getByText('+new line from b')).toBeTruthy()
    expect(screen.queryByText('+new line from a')).toBeNull()

    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(selectedTabLabel()).toBe('c.ts')

    fireEvent.keyDown(tablist, { key: 'ArrowUp' })
    expect(selectedTabLabel()).toBe('b.ts')
    expect(screen.getByText('+new line from b')).toBeTruthy()
  })

  test('Home / End jump to the first / last file', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    const tablist = screen.getByRole('tablist')
    fireEvent.keyDown(tablist, { key: 'End' })
    expect(selectedTabLabel()).toBe('c.ts')
    expect(screen.getByText('+new line from c')).toBeTruthy()
    fireEvent.keyDown(tablist, { key: 'Home' })
    expect(selectedTabLabel()).toBe('a.ts')
  })

  test('selection clamps at both ends — no wraparound', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    const tablist = screen.getByRole('tablist')
    // already on the first file → ArrowUp keeps it there
    fireEvent.keyDown(tablist, { key: 'ArrowUp' })
    expect(selectedTabLabel()).toBe('a.ts')
    // jump to the last file → ArrowDown past the end keeps it there
    fireEvent.keyDown(tablist, { key: 'End' })
    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(selectedTabLabel()).toBe('c.ts')
  })

  test('roving tab stop: only the active file tab is Tab-reachable', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    const tablist = screen.getByRole('tablist')
    const tabIndexes = (): number[] => screen.getAllByRole('tab').map((t) => t.tabIndex)
    expect(tabIndexes()).toEqual([0, -1, -1])
    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(tabIndexes()).toEqual([-1, 0, -1])
  })

  test('keyboard selection pulls focus onto the shown file tab', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    const tablist = screen.getByRole('tablist')
    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    // Focus follows selection so repeated presses continue from here + the row
    // scrolls into view.
    expect(document.activeElement).toBe(screen.getAllByRole('tab')[1])
  })

  test('modifier + Arrow is ignored so browser / OS shortcuts pass through', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    const tablist = screen.getByRole('tablist')
    fireEvent.keyDown(tablist, { key: 'ArrowDown', metaKey: true })
    expect(selectedTabLabel()).toBe('a.ts') // unchanged
  })

  // Space toggles the current file's "viewed" mark — the keyboard shortcut for
  // the per-file checkbox, so a reviewer can ↓ / Space down the list hands-on-keys.
  const checkboxes = (): HTMLInputElement[] => screen.getAllByRole('checkbox') as HTMLInputElement[]
  const progress = (): string => screen.getByTestId('diff-viewed-progress').textContent ?? ''

  test('Space marks the current file viewed, and Space again clears it', () => {
    localStorage.clear()
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} storageKey="kbV1" />)
    const tablist = screen.getByRole('tablist')
    expect(progress()).toMatch(/0\/3/)

    fireEvent.keyDown(tablist, { key: ' ' })
    expect(checkboxes()[0]!.checked).toBe(true)
    expect(progress()).toMatch(/1\/3/)
    expect(selectedTabLabel()).toBe('a.ts') // Space marks, it does not navigate

    fireEvent.keyDown(tablist, { key: ' ' })
    expect(checkboxes()[0]!.checked).toBe(false)
    expect(progress()).toMatch(/0\/3/)
  })

  test('Space marks the file you navigated to, not the first', () => {
    localStorage.clear()
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} storageKey="kbV2" />)
    const tablist = screen.getByRole('tablist')
    fireEvent.keyDown(tablist, { key: 'ArrowDown' }) // select 2nd file
    fireEvent.keyDown(tablist, { key: ' ' }) // mark it viewed
    const checks = checkboxes()
    expect(checks[0]!.checked).toBe(false)
    expect(checks[1]!.checked).toBe(true)
    expect(checks[2]!.checked).toBe(false)
    expect(progress()).toMatch(/1\/3/)
  })

  test('Space originating from the viewed checkbox is left to the checkbox (no double-toggle)', () => {
    localStorage.clear()
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} storageKey="kbV3" />)
    // The list handler must NOT act on a Space whose target is the checkbox — the
    // checkbox toggles natively, and a second toggle here would cancel it out.
    // happy-dom doesn't run the checkbox's native Space toggle, so firing a Space
    // keydown on the checkbox exercises the bubbled list handler in isolation:
    // "viewed" must stay untouched.
    fireEvent.keyDown(checkboxes()[0]!, { key: ' ' })
    expect(progress()).toMatch(/0\/3/)
    expect(checkboxes()[0]!.checked).toBe(false)
  })

  // Source-level backstop (repo test policy): the file-switch handler must hang
  // off the tablist, never a window 'keydown' listener — a global listener would
  // steal Arrow keys everywhere and break scrolling the diff body on the right.
  test('Arrow handler is list-scoped, not a global window listener', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(path.resolve(here, '../src/components/WorktreeDiffPanel.tsx'), 'utf8')
    expect(src).toMatch(/onKeyDown=\{onTablistKeyDown\}/)
    expect(src).not.toMatch(/addEventListener\(\s*['"]keydown['"]/)
  })
})

// RFC-091 — folder-tree presentation. The left column groups files under
// directory header rows (reusing the structural view's `fileTreeRows`), files
// render as indented basenames, and keyboard nav follows the VISUAL (tree) order
// — which `fileTreeRows` reorders by directory, so it can differ from the raw
// diff order. NESTED_DIFF is built so the two orders DIFFER, which is what makes
// "nav uses the tree, not the diff array" an observable, lockable fact.
describe('WorktreeDiffPanel — folder tree (RFC-091)', () => {
  // Diff order:  src/lib/util.ts, README.md, src/components/Foo.tsx
  // Tree order:  src/ › components/ › Foo.tsx,  src/ › lib/ › util.ts,  README.md
  //              i.e. Foo.tsx, util.ts, README.md — deliberately != diff order.
  const NESTED_DIFF = `diff --git a/src/lib/util.ts b/src/lib/util.ts
index 1111..2222 100644
--- a/src/lib/util.ts
+++ b/src/lib/util.ts
@@ -1 +1 @@
-old util
+new util
diff --git a/README.md b/README.md
index 3333..4444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old readme
+new readme
diff --git a/src/components/Foo.tsx b/src/components/Foo.tsx
index 5555..6666 100644
--- a/src/components/Foo.tsx
+++ b/src/components/Foo.tsx
@@ -1 +1 @@
-old foo
+new foo
`

  const tabLabels = (): (string | null)[] => screen.getAllByRole('tab').map((t) => t.textContent)
  const selectedTabLabel = (): string | null =>
    screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')
      ?.textContent ?? null

  test('groups files under directory header rows; files are indented basenames', () => {
    render(<WorktreeDiffPanel diff={NESTED_DIFF} />)
    // Directory header rows (NOT tabs) in visual order, indented by depth.
    const dirs = [...document.querySelectorAll('.worktree-diff__tree-dir')] as HTMLElement[]
    expect(dirs.map((d) => d.textContent)).toEqual(['src', 'components', 'lib'])
    expect(dirs.map((d) => d.style.paddingLeft)).toEqual(['8px', '22px', '22px'])
    // One tab per file, shown by basename, with the full path in the title.
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabLabels()).toEqual(['Foo.tsx', 'util.ts', 'README.md'])
    expect(tabs[0]?.getAttribute('title')).toBe('src/components/Foo.tsx')
  })

  test('defaults to the tree-first file, not the first diff file', () => {
    render(<WorktreeDiffPanel diff={NESTED_DIFF} />)
    // The diff starts at util.ts, but the tree puts Foo.tsx first → it is selected.
    expect(selectedTabLabel()).toBe('Foo.tsx')
    expect(screen.getByText('+new foo')).toBeTruthy()
    expect(screen.queryByText('+new util')).toBeNull()
  })

  test('ArrowDown steps in tree (visual) order, not diff order', () => {
    render(<WorktreeDiffPanel diff={NESTED_DIFF} />)
    const tablist = screen.getByRole('tablist')
    expect(selectedTabLabel()).toBe('Foo.tsx')
    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(selectedTabLabel()).toBe('util.ts')
    expect(screen.getByText('+new util')).toBeTruthy()
    fireEvent.keyDown(tablist, { key: 'ArrowDown' })
    expect(selectedTabLabel()).toBe('README.md')
  })

  // Source-level backstop: the panel must drive its file list through the shared
  // `fileTreeRows` helper — a regression to a flat per-file list would drop this.
  test('reuses the structural view fileTreeRows helper (no regression to a flat list)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(path.resolve(here, '../src/components/WorktreeDiffPanel.tsx'), 'utf8')
    expect(src).toMatch(/fileTreeRows/)
  })
})
