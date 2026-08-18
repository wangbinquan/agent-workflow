// RFC-310 PR-8 T91/T92 —— mission 详情页的看护 UX。
//
// 锁四件事：①handoff/attach/resume 三控件的可见性由 automationMode × 权限共同
// 决定（无权隐藏而非禁用——RFC-305 纪律），点击发出正确端点请求；②attach 走
// Dialog，auto 端点时不携带 codeHostEndpointRef（后端按仓库绑定推导是合同，
// 表单不硬造）；③timeline 把 decision trace 与 effects 合并示人，block 决策
// 的 reason 原样可见、trace 可展开（可回放性是产品语义）；④evidence browser
// 按 detail.pipeline 投影渲染 gates/files，ranged 预览尊重截断头并按
// next-offset 续读追加——半份日志绝不冒充完整；投影缺席时诚实降级。

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

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const MISSION_ID = '01MISSIONDETAILUX00000001'

const BASE_PERMISSIONS = [
  'development-missions:read',
  'development-missions:interact',
  'development-missions:cancel',
  'development-missions:retry',
]

const ALL_PERMISSIONS = [
  ...BASE_PERMISSIONS,
  'development-missions:handoff',
  'development-missions:attach',
  'development-missions:resume',
]

function meOf(permissions: string[]) {
  return {
    user: { id: 'u-1', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
    source: 'session',
    linkedIdentities: [],
    pats: [],
    permissions,
  }
}

const PIPELINE = {
  bundleId: 'bundle-1',
  headSha: 'ab'.repeat(20),
  completeness: 'complete',
  collectedAt: '1700000100000',
  gates: [
    {
      gateKey: 'unit',
      required: true,
      status: 'fail',
      runRef: 'run-9',
      attempt: 1,
      failureCategories: ['unit-test'],
    },
  ],
  files: [
    {
      fileId: 'log-unit',
      relativePath: 'logs/unit/console.log',
      mediaType: 'text/plain',
      bytes: 40,
      sha256: 'f'.repeat(64),
    },
  ],
}

const TRACE_ITEMS = [
  {
    id: 'dec-2',
    missionRevision: 4,
    policyId: 'pol-1',
    policyRevision: 1,
    employeeId: null,
    employeeRevision: null,
    factDigest: 'd'.repeat(64),
    guardTrace: [{ guard: 'terminal', outcome: 'pass' }],
    ruleTrace: [],
    selected: { kind: 'block', reason: 'no-rule-matched' },
    canonicalDigest: 'c'.repeat(64),
    decidedAt: 1700000200000,
  },
]

function detailOf(overrides: Record<string, unknown> = {}) {
  return {
    id: MISSION_ID,
    status: 'watching',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: 'repo-1',
    sourceKind: 'direct',
    externalId: null,
    resolvedSourceKey: null,
    deliveryKind: 'create-merge-request',
    employeeId: 'emp-1',
    employeeRevision: 1,
    policyId: 'pol-1',
    policyRevision: 1,
    blockCode: null,
    blockDetail: null,
    terminalKind: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    sources: [],
    readiness: null,
    questions: null,
    action: {
      lastOutcome: 'changed',
      lastCapability: 'change.implement',
      candidateRef: null,
      clarificationState: null,
    },
    effects: [
      {
        id: 'eff-1',
        effectKind: 'candidate-push',
        state: 'confirmed',
        intentDigest: 'i'.repeat(64),
        createdAt: 1700000150000,
        settledAt: 1700000151000,
      },
    ],
    pipeline: PIPELINE,
    ...overrides,
  }
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(overrides: {
  detail?: unknown
  permissions?: string[]
  publishedRevision?: number | null
  evidenceChunks?: Array<{ text: string; total: number; truncated: boolean; next: number | null }>
}): Recorded {
  const rec: Recorded = { calls: [] }
  const chunks = [...(overrides.evidenceChunks ?? [])]
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
      if (url.includes('/api/auth/me')) {
        return json(meOf(overrides.permissions ?? ALL_PERMISSIONS))
      }
      if (url.includes('/pipeline-evidence/')) {
        const chunk = chunks.shift() ?? { text: '', total: 0, truncated: false, next: null }
        return new Response(chunk.text, {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'x-evidence-total-bytes': String(chunk.total),
            'x-evidence-truncated': String(chunk.truncated),
            ...(chunk.next === null ? {} : { 'x-evidence-next-offset': String(chunk.next) }),
          },
        })
      }
      if (url.includes('/decision-trace')) return json({ items: TRACE_ITEMS })
      if (url.includes('/requirement-manifest')) {
        return json({ code: 'requirement-manifest-not-found', message: 'none' }, 404)
      }
      if (url.includes('/api/code/automation-policies/')) {
        return json({
          id: 'pol-1',
          name: 'policy',
          publishedRevision: overrides.publishedRevision ?? 1,
        })
      }
      if (url.includes('/handoff') || url.includes('/resume') || url.includes('/attach-mr')) {
        return json({ missionId: MISSION_ID, status: 'watching' })
      }
      if (/\/api\/code\/missions\/[^/]+$/.test(url)) {
        return json(overrides.detail ?? detailOf())
      }
      return json({})
    },
  )
  return rec
}

async function renderDetail() {
  const detailPage = await import('../src/routes/code.missions.$id')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/missions/$missionId',
    component: detailPage.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute]),
    history: createMemoryHistory({ initialEntries: [`/code/missions/${MISSION_ID}`] }),
  })
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('RFC-310 PR-8 mission detail care UX', () => {
  test('handoff visible on active missions and posts to the handoff endpoint', async () => {
    const rec = installFetch({})
    await renderDetail()
    const handoffBtn = await screen.findByTestId('mission-handoff')
    expect(screen.queryByTestId('mission-resume')).toBeNull()
    expect(screen.queryByTestId('mission-attach-open')).toBeNull()
    fireEvent.click(handoffBtn)
    await waitFor(() => {
      expect(
        rec.calls.some(
          (c) => c.method === 'POST' && c.url.includes(`/missions/${MISSION_ID}/handoff`),
        ),
      ).toBe(true)
    })
  })

  test('tracking-only missions show resume + attach; attach dialog posts mrIid without forced endpoint', async () => {
    const rec = installFetch({ detail: detailOf({ automationMode: 'tracking-only' }) })
    await renderDetail()
    const resumeBtn = await screen.findByTestId('mission-resume')
    expect(screen.queryByTestId('mission-handoff')).toBeNull()
    fireEvent.click(resumeBtn)
    await waitFor(() => {
      expect(
        rec.calls.some(
          (c) => c.method === 'POST' && c.url.includes(`/missions/${MISSION_ID}/resume`),
        ),
      ).toBe(true)
    })

    fireEvent.click(screen.getByTestId('mission-attach-open'))
    const iid = await screen.findByTestId('mission-attach-iid')
    fireEvent.change(iid, { target: { value: '42' } })
    fireEvent.click(screen.getByTestId('mission-attach-submit'))
    await waitFor(() => {
      const call = rec.calls.find(
        (c) => c.method === 'POST' && c.url.includes(`/missions/${MISSION_ID}/attach-mr`),
      )
      expect(call).toBeDefined()
      expect(call!.body).toEqual({ mrIid: '42' })
    })
  })

  test('without the new permission points every care control is hidden', async () => {
    installFetch({
      permissions: BASE_PERMISSIONS,
      detail: detailOf({ automationMode: 'tracking-only' }),
    })
    await renderDetail()
    await screen.findByTestId('mission-timeline')
    expect(screen.queryByTestId('mission-handoff')).toBeNull()
    expect(screen.queryByTestId('mission-resume')).toBeNull()
    expect(screen.queryByTestId('mission-attach-open')).toBeNull()
  })

  test('timeline merges decisions and effects; block reason visible and trace expandable', async () => {
    installFetch({})
    await renderDetail()
    const timeline = await screen.findByTestId('mission-timeline')
    expect(timeline.textContent).toContain('block: no-rule-matched')
    expect(timeline.textContent).toContain('candidate-push · confirmed')
    fireEvent.click(screen.getByTestId('timeline-expand-dec-2'))
    const trace = await screen.findByTestId('timeline-trace')
    expect(trace.textContent).toContain('guardTrace')
    expect(trace.textContent).toContain('no-rule-matched')
  })

  test('config upgrade badge appears only when a newer policy revision is published', async () => {
    installFetch({ publishedRevision: 3 })
    await renderDetail()
    const badge = await screen.findByTestId('mission-config-upgrade')
    expect(badge.textContent).toContain('r1')
    expect(badge.textContent).toContain('r3')
  })

  test('evidence browser renders gates/files, ranged preview appends by next-offset and never fakes completeness', async () => {
    const rec = installFetch({
      evidenceChunks: [
        { text: 'FIRST-', total: 11, truncated: true, next: 6 },
        { text: 'SECOND', total: 11, truncated: false, next: null },
      ],
    })
    await renderDetail()
    const gates = await screen.findByTestId('evidence-gates')
    expect(gates.textContent).toContain('unit')
    expect(gates.textContent).toContain('unit-test')

    fireEvent.click(screen.getByTestId('evidence-view-log-unit'))
    const preview = await screen.findByTestId('evidence-preview')
    await waitFor(() => expect(preview.textContent).toContain('FIRST-'))
    // 不可信警示常驻。
    expect(preview.textContent).toContain('untrusted')
    const first = rec.calls.find((c) => c.url.includes('/pipeline-evidence/'))
    expect(first!.url).toContain('offset=0')

    const more = screen.getByTestId('evidence-load-more')
    fireEvent.click(more)
    await waitFor(() => expect(preview.textContent).toContain('FIRST-SECOND'))
    const second = rec.calls.filter((c) => c.url.includes('/pipeline-evidence/'))[1]
    expect(second!.url).toContain('offset=6')
    await waitFor(() => expect(screen.queryByTestId('evidence-load-more')).toBeNull())
  })

  test('missing pipeline projection degrades honestly', async () => {
    installFetch({ detail: detailOf({ pipeline: null }) })
    await renderDetail()
    await screen.findByTestId('evidence-not-collected')
    expect(screen.queryByTestId('evidence-browser')).toBeNull()
  })
})
