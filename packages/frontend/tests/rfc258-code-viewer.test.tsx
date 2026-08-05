// RFC-258 T5 — CodeViewer component: renders numbered lines with change
// stripes, folds long unchanged stretches, degrades honestly (oversized /
// binary / missing), and resolves identifier clicks through the delegated
// layer without hijacking real controls (F-11). jsdom cannot run shiki's
// full pipeline reliably, so rendering asserts on the plain path (over-budget
// input); the stale-drop guard is exercised by swapping file contents and
// asserting the final render matches the LATEST content (P1-9④).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '../src/i18n'
import type * as ApiClientModule from '../src/api/client'

const files = new Map<string, { exists: boolean; content?: string }>()

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockImplementation((url: string) => {
        const m = /path=([^&]+)/.exec(url)
        const path = decodeURIComponent(m?.[1] ?? '')
        const f = files.get(path)
        if (f === undefined) return Promise.reject(new actual.ApiError(404, 'nf', 'nf'))
        return Promise.resolve({ exists: f.exists, content: f.content, size: f.content?.length })
      }),
    },
  }
})

import { CodeViewer } from '../src/components/code/CodeViewer'

afterEach(() => {
  cleanup()
  files.clear()
})

function renderViewer(props: Partial<Parameters<typeof CodeViewer>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CodeViewer taskId="t1" repoKey="" filePath="src/big.txt" side="worktree" {...props} />
    </QueryClientProvider>,
  )
}

/** Over-budget content forces the plain path (deterministic under jsdom). */
function bigPlainContent(lines: string[]): string {
  const filler = Array.from({ length: 2100 - lines.length }, (_, i) => `filler_${i}`)
  return [...lines, ...filler].join('\n')
}

describe('<CodeViewer />', () => {
  test('renders numbered rows with data-ln and change stripes', async () => {
    files.set('src/big.txt', { exists: true, content: bigPlainContent(['alpha()', 'beta()']) })
    const { container } = renderViewer({
      changedRanges: [{ start: 2, end: 2, type: 'added' }],
    })
    await waitFor(() => expect(container.querySelector('[data-ln="1"]')).toBeTruthy())
    expect(container.querySelector('[data-ln="2"]')?.className).toContain('cv__line--added')
    expect(container.querySelector('[data-ln="1"]')?.textContent).toContain('alpha()')
  })

  test('folds long unchanged stretches behind an expand button', async () => {
    files.set('src/big.txt', { exists: true, content: bigPlainContent([]) })
    const { container } = renderViewer()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /未变更|unchanged/ })).toBeTruthy(),
    )
    // the folded body is NOT in the DOM until expanded
    expect(container.querySelector('[data-ln="1000"]')).toBeNull()
    screen.getByRole('button', { name: /未变更|unchanged/ }).click()
    await waitFor(() => expect(container.querySelector('[data-ln="1000"]')).toBeTruthy())
  })

  test('missing file and outside-diff badge states', async () => {
    files.set('src/big.txt', { exists: false })
    renderViewer({ readonlyBadge: true })
    await waitFor(() => expect(screen.getByText(/该侧不存在此文件|does not exist/)).toBeTruthy())
    cleanup()
    files.set('src/big.txt', { exists: true, content: bigPlainContent(['x']) })
    renderViewer({ readonlyBadge: true })
    await waitFor(() => expect(screen.getByText(/任务外文件|Outside the diff/)).toBeTruthy())
  })

  test('content swap renders the LATEST content, never a stale mix (P1-9④ version guard)', async () => {
    files.set('src/big.txt', { exists: true, content: bigPlainContent(['first_version()']) })
    const { container, rerender } = renderViewer({
      changedRanges: [{ start: 1, end: 1, type: 'modified' }],
    })
    await waitFor(() => expect(container.querySelector('[data-ln="1"]')).toBeTruthy())
    // same path, new content (fresh queryKey via side flip forces a refetch)
    files.set('src/big.txt', { exists: true, content: bigPlainContent(['second_version()']) })
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CodeViewer
          taskId="t1"
          repoKey=""
          filePath="src/big.txt"
          side="base"
          changedRanges={[{ start: 1, end: 1, type: 'modified' }]}
        />
      </QueryClientProvider>,
    )
    await waitFor(() =>
      expect(container.querySelector('[data-ln="1"]')?.textContent).toContain('second_version()'),
    )
  })

  test('identifier click resolves through the delegated layer; buttons are exempt (F-11)', async () => {
    files.set('src/big.txt', { exists: true, content: bigPlainContent(['callMe(now)']) })
    const hits: unknown[] = []
    const { container } = renderViewer({
      onIdentifierClick: (h) => hits.push(h),
      changedRanges: [{ start: 1, end: 1, type: 'modified' }],
    })
    await waitFor(() => expect(container.querySelector('[data-ln="1"]')).toBeTruthy())
    // jsdom has no caret APIs — the layer must simply not throw and not fire.
    const row = container.querySelector('[data-ln="1"]') as HTMLElement
    row.click()
    expect(hits).toHaveLength(0)
    // clicking the fold button (a real control) must never resolve as identifier
    const fold = screen.getByRole('button', { name: /未变更|unchanged/ })
    fold.click()
    expect(hits).toHaveLength(0)
  })
})
