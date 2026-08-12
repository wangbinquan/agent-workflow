// RFC-291 面 C（前端）—— 失效挂载在「已挂载元素」里说明后果。
//
// 后端把这类根从「整轮硬失败」改成「本轮跳过」，前端就必须告诉用户跳过这回事：
// 只显示「资源不可用」会让人以为它仍参与生成，从而对着一个不会被读取的资源继续
// 提修改。判据沿用既有投影：路由层对不可见资源把 displayName 置 null。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import type { IntentSessionDetail } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function detailWithMounts(mounts: IntentSessionDetail['mounts']): IntentSessionDetail {
  return {
    mounts,
    mountSuggestions: null,
    turns: [
      {
        id: 'T1',
        seq: 1,
        role: 'user',
        kind: 'message',
        content: { message: 'build it' },
        contextRevision: 0,
        runMeta: null,
        scratchRetained: false,
        execution: null,
        createdAt: 1,
      },
    ],
    currentDraft: null,
    commits: [],
    session: {
      id: 'S1',
      title: 'audit pipeline',
      status: 'active',
      contextRevision: 0,
      turnSeq: 2,
      commitSeq: 0,
      inFlight: false,
      currentDraftRevision: null,
      journey: { kind: 'goal', reason: 'describe-goal', step: 1, completedThrough: 0 },
      createdAt: 1,
      updatedAt: Date.now(),
    },
  }
}

function installFetch(detail: IntentSessionDetail): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_req, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (method === 'POST') return json({ turnId: 'T9' })
    return json(detail)
  })
}

async function renderPage(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const mod = await import('../src/routes/intent.detail')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/intent/$sessionId',
    component: mod.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/intent/S1'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

const mount = (over: Partial<IntentSessionDetail['mounts'][number]>) => ({
  handle: 'res#agent#1',
  resourceType: 'agent' as const,
  resourceId: 'A1',
  displayName: null,
  detail: false,
  ...over,
})

describe('RFC-291 已挂载元素：失效项说明会被跳过', () => {
  test('displayName 为 null → 同时显示「资源不可用」与「生成时将跳过」', async () => {
    installFetch(detailWithMounts([mount({})]))
    await renderPage()

    const heading = await screen.findByRole('heading', { name: enUS.intent.mounts })
    const section = heading.closest('section')
    expect(section).not.toBeNull()
    const list = within(section as HTMLElement)
    expect(await list.findByText(enUS.intent.mountUnavailable)).toBeTruthy()
    expect(list.getByText(new RegExp(enUS.intent.mountUnavailableHint))).toBeTruthy()
  })

  test('资源可用时不显示该提示（避免对正常挂载误报）', async () => {
    installFetch(detailWithMounts([mount({ displayName: 'auditor', detail: true })]))
    await renderPage()

    const heading = await screen.findByRole('heading', { name: enUS.intent.mounts })
    const list = within(heading.closest('section') as HTMLElement)
    expect(await list.findByText('auditor')).toBeTruthy()
    expect(list.queryByText(new RegExp(enUS.intent.mountUnavailableHint))).toBeNull()
    expect(list.queryByText(enUS.intent.mountUnavailable)).toBeNull()
  })
})
