// GitPicker (launch form, kind=git): emit shape per sub-kind + parse existing
// JSON value. The branch sub-kind queries /api/repos/refs; we don't fetch in
// tests — we just confirm the dropdown renders + emits without data.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowInput } from '@agent-workflow/shared'
import { GitPicker } from '../src/components/launch/GitPicker'

function def(extra: Record<string, unknown> = {}): WorkflowInput {
  return {
    kind: 'git',
    key: 'target',
    label: 'Target',
    ...extra,
  } as WorkflowInput
}

function wrap(node: React.ReactElement, refs?: { branches: string[] }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  if (refs !== undefined) qc.setQueryData(['repos', 'refs', 'repo-1'], refs)
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

afterEach(() => {
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
})

describe('GitPicker', () => {
  test('commit-range emits {kind, from, to} JSON', () => {
    const onChange = vi.fn()
    wrap(
      <GitPicker
        def={def({ gitKind: 'commit-range' })}
        cachedRepoId=""
        value=""
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('origin/main'), { target: { value: 'abc' } })
    expect(onChange).toHaveBeenLastCalledWith(
      JSON.stringify({ kind: 'commit-range', from: 'abc', to: '' }),
    )
  })

  test('commit-range round-trips an existing JSON value', () => {
    const onChange = vi.fn()
    wrap(
      <GitPicker
        def={def({ gitKind: 'commit-range' })}
        cachedRepoId=""
        value={JSON.stringify({ kind: 'commit-range', from: 'x', to: 'y' })}
        onChange={onChange}
      />,
    )
    expect((screen.getByPlaceholderText('origin/main') as HTMLInputElement).value).toBe('x')
    expect((screen.getByPlaceholderText('HEAD') as HTMLInputElement).value).toBe('y')
    fireEvent.change(screen.getByPlaceholderText('HEAD'), { target: { value: 'z' } })
    expect(onChange).toHaveBeenLastCalledWith(
      JSON.stringify({ kind: 'commit-range', from: 'x', to: 'z' }),
    )
  })

  test('pr sub-kind emits {kind: pr, number}', () => {
    const onChange = vi.fn()
    wrap(<GitPicker def={def({ gitKind: 'pr' })} cachedRepoId="" value="" onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText('123'), { target: { value: '42' } })
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify({ kind: 'pr', number: '42' }))
  })

  test('branch sub-kind defaults to gitKind=branch and emits {kind, ref}', () => {
    const onChange = vi.fn()
    // No gitKind in def → defaults to 'branch'. Seed the refs cache so the
    // dropdown has real options to pick from.
    wrap(<GitPicker def={def()} cachedRepoId="repo-1" value="" onChange={onChange} />, {
      branches: ['main', 'dev'],
    })
    const trigger = screen.getByRole('combobox')
    // value '' → trigger shows the placeholder.
    expect(trigger.textContent).toMatch(/pick a branch/i)
    fireEvent.click(trigger)
    const list = document.getElementById(trigger.getAttribute('aria-controls')!)!
    fireEvent.mouseDown(within(list).getByText('main'))
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify({ kind: 'branch', ref: 'main' }))
  })

  test('malformed existing JSON value is treated as empty', () => {
    const onChange = vi.fn()
    wrap(
      <GitPicker
        def={def({ gitKind: 'commit-range' })}
        cachedRepoId=""
        value="not-json"
        onChange={onChange}
      />,
    )
    expect((screen.getByPlaceholderText('origin/main') as HTMLInputElement).value).toBe('')
    expect((screen.getByPlaceholderText('HEAD') as HTMLInputElement).value).toBe('')
  })
})

// RFC-110 — branch sub-kind in url launch mode: enumerate the matched cached
// clone's branches; with no cache fall back to a free-text branch input; surface
// a stored ref absent from the (cached) branch list as an explicit option.
describe('GitPicker branch (RFC-110 url mode)', () => {
  test('url mode + uncached (no cachedRepoId) → text fallback emits {kind:branch,ref}', () => {
    const onChange = vi.fn()
    wrap(<GitPicker def={def()} cachedRepoId="" sourceKind="url" value="" onChange={onChange} />)
    const input = screen.getByTestId('git-picker-branch-fallback') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { value: 'feature-x' } })
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify({ kind: 'branch', ref: 'feature-x' }))
  })

  test('url mode + cache hit (cachedRepoId set, refs loaded) → Select dropdown, not text fallback', () => {
    wrap(
      <GitPicker def={def()} cachedRepoId="repo-1" sourceKind="url" value="" onChange={() => {}} />,
      {
        branches: ['main', 'dev'],
      },
    )
    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(screen.queryByTestId('git-picker-branch-fallback')).toBeNull()
  })

  test('stored ref not in the branch list is surfaced as an explicit option (not hidden)', () => {
    wrap(
      <GitPicker
        def={def()}
        cachedRepoId="repo-1"
        sourceKind="url"
        value={JSON.stringify({ kind: 'branch', ref: 'feature-x' })}
        onChange={() => {}}
      />,
      { branches: ['main', 'dev'] },
    )
    // The Select trigger shows the current ref (via the injected option) rather
    // than silently falling back to the placeholder while the value persists.
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toMatch(/feature-x/)
    expect(trigger.textContent).not.toMatch(/pick a branch/i)
  })
})
