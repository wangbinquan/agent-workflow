// RFC-142 — /reviews 列表展开：多文档评审渲染轮行（RoundRows）。
//
// 锁定 design D9：轮号 = 排序后 1-based 序号（reviewIteration 会跳、
// roundGeneration 数值无语义，都不适合示人）；当前轮 Open 发空 search、
// 历史轮 Open 带 ?round=<roundKey>；轮行带决策 chip + 文档数。
// 另加源代码层兜底：列表页按 isMultiDoc 分支（多文档 RoundRows /
// 单文档 HistoryRows 保持 v1..vN 不变）。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'
import type { ReviewRoundSummary } from '@agent-workflow/shared'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

import { api } from '../src/api/client'
import { RoundRows } from '../src/routes/reviews'
import i18n from '../src/i18n'

const rounds: ReviewRoundSummary[] = [
  {
    roundKey: 'g1',
    reviewIteration: 0,
    roundGeneration: 1,
    decision: 'superseded',
    decisionReason: 'upstream-refreshed',
    decidedAt: 1750000001000,
    decidedBy: 'system',
    decidedByRole: null,
    createdAt: 1750000000000,
    isCurrent: false,
    members: [
      {
        docVersionId: 's0',
        itemIndex: 0,
        itemPath: 'cases/a.md',
        title: 'A v1',
        selection: 'unselected',
        commentCount: 0,
        decision: 'superseded',
      },
    ],
  },
  {
    roundKey: 'g2',
    reviewIteration: 0,
    roundGeneration: 2,
    decision: 'pending',
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
    decidedByRole: null,
    createdAt: 1750000002000,
    isCurrent: true,
    members: [
      {
        docVersionId: 'n0',
        itemIndex: 0,
        itemPath: 'cases/a.md',
        title: 'A v2',
        selection: 'unselected',
        commentCount: 0,
        decision: 'pending',
      },
      {
        docVersionId: 'n1',
        itemIndex: 1,
        itemPath: 'cases/b.md',
        title: 'B v2',
        selection: 'unselected',
        commentCount: 0,
        decision: 'pending',
      },
    ],
  },
]

function wrap(node: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {node}
        <Outlet />
      </>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  const reviewsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/reviews/$nodeRunId',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, reviewsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/reviews/run/rounds') return Promise.resolve(rounds)
    return Promise.resolve(undefined)
  })
})

describe('RoundRows（多文档轮行）', () => {
  test('轮号 1-based + 决策 chip + 文档数 + 当前 pill；历史轮 Open 带 ?round=', async () => {
    wrap(<RoundRows nodeRunId="run" />)
    expect(await screen.findByText('Round 1')).toBeTruthy()
    expect(screen.getByText('Round 2')).toBeTruthy()
    expect(screen.getByText('superseded')).toBeTruthy()
    expect(screen.getByText('pending')).toBeTruthy()
    expect(screen.getByText('current')).toBeTruthy() // 当前 pill 只在 g2 行
    expect(screen.getByText('1 document(s)')).toBeTruthy()
    expect(screen.getByText('2 document(s)')).toBeTruthy()
    const links = screen.getAllByText('Open').map((el) => el.closest('a')!)
    expect(links.length).toBe(2)
    expect(links[0]!.getAttribute('href')).toContain('round=g1')
    // 当前轮发空 search —— 不携带 round 参数。
    expect(links[1]!.getAttribute('href') ?? '').not.toContain('round=')
  })
})

describe('reviews 列表分支（源代码层兜底）', () => {
  test('isMultiDoc 走 RoundRows，单文档保持 HistoryRows', () => {
    const src = readFileSync(resolve(__dirname, '../src/routes/reviews.tsx'), 'utf-8')
    expect(src).toContain('r.isMultiDoc === true ? (')
    expect(src).toContain('<RoundRows nodeRunId={r.nodeRunId} />')
    expect(src).toContain('<HistoryRows')
  })
})
