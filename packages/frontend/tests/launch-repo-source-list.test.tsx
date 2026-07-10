// LOCKS: RFC-066 PR-C — `<RepoSourceList>` UI behavior. Renders 1..N
// `<RepoSourceRow>` rows with `+ Add repository` / `− Remove` controls
// and the multi-repo blocked-reason banner.
//
// Cases:
//   F1 default render: 1 row, no `−` button on the lone row, `+` button visible.
//   F2 click `+` appends an empty row; both rows now have `−` buttons.
//   F3 click `−` on a row removes it; back to 1 row, `−` hidden again.
//   F4 reach MULTI_REPO_MAX → `+` button disabled + max-reached hint.
//   F5 multi-repo + wrapper-git → banner visible with the right localized text.
//   F5b multi-repo + upload → upload-blocked banner visible.
//   F6 basename collision: row 2 preview chip shows `-2` suffix.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { MULTI_REPO_MAX } from '@agent-workflow/shared'
import { RepoSourceList } from '../src/components/launch/RepoSourceList'
import { defaultRepoSource, type RepoSource } from '../src/lib/launch-repo-source'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  // Stub fetch so any /api/repos/* query inside the rows resolves to []
  // without exercising the real network.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderList(props: {
  repos: RepoSource[]
  onChange?: (next: RepoSource[]) => void
  multiRepoBlockedReason?: 'wrapper-git' | 'upload' | null
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChange = props.onChange ?? (() => {})
  return render(
    <QueryClientProvider client={qc}>
      <RepoSourceList
        repos={props.repos}
        onChange={onChange}
        multiRepoBlockedReason={props.multiRepoBlockedReason ?? null}
      />
    </QueryClientProvider>,
  )
}

describe('RepoSourceList — RFC-066 PR-C UI contract', () => {
  test('F1 default render: 1 row, no `−` button, `+ Add` button visible', () => {
    const { queryByTestId, getByTestId } = renderList({ repos: [defaultRepoSource()] })
    // The lone row exists with index suffix -0.
    expect(getByTestId('repo-source-row-0')).toBeDefined()
    // `−` button is NOT rendered on the only row.
    expect(queryByTestId('repo-source-remove-0')).toBeNull()
    // `+` button is rendered + enabled.
    const addBtn = getByTestId('repo-source-add') as HTMLButtonElement
    expect(addBtn.disabled).toBe(false)
  })

  test('F2 click `+` appends a new empty row; both rows now show `−` button', () => {
    let repos: RepoSource[] = [defaultRepoSource()]
    const onChange = (next: RepoSource[]) => {
      repos = next
    }
    const { getByTestId, rerender } = renderList({ repos, onChange })
    fireEvent.click(getByTestId('repo-source-add'))
    expect(repos).toHaveLength(2)
    // Re-render with the new array to verify `−` shows up.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={qc}>
        <RepoSourceList repos={repos} onChange={onChange} multiRepoBlockedReason={null} />
      </QueryClientProvider>,
    )
    expect(getByTestId('repo-source-remove-0')).toBeDefined()
    expect(getByTestId('repo-source-remove-1')).toBeDefined()
  })

  test('F3 click `−` on a row removes it; back to 1 row, `−` hidden again', () => {
    let repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@h:o/a.git', ref: '' },
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: '' },
    ]
    const onChange = (next: RepoSource[]) => {
      repos = next
    }
    const { getByTestId, rerender, queryByTestId } = renderList({ repos, onChange })
    fireEvent.click(getByTestId('repo-source-remove-1'))
    expect(repos).toHaveLength(1)
    expect(repos[0]!.repoUrl).toBe('git@h:o/a.git')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={qc}>
        <RepoSourceList repos={repos} onChange={onChange} multiRepoBlockedReason={null} />
      </QueryClientProvider>,
    )
    // `−` button hidden again (only one row left).
    expect(queryByTestId('repo-source-remove-0')).toBeNull()
  })

  test('F4 reach MULTI_REPO_MAX → `+` button disabled + max-reached hint visible', () => {
    const repos: RepoSource[] = Array.from({ length: MULTI_REPO_MAX }, (_, i) => ({
      kind: 'url' as const,
      repoUrl: `git@h:o/r${i}.git`,
      ref: '',
    }))
    const { getByTestId } = renderList({ repos })
    const addBtn = getByTestId('repo-source-add') as HTMLButtonElement
    expect(addBtn.disabled).toBe(true)
    const hint = getByTestId('repo-source-max-hint')
    expect(hint.textContent ?? '').toMatch(new RegExp(String(MULTI_REPO_MAX)))
  })

  test('F5 multi-repo + wrapper-git → banner visible', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@h:o/a.git', ref: '' },
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: '' },
    ]
    const { getByTestId } = renderList({ repos, multiRepoBlockedReason: 'wrapper-git' })
    const banner = getByTestId('repo-source-multi-banner')
    // The localized text mentions wrapper-git or 多仓; both en + cn render
    // the same testid so this assertion is i18n-agnostic on the testid +
    // checks the banner role / non-empty body.
    expect((banner.textContent ?? '').length).toBeGreaterThan(0)
    expect(banner.getAttribute('role')).toBe('alert')
  })

  test('F5b multi-repo + upload → banner visible (separate code path)', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@h:o/a.git', ref: '' },
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: '' },
    ]
    const { getByTestId } = renderList({ repos, multiRepoBlockedReason: 'upload' })
    const banner = getByTestId('repo-source-multi-banner')
    expect((banner.textContent ?? '').length).toBeGreaterThan(0)
    expect(banner.getAttribute('role')).toBe('alert')
  })

  test('F5c single-repo never renders the banner even if a reason is passed', () => {
    const { queryByTestId } = renderList({
      repos: [{ kind: 'url', repoUrl: 'git@h:o/a.git', ref: '' }],
      multiRepoBlockedReason: 'wrapper-git',
    })
    expect(queryByTestId('repo-source-multi-banner')).toBeNull()
  })

  test('F6 basename collision: row 2 preview chip shows `-2` suffix', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@github.com:a/utils.git', ref: '' },
      { kind: 'url', repoUrl: 'git@github.com:b/utils.git', ref: '' },
    ]
    const { getByTestId } = renderList({ repos })
    const preview1 = getByTestId('repo-source-preview-1')
    expect((preview1.textContent ?? '').includes('utils-2')).toBe(true)
  })
})
