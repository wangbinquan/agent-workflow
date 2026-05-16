// RFC-021: WorktreeDiffPanel — vertical file tabs + single-file body.
//
// Why this exists: the legacy `DiffViewer` stacked every file's hunks
// vertically, which on real tasks (often 30+ files) blew out the page.
// This test file locks the per-file tab interaction and the self-heal
// behavior when the diff string changes mid-session.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
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
    expect(screen.getByText(/No changes/i)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  test('truncated banner appears in the left file list, NOT the right pane', () => {
    render(<WorktreeDiffPanel diff={THREE_FILE_DIFF} truncated />)
    const aside = document.querySelector('.worktree-diff__files')
    expect(aside).toBeTruthy()
    expect(within(aside as HTMLElement).getByText(/truncated at 1 MiB/i)).toBeTruthy()
    const body = document.querySelector('.worktree-diff__body')
    expect(body).toBeTruthy()
    expect(within(body as HTMLElement).queryByText(/truncated at 1 MiB/i)).toBeNull()
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
