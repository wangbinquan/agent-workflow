// RFC-310 PR-5 T61 — Mission 列表/详情页。
//
// 锁的是页面对使用者的回答，而不是标记存在性：①列表把 mission 状态与阻塞码
// 如实示人（「开单 ≠ 在跑」的诚实边界是产品语义）；②全页向导逐步解释并用
// server-authoritative preflight 选出员工/策略后，提交**正确的 API 载荷**
// （idempotencyKey 固定、direct 正文、员工 pin 已发布 revision）；③详情页在 awaiting-information 时渲染问题并提交完整答案集
// （提交即冻结——不许漏答，按钮 gating 锁住）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { StrictMode } from 'react'
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
import { missionGuidance } from '../src/routes/code.missions.$id'

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
  readiness: {
    evaluatedForHead: 'a'.repeat(40),
    factDigest: 'b'.repeat(64),
    automationReady: false,
    hostMergeable: 'unknown',
    machineHolds: [{ kind: 'facts-incomplete', detail: 'pipeline evidence partial' }],
    humanHolds: [],
    status: 'working',
  },
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
  mergeRequest: null,
  journey: {
    schemaVersion: 1,
    journey: 'mission-delivery',
    current: { key: 'implement', ordinal: 2, total: 5, detailKey: 'missionImplementDetail' },
    next: {
      key: 'retryMission',
      kind: 'command',
      detailKey: 'retryMissionDetail',
      owner: 'current-user',
      href: `/code/missions/${MISSION_ROW.id}`,
      command: 'retry',
      available: true,
      unavailableReason: null,
      wake: { source: null, resumeAt: null, deadlineAt: null, descriptionKey: null },
    },
    steps: [
      { key: 'intake', state: 'done', owner: 'platform', href: null },
      { key: 'implement', state: 'blocked', owner: 'platform', href: null },
      { key: 'publish', state: 'pending', owner: 'platform', href: null },
      { key: 'review', state: 'pending', owner: 'platform', href: null },
      { key: 'merged', state: 'pending', owner: 'committer', href: null },
    ],
    reasonRefs: ['collector-not-wired:repository'],
    projectionRevision: 'mission-test-blocked',
  },
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
      if (url.includes('/api/code/automation-policies')) {
        return json({ items: [{ id: 'pol-1', name: '默认研发策略', publishedRevision: 2 }] })
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
      if (url.endsWith('/api/code/missions/preview') && method === 'POST') {
        return json({
          outcome: 'ready',
          employee: { id: 'emp-1', revision: 3 },
          policy: { id: 'pol-1', revision: 2 },
          requirementSource: null,
          sourceOptions: [],
          block: null,
        })
      }
      if (url.endsWith('/api/code/mission-input-uploads') && method === 'POST') {
        return json({ uploadRef: 'upload-1', bytes: 9, sha256: 'f'.repeat(64) }, 201)
      }
      if (url.endsWith('/api/code/missions/direct-input/preview') && method === 'POST') {
        return json({
          employee: { id: 'emp-1', revision: 3 },
          policy: { id: 'pol-1', revision: 2 },
          baseline: { snapshotRef: 'git:abc', sha: 'a'.repeat(40) },
          dispositions: [
            {
              repositoryTargetPath: 'docs/input.md',
              disposition: 'create',
              effectiveCollisionMode: 'create-only',
              effectiveContentPolicy: 'preserve-upload',
              blockedReason: null,
            },
          ],
        })
      }
      if (url.includes('/api/code/mission-input-uploads/') && method === 'DELETE') {
        return json({ ok: true })
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

async function renderMissions(initial: string, options: { strict?: boolean } = {}) {
  const listPage = await import('../src/routes/code.missions')
  const newPage = await import('../src/routes/code.missions.new')
  const detailPage = await import('../src/routes/code.missions.$id')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/missions',
    beforeLoad: listPage.redirectMissionListToTasks,
  })
  const tasksRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks',
    component: () => <div data-testid="unified-task-list" />,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/missions/$missionId',
    component: detailPage.Route.options.component,
  })
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/missions/new',
    component: newPage.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([newRoute, detailRoute, listRoute, tasksRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  const tree = (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>
  )
  // `strict` 复现真实入口 `main.tsx` 的 <StrictMode>：effect 会 setup → cleanup →
  // setup，且**同一个组件实例**（ref 不重建）。用 mount/unmount 两次是复现不了的，
  // 那会拿到全新的 ref。
  render(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree)
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

  test('guidance leads with the user-visible next step, not an internal status code', () => {
    expect(
      missionGuidance({
        status: 'awaiting-information',
        automationMode: 'active',
        questions: null,
      }),
    ).toMatchObject({ tone: 'warning', title: 'answersTitle' })
    expect(
      missionGuidance({ status: 'ready-to-merge', automationMode: 'active', questions: null }),
    ).toMatchObject({ tone: 'success', title: 'readyTitle' })
    expect(
      missionGuidance({ status: 'watching', automationMode: 'active', questions: null }),
    ).toMatchObject({ tone: 'info', title: 'watchingTitle' })
  })
})

describe('/code/missions list', () => {
  test('redirects the retired second inbox to the unified digital-employee task list', async () => {
    installFetch({})
    const router = await renderMissions('/code/missions')
    await screen.findByTestId('unified-task-list')
    expect(router.state.location.pathname).toBe('/tasks')
    expect(router.state.location.search).toEqual({ type: 'digital-employee' })
  })

  test('guided launch preflights and submits a direct-body mission with a pinned employee revision', async () => {
    const rec = installFetch({ missions: [] })
    await renderMissions('/code/missions/new')
    await screen.findByTestId('mission-launch-wizard')
    // Step 1: repository + delivery (new MR is the explicit default).
    fireEvent.click(await screen.findByTestId('mission-repo-select'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /git\.test/ }))
    fireEvent.click(screen.getByTestId('stepper-next'))

    // Step 2: one direct input supports body and files together; this case is body-only.
    fireEvent.change(screen.getByTestId('mission-title'), { target: { value: 'Add feature' } })
    fireEvent.change(screen.getByTestId('mission-body'), { target: { value: 'do the thing' } })
    fireEvent.click(screen.getByTestId('stepper-next'))

    // Step 3: choose an exact published employee revision instead of assignment resolution.
    fireEvent.click(screen.getByTestId('mission-employee-choice-explicit'))
    fireEvent.click(await screen.findByTestId('mission-employee-select'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Java 员工/ }))
    fireEvent.click(screen.getByTestId('stepper-next'))

    // Step 4: launch is fenced until the server resolves employee/policy via
    // the exact admission selector used by the durable launch command.
    const submit = screen.getByTestId('mission-launch-submit')
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByTestId('mission-preflight'))
    await screen.findByTestId('mission-preflight-ready')

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

  test('one direct journey accepts body plus files and freezes every repository placement field', async () => {
    const rec = installFetch({ missions: [] })
    await renderMissions('/code/missions/new')
    await screen.findByTestId('mission-launch-wizard')

    fireEvent.click(screen.getByTestId('mission-repo-select'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /git\.test/ }))
    fireEvent.click(screen.getByTestId('stepper-next'))

    fireEvent.change(screen.getByTestId('mission-title'), { target: { value: 'Ship guide' } })
    fireEvent.change(screen.getByTestId('mission-body'), {
      target: { value: 'Commit the attached guide and keep its exact bytes.' },
    })
    const file = new File(['guide v1'], 'guide.md', { type: 'text/markdown', lastModified: 7 })
    fireEvent.change(screen.getByTestId('mission-upload-files'), { target: { files: [file] } })
    fireEvent.change(await screen.findByTestId('mission-upload-target-0'), {
      target: { value: 'docs/input.md' },
    })
    fireEvent.click(screen.getByTestId('stepper-next'))

    // Assignment resolution remains a first-class path; no explicit employee
    // is sent, but preflight still reports the exact resolved revision.
    fireEvent.click(screen.getByTestId('stepper-next'))
    fireEvent.click(screen.getByTestId('mission-preflight'))
    await screen.findByTestId('mission-upload-preview')
    fireEvent.click(screen.getByTestId('mission-launch-submit'))

    await waitFor(() => {
      const call = rec.calls.find(
        (candidate) =>
          candidate.method === 'POST' &&
          /\/api\/code\/missions$/.test(new URL(candidate.url).pathname),
      )
      expect(call).toBeTruthy()
      expect(call!.body).toMatchObject({
        repositoryId: 'repo-1',
        requestedEmployee: null,
        submission: {
          kind: 'direct',
          title: 'Ship guide',
          body: 'Commit the attached guide and keep its exact bytes.',
          uploads: [
            {
              uploadRef: 'upload-1',
              repositoryTargetPath: 'docs/input.md',
              collisionMode: 'create-only',
              contentPolicy: 'preserve-upload',
              fileMode: 'regular',
            },
          ],
        },
      })
    })
  })

  // 回归锁：`disposedRef` 的 cleanup 只置 true、从不在挂载时复位，于是**任何一次
  // 重挂载**（StrictMode 双调用、路由重建）之后，上传永远在暂存完成后被判为
  // "页面已关闭"、文件被删、preflight 报 mission launch page closed while uploads
  // were staging——而页面明明还开着。RFC-310 T140 的浏览器旅程实跑抓到这条；这里
  // 用「渲染→卸载→再渲染」在单测里复现同一条时序。
  test('a StrictMode double-mounted launch page still stages uploads instead of declaring itself closed', async () => {
    const rec = installFetch({ missions: [] })
    await renderMissions('/code/missions/new', { strict: true })
    await screen.findByTestId('mission-launch-wizard')

    fireEvent.click(screen.getByTestId('mission-repo-select'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: /git\.test/ }))
    fireEvent.click(screen.getByTestId('stepper-next'))
    fireEvent.change(screen.getByTestId('mission-title'), { target: { value: 'Ship guide' } })
    fireEvent.change(screen.getByTestId('mission-body'), {
      target: { value: 'Commit the attached guide and keep its exact bytes.' },
    })
    const file = new File(['guide v1'], 'guide.md', { type: 'text/markdown', lastModified: 7 })
    fireEvent.change(screen.getByTestId('mission-upload-files'), { target: { files: [file] } })
    fireEvent.change(await screen.findByTestId('mission-upload-target-0'), {
      target: { value: 'docs/input.md' },
    })
    fireEvent.click(screen.getByTestId('stepper-next'))
    fireEvent.click(screen.getByTestId('stepper-next'))
    fireEvent.click(screen.getByTestId('mission-preflight'))

    // 预检走完 = 上传被采纳；同时确认没有把刚暂存的文件又删掉。
    await screen.findByTestId('mission-upload-preview')
    expect(
      rec.calls.some(
        (candidate) =>
          candidate.method === 'DELETE' &&
          /\/api\/code\/mission-input-uploads/.test(new URL(candidate.url).pathname),
      ),
    ).toBe(false)
  })
})

describe('/code/missions/$missionId detail', () => {
  test('renders block section and gates the answers submit on completeness', async () => {
    const rec = installFetch({})
    await renderMissions(`/code/missions/${MISSION_ROW.id}`)

    await screen.findByTestId('mission-block')
    expect(screen.getByText('collector-not-wired:repository')).toBeTruthy()
    expect(screen.getByTestId('mission-guidance')).toBeTruthy()
    expect(screen.getByTestId('mission-readiness')).toBeTruthy()
    expect(screen.getByText(/External facts are incomplete/)).toBeTruthy()

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
