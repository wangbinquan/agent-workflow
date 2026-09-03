// RFC-353（2026-09-03 用户裁决）—— ACL 面板撞 409 之后，草稿丢弃、面板刷回权威值。
//
// 为什么这条测试存在：在它之前，「面板刷回权威快照」是**偶然**成立的。409 分支只做
// `invalidateQueries`，不清 `dirty`；而可见性单选框渲染的是本地草稿，只在
// `!dirty && !transferOpen` 或 `!liveCanManage` 时才被权威值覆盖。于是收敛全靠刷新期间
// 恰好有一帧观察到 `query.fetchStatus === 'fetching'`（`liveCanManage` 转 false）——
// 那一帧被 React 批掉或 refetch 太快就不会发生，面板继续显示陈旧草稿。
// e2e IAM-33 正是这么红的（webkit nightly run 33752894225），而它在 chromium 上一直绿，
// 因为时序不同。**渲染时序不能当契约**，所以这里在组件层把它钉死。
//
// 同批修正了一处文档与代码的矛盾：RFC-170 §8 原写「409 保留草稿并提示 reload」，
// 用户 2026-09-03 裁定改为「以服务端为准、草稿丢弃」，design.md 已同步。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  }
})

import { api } from '../src/api/client'
import { AclPanel } from '../src/components/AclPanel'
import { setToken } from '../src/stores/auth'
import '../src/i18n'

const mockedGet = vi.mocked(api.get)
const mockedPut = vi.mocked(api.put)

const OWNER = {
  id: 'u-owner',
  username: 'owner',
  displayName: 'Owner',
  role: 'user' as const,
  status: 'active' as const,
}

/** 服务端权威快照：始终 private；并发写者只推进了 revision。 */
function authoritativeAcl(aclRevision: number) {
  return {
    resourceType: 'agent',
    resourceId: 'a1',
    ownerUserId: OWNER.id,
    owner: OWNER,
    visibility: 'private',
    grants: [],
    canManage: true,
    canEdit: true,
    aclRevision,
  }
}

beforeEach(() => {
  setToken('aws_s_test-token')
  mockedGet.mockReset()
  mockedPut.mockReset()
})
afterEach(() => cleanup())

describe('RFC-353 —— ACL 保存撞 409', () => {
  test('草稿被丢弃，面板刷回服务端的权威值（不依赖任何渲染时序）', async () => {
    // 面板加载时拿到 revision=0；并发写者随后把它推进到 1，可见性仍是 private。
    let revision = 0
    mockedGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/acl')) return authoritativeAcl(revision)
      if (url === '/api/users/search') return []
      return { source: 'session', user: OWNER, permissions: [] }
    })
    // 保存必 409：面板握的是 revision=0，服务端已经是 1。
    mockedPut.mockImplementation(async () => {
      revision = 1
      throw Object.assign(new Error('acl-revision-stale'), {
        status: 409,
        body: { error: 'acl-revision-stale' },
      })
    })

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <AclPanel resourceBaseUrl="/api/agents/a1" invalidateKey={['agents']} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())

    // 用户把草稿改脏：选 public。
    fireEvent.click(screen.getByTestId('acl-visibility-public'))
    await waitFor(() =>
      expect(screen.getByTestId('acl-visibility-public').getAttribute('aria-checked')).toBe('true'),
    )

    fireEvent.click(screen.getByTestId('acl-save'))

    // 判据：面板收敛回服务端的 private，而不是停在用户那份陈旧的 public。
    await waitFor(
      () =>
        expect(
          screen.getByTestId('acl-visibility-private').getAttribute('aria-checked'),
          '409 之后面板仍显示草稿值 ⇒ 用户对着一个与服务端不符的界面继续操作',
        ).toBe('true'),
      { timeout: 3000 },
    )
    expect(screen.getByTestId('acl-visibility-public').getAttribute('aria-checked')).toBe('false')
  })

  test('弹窗不关、错误提示还在——用户必须知道这次没存进去', async () => {
    let revision = 0
    mockedGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/acl')) return authoritativeAcl(revision)
      if (url === '/api/users/search') return []
      return { source: 'session', user: OWNER, permissions: [] }
    })
    mockedPut.mockImplementation(async () => {
      revision = 1
      throw Object.assign(new Error('acl-revision-stale'), {
        status: 409,
        body: { error: 'acl-revision-stale' },
      })
    })

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <AclPanel resourceBaseUrl="/api/agents/a1" invalidateKey={['agents']} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    fireEvent.click(screen.getByTestId('acl-visibility-public'))
    fireEvent.click(screen.getByTestId('acl-save'))

    // 丢草稿不等于静默：面板留在原地，错误文案必须还在，否则用户会以为存住了。
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    await waitFor(() =>
      expect(document.querySelector('.form-actions__error')?.textContent ?? '').not.toBe(''),
    )
  })
})
