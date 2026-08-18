// RFC-310 PR-5 T61 — Mission 列表/详情页。
//
// 锁的是页面对使用者的回答，而不是标记存在性：①列表把 mission 状态与阻塞码
// 如实示人（「开单 ≠ 在跑」的诚实边界是产品语义）；②launch 表单三形态提交出
// **正确的 API 载荷**（idempotencyKey 固定、direct 正文、员工 pin 已发布
// revision）；③详情页在 awaiting-information 时渲染问题并提交完整答案集
// （提交即冻结——不许漏答，按钮 gating 锁住）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'
import { missionStatusKind } from '../src/routes/code.missions'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

const ME = {
  user: { id: 'u-1', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
  source: 'session',
  linkedIdentities: [],
  pats: [],
  permissions: [
    'development-missions:read',
    'development-missions:launch',
    'development-missions:interact',
    'development-missions:cancel',
    'development-missions:retry',
  ],
}

const MISSION_ROW = {
  id: '01MISSION0000000000000001',
  status: 'blocked',
  automationMode: 'active',
  repositoryId: 'repo-1',
  sourceKind: 'direct',
  externalId: null,
  deliveryKind: 'create-merge-request',
  employeeId: 'emp-1',
  blockCode: 'collector-not-wired:repository',
  terminalKind: null,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
}

const MISSION_DETAIL = {
  ...MISSION_ROW,
  transitionFence: 'none',
  resolvedSourceKey: null,
  employeeRevision: 1,
  policyId: 'pol-1',
  policyRevision: 1,
  blockDetail: null,
  sources: [
    {
      generation: 1,
      sourceKind: 'direct',
      externalId: null,
      sourceRevision: 'r1',
      bundleRef: 'b1',
      manifestDigest: 'd'.repeat(64),
      state: 'materialized',
    },
  ],
  readiness: { status: 'working' },
  questions: {
    questionSetRef: 'qs-1',
    origin: 'agent',
    channel: 'platform',
    items: [
      { questionId: 'q1', text: 'Which module?', answerKind: 'text', choices: null },
      { questionId: 'q2', text: 'Blocking?', answerKind: 'text', choices: null },
    ],
  },
  action: {
    lastOutcome: 'needs-information',
    lastCapability: 'change.implement',
    candidateRef: null,
    clarificationState: 'questions-published',
  },
  effects: [],
}

function installFetch(overrides: {
  missions?: unknown[]
  detail?: unknown
  manifestStatus?: number
}): Recorded {
  const rec: Recorded = { calls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      rec.calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/auth/me')) return json(ME)
      if (url.includes('/api/cached-repos')) {
        return json({ items: [{ id: 'repo-1', urlRedacted: 'https://git.test/team/app' }] })
      }
      if (url.includes('/api/code/digital-employees')) {
        return json({ items: [{ id: 'emp-1', name: 'Java 员工', publishedRevision: 3 }] })
      }
      if (url.includes('/requirement-manifest')) {
        return json(
          { error: { code: 'requirement-manifest-not-found', message: 'none' } },
          overrides.manifestStatus ?? 404,
        )
      }
      if (url.includes('/answers') && method === 'POST') {
        return json({
          missionId: MISSION_ROW.id,
          status: 'working',
          answerRevision: 'a'.repeat(64),
        })
      }
      if (/\/api\/code\/missions\/[^/]+$/.test(url)) {
        return json(overrides.detail ?? MISSION_DETAIL)
      }
      if (url.includes('/api/code/missions') && method === 'POST') {
        return json({ missionId: MISSION_ROW.id, status: 'working', created: true }, 201)
      }
      if (url.includes('/api/code/missions')) {
        return json({ items: overrides.missions ?? [MISSION_ROW] })
      }
      return json({})
    },
  )
  return rec
}

async function renderMissions(initial: string) {
  const listPage = await import('../src/routes/code.missions')
  const detailPage = await import('../src/routes/code.missions.$id')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/missions',
    component: listPage.Route.options.component,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/missions/$missionId',
    component: detailPage.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute, listRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

describe('missionStatusKind', () => {
  test('maps lifecycle states onto the shared chip palette', () => {
    expect(missionStatusKind('merged')).toBe('success')
    expect(missionStatusKind('completed-no-change')).toBe('success')
    expect(missionStatusKind('blocked')).toBe('danger')
    expect(missionStatusKind('failed')).toBe('danger')
    expect(missionStatusKind('awaiting-information')).toBe('warn')
    expect(missionStatusKind('canceled')).toBe('neutral')
    expect(missionStatusKind('working')).toBe('info')
  })
})

describe('/code/missions list', () => {
  test('renders missions with honest block codes and links to detail', async () => {
    installFetch({})
    await renderMissions('/code/missions')
    await screen.findByTestId('mission-list')
    expect(screen.getByText('collector-not-wired:repository')).toBeTruthy()
    expect(screen.getByRole('link', { name: '00000001' })).toBeTruthy()
  })

  test('launch dialog submits a direct-body mission with a pinned employee revision', async () => {
    const rec = installFetch({ missions: [] })
    await renderMissions('/code/missions')
    fireEvent.click(await screen.findByTestId('mission-launch-open'))

    // repository + employee 选择（公共 Select 是按钮+弹层）。
    // 公共 Select 的 option 用 mouseDown（保焦点）而非 click。
    fireEvent.click(await screen.findByTestId('mission-repo-select'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /git\.test/ }))
    fireEvent.click(screen.getByTestId('mission-employee-select'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Java 员工/ }))

    fireEvent.change(screen.getByTestId('mission-title'), { target: { value: 'Add feature' } })
    fireEvent.change(screen.getByTestId('mission-body'), { target: { value: 'do the thing' } })

    const submit = screen.getByTestId('mission-launch-submit')
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false))
    fireEvent.click(submit)

    await waitFor(() => {
      const call = rec.calls.find(
        (c) => c.method === 'POST' && /\/api\/code\/missions$/.test(new URL(c.url).pathname),
      )
      expect(call).toBeTruthy()
      expect(call!.body).toMatchObject({
        repositoryId: 'repo-1',
        submission: { kind: 'direct', title: 'Add feature', body: 'do the thing', uploads: [] },
        requestedEmployee: { id: 'emp-1', revision: 3 },
      })
      expect((call!.body as { idempotencyKey: string }).idempotencyKey).toMatch(/^ui-/)
    })
  })
})

describe('/code/missions/$missionId detail', () => {
  test('renders block section and gates the answers submit on completeness', async () => {
    const rec = installFetch({})
    await renderMissions(`/code/missions/${MISSION_ROW.id}`)

    await screen.findByTestId('mission-block')
    expect(screen.getByText('collector-not-wired:repository')).toBeTruthy()

    // 两题只答一题 ⇒ 提交仍 disabled（提交即冻结，必须齐）。
    const submit = await screen.findByTestId('mission-answers-submit')
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByTestId('mission-answer-q1'), { target: { value: 'billing' } })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByTestId('mission-answer-q2'), { target: { value: 'yes' } })
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false))
    fireEvent.click(submit)

    await waitFor(() => {
      const call = rec.calls.find((c) => c.method === 'POST' && c.url.includes('/answers'))
      expect(call).toBeTruthy()
      expect(call!.body).toMatchObject({
        questionSetRef: 'qs-1',
        answers: [
          { questionId: 'q1', answer: 'billing' },
          { questionId: 'q2', answer: 'yes' },
        ],
      })
    })
  })
})
