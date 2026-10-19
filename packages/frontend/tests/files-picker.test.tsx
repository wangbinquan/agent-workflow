// FilesPicker (launch form, kind=files): derives selected paths from the
// newline-joined value, enforces max cap, and re-packs newline-joined on
// every toggle.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowInput } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { FilesPicker } from '../src/components/launch/FilesPicker'

function def(extra: Record<string, unknown> = {}): WorkflowInput {
  return {
    kind: 'files',
    key: 'targets',
    label: 'Targets',
    ...extra,
  } as WorkflowInput
}

function wrap(node: React.ReactElement, files: string[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['repos', 'files', 'repo-1'], { files })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// RFC-110 — url launch mode: enumerate the matched registered repository
// (cachedRepoId names it; RFC-370 §10 V17 replaced the mirror's local path), fall
// back to a text input when uncached / errored, and never hide a
// selected-but-unlisted path (it stays visible + removable).
describe('FilesPicker (RFC-110 url mode)', () => {
  function wrapUrl(node: React.ReactElement, cachedRepoId: string, files: string[]) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    qc.setQueryData(['repos', 'files', cachedRepoId], { files })
    return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
  }

  test('uncached url (cachedRepoId="") → text fallback, not "pick a repo first"', () => {
    const onChange = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FilesPicker
          def={def()}
          cachedRepoId=""
          sourceKind="url"
          value="src/x.ts"
          onChange={onChange}
        />
      </QueryClientProvider>,
    )
    const ta = screen.getByTestId('files-picker-url-fallback') as HTMLTextAreaElement
    expect(ta.value).toBe('src/x.ts')
    expect(screen.queryByText(/Pick a repo first/i)).toBeNull()
    fireEvent.change(ta, { target: { value: 'src/y.ts' } })
    expect(onChange).toHaveBeenLastCalledWith('src/y.ts')
  })

  test('cache hit → cache snapshot hint + checkbox list', () => {
    wrapUrl(
      <FilesPicker
        def={def()}
        cachedRepoId="repo-x"
        sourceKind="url"
        value=""
        onChange={() => {}}
      />,
      'repo-x',
      ['a.ts', 'b.ts'],
    )
    expect(screen.getByTestId('files-picker-cache-hint')).toBeTruthy()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  })

  test('cache hit surfaces selected-but-not-in-listing paths as removable rows', () => {
    const onChange = vi.fn()
    wrapUrl(
      <FilesPicker
        def={def()}
        cachedRepoId="repo-x"
        sourceKind="url"
        value={'a.ts\nb.ts'}
        onChange={onChange}
      />,
      'repo-x',
      ['b.ts'],
    )
    const extra = screen.getByTestId('files-picker-extra-selected')
    expect(within(extra).getByText('a.ts')).toBeTruthy()
    // Unchecking the surfaced stale row removes it from the packed value.
    fireEvent.click(within(extra).getByRole('checkbox'))
    expect(onChange).toHaveBeenLastCalledWith('b.ts')
  })

  test('enumeration error → text fallback (no error-box)', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('boom'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FilesPicker
          def={def()}
          cachedRepoId="repo-x"
          sourceKind="url"
          value=""
          onChange={() => {}}
        />
      </QueryClientProvider>,
    )
    expect(await screen.findByTestId('files-picker-url-fallback')).toBeTruthy()
    expect(screen.queryByText(/error/i)).toBeNull()
  })

  test('cache listing still loading → current selection stays visible + removable', () => {
    // Keep the files query pending so the component sits in the loading state.
    vi.spyOn(api, 'get').mockReturnValue(new Promise(() => {}))
    const onChange = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FilesPicker
          def={def()}
          cachedRepoId="repo-x"
          sourceKind="url"
          value={'a.ts\nb.ts'}
          onChange={onChange}
        />
      </QueryClientProvider>,
    )
    // The stale value is NOT hidden behind "Loading…" — it shows as removable rows.
    const loadingSel = screen.getByTestId('files-picker-loading-selected')
    expect(within(loadingSel).getByText('a.ts')).toBeTruthy()
    expect(within(loadingSel).getByText('b.ts')).toBeTruthy()
    fireEvent.click(within(loadingSel).getAllByRole('checkbox')[0]!)
    expect(onChange).toHaveBeenLastCalledWith('b.ts')
  })

  test('path mode (default) keeps "pick a repo first" for empty cachedRepoId', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FilesPicker def={def()} cachedRepoId="" value="" onChange={() => {}} />
      </QueryClientProvider>,
    )
    expect(screen.getByText(/Pick a repo first/i)).toBeTruthy()
    expect(screen.queryByTestId('files-picker-url-fallback')).toBeNull()
  })
})

describe('FilesPicker', () => {
  test('derives selected set from newline-joined value', () => {
    wrap(
      <FilesPicker
        def={def()}
        cachedRepoId="repo-1"
        value={'src/a.ts\nsrc/b.ts'}
        onChange={() => {}}
      />,
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    )
    const cb = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // Order matches the files list above.
    expect(cb.map((c) => c.checked)).toEqual([true, true, false])
  })

  test('toggling a row emits a newline-joined string', () => {
    const onChange = vi.fn()
    wrap(<FilesPicker def={def()} cachedRepoId="repo-1" value="" onChange={onChange} />, [
      'x.ts',
      'y.ts',
    ])
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(onChange).toHaveBeenLastCalledWith('x.ts')
  })

  test('respects maxCount — toggling past the cap is a no-op', () => {
    const onChange = vi.fn()
    wrap(
      <FilesPicker
        def={def({ maxCount: 1 })}
        cachedRepoId="repo-1"
        value="x.ts"
        onChange={onChange}
      />,
      ['x.ts', 'y.ts'],
    )
    // Adding y.ts would push selected to 2 → ignored.
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    expect(onChange).not.toHaveBeenCalled()
    // But un-toggling x.ts is allowed (set shrinks).
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  test('filter narrows the visible list', () => {
    wrap(<FilesPicker def={def()} cachedRepoId="repo-1" value="" onChange={() => {}} />, [
      'alpha.ts',
      'beta.ts',
      'gamma.ts',
    ])
    fireEvent.change(screen.getByPlaceholderText('Filter paths…'), { target: { value: 'be' } })
    const labels = screen.getAllByRole('checkbox').map((cb) => cb.parentElement?.textContent ?? '')
    expect(labels).toEqual(['beta.ts'])
  })

  test('cachedRepoId="" shows the prompt instead of loading', () => {
    wrap(<FilesPicker def={def()} cachedRepoId="" value="" onChange={() => {}} />, [])
    expect(screen.getByText(/Pick a repo first/i)).toBeTruthy()
  })
})
