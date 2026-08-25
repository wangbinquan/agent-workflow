// 2026-08-25 回归锁：一次**例行**的 `/api/auth/me` 后台续期不得关掉用户正开着的界面。
//
// 用户实测的症状：正在看某个任务的「结构变更 → 关系图」弹窗，一有新任务 / event 产生，
// 页面就"刷新一下"，弹窗被关掉、选中的文件与展开状态一起丢。根因是两处把
// 「react-query 正在后台 refetch」当成了「当前授权不明」：
//   1. AppShell —— `useCurrentPermissions()` 在 `fetchStatus !== 'idle'` 时返回空集，
//      于是已授权路由被塞进 Activity(hidden) 且 `RoutePortalScope` 关闭，**body 上的
//      portal（Dialog / Select 浮层）被整体摘除**（该分支的锁在 app-shell-layout.test.tsx）；
//   2. routes/tasks.detail.tsx —— `permissionsReady` 同样要求 idle，于是
//      `resolveTaskDetailTabs` 返回 pending、整页早退成 <LoadingState>，把
//      ChangeReviewPanel 连同它持有的「弹窗开着」状态一起卸掉；续期结束后重新挂载
//      出来的是全新的空状态，所以弹窗是**永久**关闭而不是闪一下。
//
// `/me` 的后台续期在真实会话里非常频繁（`/ws/authority` 每次物理重连都会失效它；
// staleTime 30s 过后任何一个新挂载的观察者都会触发 refetchOnMount），所以呈现面必须读
// 「末次已解析」的快照。写权判定不变：usePermission / hasPermissionAtRequest 照旧在
// 续期期间返回 false（use-privileged-nodes-fail-closed.test.tsx 锁的就是那一侧）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  meQueryOptions,
  useCurrentPermissions,
  useLastResolvedPermissions,
  type MeResponse,
} from '../src/hooks/useActor'
import { setBaseUrl, setToken } from '../src/stores/auth'

const TOKEN = 'tok-authority-refresh'

function actor(permissions: MeResponse['permissions']): MeResponse {
  return {
    user: { id: 'u1', username: 'dev', displayName: 'Dev', role: 'user', status: 'active' },
    profile: {
      displayName: 'Dev',
      email: 'dev@example.test',
      gitCommitIdentity: { name: 'Dev', email: 'dev@example.test' },
    },
    source: 'session',
    permissions,
    linkedIdentities: [],
    pats: [],
  }
}

function Probe() {
  const resolved = useLastResolvedPermissions()
  const strict = useCurrentPermissions()
  return (
    <>
      <output data-testid="resolved">
        {resolved.resolved
          ? resolved.permissions.has('tasks:read')
            ? 'granted'
            : 'denied'
          : 'unresolved'}
      </output>
      <output data-testid="strict">{strict.has('tasks:read') ? 'granted' : 'denied'}</output>
    </>
  )
}

beforeEach(() => {
  setBaseUrl('http://authority-refresh.test')
  setToken(TOKEN)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useLastResolvedPermissions — 呈现面读末次已解析快照', () => {
  test('后台续期期间保留上一份授权，写权判定同时刻仍然失效', async () => {
    let settleRefresh!: (response: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolvePromise) => {
          settleRefresh = resolvePromise
        }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(meQueryOptions(TOKEN).queryKey, actor(['tasks:read']))
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('granted'))

    let refresh!: Promise<void>
    act(() => {
      refresh = client.refetchQueries({ queryKey: meQueryOptions(TOKEN).queryKey })
    })
    // 续期在飞行中——先等动作面转成失效（安全语义未放松）……
    await waitFor(() => expect(screen.getByTestId('strict').textContent).toBe('denied'))
    // ……同一时刻呈现面照旧授权：页面不塌、portal 不摘、弹窗不关。
    expect(screen.getByTestId('resolved').textContent).toBe('granted')

    await act(async () => {
      settleRefresh(
        new Response(JSON.stringify(actor(['tasks:read'])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      await refresh
    })
    await waitFor(() => expect(screen.getByTestId('strict').textContent).toBe('granted'))
    expect(screen.getByTestId('resolved').textContent).toBe('granted')
  })

  test('解析失败 / 账号不可用 = 未解析，呈现面同样失效', async () => {
    let rejectRefresh!: (reason: unknown) => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((_resolvePromise, reject) => {
          rejectRefresh = reject
        }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(meQueryOptions(TOKEN).queryKey, actor(['tasks:read']))
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('granted'))

    let refresh!: Promise<void>
    act(() => {
      refresh = client.refetchQueries({ queryKey: meQueryOptions(TOKEN).queryKey })
    })
    await act(async () => {
      rejectRefresh(new Error('me refresh failed'))
      await refresh
    })
    // react-query 保留了上一份 data，但 status 已是 error —— 这才是真正的「授权不明」，
    // 呈现面必须一起失效（AppShell 据此挂起页面并给出重试横幅）。
    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('unresolved'))
    expect(screen.getByTestId('strict').textContent).toBe('denied')

    // 已解析、但确实不含该权限 = 明确拒绝，与「不明」区分开。
    act(() => {
      client.setQueryData(meQueryOptions(TOKEN).queryKey, actor([]))
    })
    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('denied'))
  })
})

describe('routes/tasks.detail.tsx — 整页早退闸不得再看 fetchStatus', () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
    'utf-8',
  )

  test('permissionsReady 取自末次已解析快照', () => {
    expect(SRC).toMatch(
      /const \{ resolved: permissionsReady[\s\S]{0,120}useLastResolvedPermissions\(\)/,
    )
    expect(SRC).toContain('capabilitiesReady: permissionsReady')
  })

  test('页面不再把「正在续期」当成未就绪（tabResolution 会因此整页塌成 LoadingState）', () => {
    expect(SRC).not.toContain('actor.fetchStatus')
  })

  test('删除动作仍走严格的请求边界判定', () => {
    expect(SRC).toContain("hasPermissionAtRequest(qc, 'tasks:delete')")
  })
})
