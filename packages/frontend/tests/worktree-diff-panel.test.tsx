// RFC-021: WorktreeDiffPanel — vertical file tabs + single-file body.
//
// Why this exists: the legacy `DiffViewer` stacked every file's hunks
// vertically, which on real tasks (often 30+ files) blew out the page.
// This test file locks the per-file tab interaction and the self-heal
// behavior when the diff string changes mid-session.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, describe, expect, test } from 'vitest'
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

// One test below flips the locale to lock i18n coverage; restore the
// bootstrap language afterward so neighbouring test files keep the locale
// they expect (the harness defaults via navigator.language under happy-dom).
afterAll(async () => {
  await i18n.changeLanguage('en-US')
})

describe('WorktreeDiffPanel', () => {
  test('renders one tab per file, defaults to selecting the first', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('false')
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
    expect(screen.getByText('+new line from b')).toBeTruthy()
    expect(screen.queryByText('+new line from a')).toBeNull()
  })

  test('empty diff string renders the "No changes" fallback with no tablist', () => {
    render(<WorktreeDiffPanel diff="" />)
    // i18next bootstraps from navigator.language under happy-dom (= en-US).
    expect(screen.getByText(/No changes/i)).toBeTruthy()
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
    expect(tabs.every((t) => t.textContent === 'src/index.ts')).toBe(true)
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
