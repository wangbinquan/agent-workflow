// RFC-198 PR4 — rendered /tasks/$id URL authority and browser-history regression matrix.
//
// Unlike the pure resolver tests, this suite mounts the real TaskDetailPage under
// a TanStack Router route with the production route id. It locks URL ↔ panel
// synchronization, replace-vs-push history semantics, late workgroup
// classification, room retry, task-id reuse, and stale polling data retention.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Task } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const actorState = vi.hoisted(() => ({
  permissions: ['memory:read'] as string[],
  error: null as Error | null,
  refetch: vi.fn(),
}))

vi.mock('@/hooks/useTaskSync', () => ({ useTaskSync: vi.fn() }))
vi.mock('@/hooks/useActor', () => ({
  useActor: () => ({
    data: actorState.error === null ? { permissions: actorState.permissions } : undefined,
    error: actorState.error,
    isError: actorState.error !== null,
    refetch: actorState.refetch,
  }),
}))
vi.mock('@/components/tasks/RecoverySection', () => ({ RecoverySection: () => null }))
vi.mock('@/components/tasks/StuckTaskBanner', () => ({ StuckTaskBanner: () => null }))
vi.mock('@/components/tasks/WorkflowSyncBanner', () => ({ WorkflowSyncBanner: () => null }))
vi.mock('@/components/tasks/TaskFeedbackList', () => ({
  TaskFeedbackList: () => <div data-testid="feedback-stub" />,
}))
vi.mock('@/components/tasks/TaskQuestionList', () => ({
  TaskQuestionList: () => <div data-testid="questions-stub" />,
}))
vi.mock('@/components/tasks/TaskMembersPanel', () => ({
  TaskMembersDialogButton: () => null,
}))
vi.mock('@/components/TaskSubjectLink', () => ({
  TaskSubjectLink: ({ task }: { task: Task }) => (
    <span data-testid="task-subject-stub">{task.workflowName}</span>
  ),
}))
vi.mock('@/components/canvas/WorkflowCanvas', () => ({
  WorkflowCanvas: ({
    onNodeQuestionBadgeClick,
  }: {
    onNodeQuestionBadgeClick?: (nodeId: string) => void
  }) => (
    <div data-testid="workflow-canvas-stub">
      <button
        type="button"
        data-testid="canvas-question-jump"
        onClick={() => onNodeQuestionBadgeClick?.('node-1')}
      >
        jump to questions
      </button>
    </div>
  ),
}))
vi.mock('@/components/NodeDetailDrawer', () => ({ NodeDetailDrawer: () => null }))
vi.mock('@/components/TaskOutputPanel', () => ({
  collectPorts: () => [],
  TaskOutputPanel: () => <div data-testid="outputs-stub" />,
}))
vi.mock('@/components/WorktreeFilesPanel', () => ({
  WorktreeFilesPanel: () => <div data-testid="worktree-files-stub" />,
}))
vi.mock('@/components/WorktreeDiffPanel', () => ({
  WorktreeDiffPanel: () => <div data-testid="worktree-diff-stub" />,
}))
vi.mock('@/components/structure/StructuralDiffView', () => ({
  StructuralDiffView: () => <div data-testid="structural-diff-stub" />,
}))
vi.mock('@/components/workgroup/WorkgroupRoom', () => ({
  WorkgroupRoom: ({ taskId }: { taskId: string }) => (
    <div data-testid={`workgroup-room-${taskId}`} />
  ),
}))
vi.mock('@/components/workgroup/DynamicWorkflowPanel', () => ({
  DynamicWorkflowPanel: () => <div data-testid="dynamic-workflow-stub" />,
}))

import '../src/i18n'
import { Route as TaskDetailRoute } from '../src/routes/tasks.detail'
import { workgroupRoomKey, type WorkgroupRoomResponse } from '../src/lib/workgroup-room'
import { setBaseUrl, setToken } from '../src/stores/auth'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: `Task ${id}`,
    workflowId: 'workflow_1',
    workflowName: 'Fixture workflow',
    workflowSnapshot: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    workflowVersion: 1,
    repoPath: '/repo',
    repoUrl: null,
    cachedRepoId: null,
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    workingBranch: null,
    autoCommitPush: false,
    baseCommit: null,
    status: 'done',
    inputs: {},
    maxDurationMs: null,
    maxTotalTokens: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    errorSummary: null,
    errorMessage: null,
    failedNodeId: null,
    expiresAt: null,
    deletedAt: null,
    schemaVersion: 1,
    gitUserName: null,
    gitUserEmail: null,
    repoCount: 1,
    repos: [],
    scheduledTaskId: null,
    workgroupId: null,
    workgroupName: null,
    goal: null,
    sourceAgentId: null,
    sourceAgentName: null,
    // Suppress the unrelated terminal-task relaunch Link in this focused harness.
    spaceKind: 'internal',
    ...overrides,
  }
}

function turnRoom(taskId: string): WorkgroupRoomResponse {
  return {
    taskId,
    taskStatus: 'done',
    config: { mode: 'leader_worker' },
    gate: {
      declaredDone: false,
      awaitingConfirmation: false,
      rejected: false,
      summary: null,
    },
    dw: null,
    messages: [],
    assignments: [],
    memberRuns: {},
    runHistory: [],
    // RFC-209 —— 这个 fixture 走 `as unknown as`，缺字段**不会**报类型错、只会静默
    // undefined，所以新增的 wire 字段必须手动补齐（对抗设计门专门点名的漏网点）。
    budgetUsed: 0,
  } as unknown as WorkgroupRoomResponse
}

function dynamicRoom(
  taskId: string,
  phase: 'awaiting_confirm' | 'executing',
): WorkgroupRoomResponse {
  return {
    ...turnRoom(taskId),
    config: { mode: 'dynamic_workflow' },
    dw: { phase },
  } as unknown as WorkgroupRoomResponse
}

function primeTask(qc: QueryClient, row: Task, primeNodeRuns = true): void {
  qc.setQueryData(['tasks', row.id], row)
  if (primeNodeRuns) qc.setQueryData(['tasks', row.id, 'node-runs'], { runs: [], outputs: [] })
  qc.setQueryData(['tasks', row.id, 'diff'], {
    diff: '',
    baseCommit: row.baseCommit,
    truncated: false,
  })
  qc.setQueryData(['task-questions', row.id], [])
  qc.setQueryData(['task-clarify-directives', row.id], {})
  qc.setQueryData(['agents'], [])
}

function installFetch(
  handler: (path: string) => Response | Promise<Response> | undefined,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
    const path = new URL(request.toString()).pathname
    const response = handler(path)
    if (response !== undefined) return response
    throw new Error(`unexpected fetch in task-detail route harness: ${path}`)
  })
}

function renderTaskRoute(
  initialEntry: string,
  rows: Task[],
  options: { room?: WorkgroupRoomResponse; staleTime?: number; primeNodeRuns?: boolean } = {},
) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: options.staleTime ?? Number.POSITIVE_INFINITY },
    },
  })
  for (const row of rows) primeTask(qc, row, options.primeNodeRuns ?? true)
  if (options.room !== undefined) {
    qc.setQueryData(workgroupRoomKey(options.room.taskId), options.room)
  }

  // TaskDetailPage calls hooks on its production Route object. A cloned route
  // with the same `/tasks/$id` id gives those hooks the real Router match while
  // keeping the test root free of AppShell/auth concerns.
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    validateSearch: TaskDetailRoute.options.validateSearch,
    component: TaskDetailRoute.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const view = render(
    <QueryClientProvider client={qc}>
      {/* Test route types intentionally differ from the generated app tree. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { qc, router, view }
}

class DesktopResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe = (target: Element) => {
    this.callback(
      [
        {
          target,
          contentRect: { width: 1024 },
          contentBoxSize: [{ inlineSize: 1024 }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }

  disconnect = () => {}
  unobserve = () => {}
}

function sectionDestination(tab: string): HTMLAnchorElement {
  const link = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('.page-section-nav__leaf'),
  ).find((candidate) => new URL(candidate.href).searchParams.get('tab') === tab)
  if (link === undefined) throw new Error(`missing Task destination for ${tab}`)
  return link
}

function expectActivePanel(tab: string): void {
  const activeLink = sectionDestination(tab)
  const activePanel = document.getElementById(`task-detail-section-${tab}`)
  expect(activeLink.getAttribute('aria-current')).toBe('page')
  expect(activePanel?.hidden).toBe(false)
  expect(activePanel?.getAttribute('data-task-detail-section')).toBe(tab)
  expect(document.querySelectorAll('.task-detail__pane:not([hidden])')).toHaveLength(1)
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', DesktopResizeObserver)
  actorState.permissions = ['memory:read']
  actorState.error = null
  actorState.refetch.mockReset()
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('/tasks/$id rendered URL-backed panels', () => {
  test('no-worktree task filters artifact leaves and replaces an old diff deep link', async () => {
    installFetch(() => undefined)
    const { router } = renderTaskRoute('/tasks/no-worktree?tab=worktree-diff&focus=keep', [
      task('no-worktree'),
    ])

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'workflow-status', focus: 'keep' })
      expectActivePanel('workflow-status')
    })
    expect(document.getElementById('task-detail-section-worktree-diff')).toBeNull()
    expect(document.getElementById('task-detail-section-worktree-structure')).toBeNull()
    expect(document.getElementById('task-detail-section-worktree-files')).toBeNull()
  })

  test('multi-repo diff stays deep-linkable when aggregate baseCommit is null', async () => {
    installFetch(() => undefined)
    const multi = task('multi', {
      repoCount: 2,
      worktreePath: '/worktree/multi',
      baseCommit: null,
      repos: [
        {
          repoIndex: 0,
          repoPath: '/repo/a',
          repoUrl: null,
          cachedRepoId: null,
          baseBranch: 'main',
          branch: 'task/a',
          workingBranch: null,
          baseCommit: null,
          worktreePath: '/worktree/multi/a',
          worktreeDirName: 'a',
          hasSubmodules: null,
          submoduleInitOk: null,
          submoduleInitError: null,
        },
        {
          repoIndex: 1,
          repoPath: '/repo/b',
          repoUrl: null,
          cachedRepoId: null,
          baseBranch: 'main',
          branch: 'task/b',
          workingBranch: null,
          baseCommit: 'repo-b-base',
          worktreePath: '/worktree/multi/b',
          worktreeDirName: 'b',
          hasSubmodules: null,
          submoduleInitOk: null,
          submoduleInitError: null,
        },
      ],
    })
    const { router } = renderTaskRoute('/tasks/multi?tab=worktree-diff&focus=keep', [multi])

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'worktree-diff', focus: 'keep' })
      expectActivePanel('worktree-diff')
    })
    expect(screen.getByTestId('worktree-diff-stub')).toBeTruthy()
  })

  test('feedback leaf follows memory:read and unavailable deep links canonicalize', async () => {
    actorState.permissions = []
    installFetch(() => undefined)
    const { router } = renderTaskRoute('/tasks/plain?tab=feedback&focus=keep', [task('plain')])

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'workflow-status', focus: 'keep' })
      expectActivePanel('workflow-status')
    })
    expect(document.getElementById('task-detail-section-feedback')).toBeNull()
  })

  test('permission lookup failure preserves a feedback deep link and exposes retry', async () => {
    actorState.error = new Error('permission lookup unavailable')
    installFetch(() => undefined)
    const { router } = renderTaskRoute('/tasks/plain?tab=feedback&focus=keep', [task('plain')])

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('permission lookup unavailable')
    expect(router.state.location.search).toEqual({ tab: 'feedback', focus: 'keep' })
    expect(screen.queryByRole('navigation', { name: /任务分区|Task sections/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/ }))
    expect(actorState.refetch).toHaveBeenCalledTimes(1)
  })

  test('pending questions are discoverable on both collaboration group and active leaf', async () => {
    installFetch(() => undefined)
    const { qc } = renderTaskRoute('/tasks/plain?tab=task-questions', [task('plain')])
    act(() => {
      qc.setQueryData(
        ['task-questions', 'plain'],
        [
          { id: 'q1', phase: 'pending' },
          { id: 'q2', phase: 'staged' },
          { id: 'q3', phase: 'done' },
        ],
      )
    })

    await waitFor(() => expectActivePanel('task-questions'))
    expect(screen.getByTestId('tq-group-badge').textContent).toBe('2')
    expect(screen.getByTestId('tq-section-badge').textContent).toBe('2')
  })

  test('invalid panel canonicalizes with replace, adjacent search survives, and click push supports Back/Forward', async () => {
    installFetch(() => undefined)
    const { router } = renderTaskRoute('/tasks/plain?tab=overview&focus=node-1&trace=2', [
      task('plain'),
    ])

    await waitFor(() => {
      expect(router.state.location.search).toEqual({
        focus: 'node-1',
        trace: 2,
        tab: 'workflow-status',
      })
      expectActivePanel('workflow-status')
    })
    fireEvent.click(sectionDestination('details'))
    await waitFor(() => {
      expect(router.state.location.search).toEqual({
        focus: 'node-1',
        trace: 2,
        tab: 'details',
      })
      expectActivePanel('details')
    })
    router.history.back()
    await waitFor(() => {
      expect(router.state.location.search.tab).toBe('workflow-status')
      expectActivePanel('workflow-status')
    })

    router.history.forward()
    await waitFor(() => {
      expect(router.state.location.search.tab).toBe('details')
      expectActivePanel('details')
    })
  })

  test('turn-engine classification waits for late room config before replacing an unavailable panel', async () => {
    const room = deferred<Response>()
    const fetchSpy = installFetch((path) =>
      path === '/api/workgroup-tasks/crew/room' ? room.promise : undefined,
    )
    const crew = task('crew', { workgroupId: 'wg_crew', workgroupName: 'Crew' })
    const { router } = renderTaskRoute('/tasks/crew?tab=workflow-status&focus=node-2', [crew])

    await screen.findByTestId('loading-state')
    expect(router.state.location.search).toEqual({ tab: 'workflow-status', focus: 'node-2' })
    expect(screen.queryByRole('navigation', { name: /任务分区|Task sections/ })).toBeNull()

    await act(async () => {
      room.resolve(json(turnRoom('crew')))
      await room.promise
    })
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'chatroom', focus: 'node-2' })
      expectActivePanel('chatroom')
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // 2026-07-20 — user report: 「工作组的执行界面的产物里也要增加工作目录和工作目录 diff 的能力，
  // 因为 agent 会写文件，现在没地方下载文件」. WORKGROUP_TAB_ORDER shipped (91cab517) without the
  // two browse/diff leaves, so a turn-engine group's 产物 group held only the structural overlay
  // and the files its members merged back into the canonical worktree had no download surface.
  // This renders the REAL route to prove both panes mount and are reachable from the nav — the
  // pure-function locks in task-detail-tabs.test.ts alone would not catch a missing pane.
  test('a turn-engine group reaches the worktree browse and diff panes it used to lack', async () => {
    installFetch(() => undefined)
    const crew = task('crew', {
      workgroupId: 'wg_crew',
      workgroupName: 'Crew',
      worktreePath: '/worktree/crew',
      baseCommit: 'abc123',
    })
    const { router } = renderTaskRoute('/tasks/crew?tab=worktree-files', [crew], {
      room: turnRoom('crew'),
    })

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'worktree-files' })
      expectActivePanel('worktree-files')
    })
    expect(screen.getByTestId('worktree-files-stub')).toBeTruthy()

    fireEvent.click(sectionDestination('worktree-diff'))
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'worktree-diff' })
      expectActivePanel('worktree-diff')
    })
    expect(screen.getByTestId('worktree-diff-stub')).toBeTruthy()
    // The chat room stays the group's default view — this widens the artifacts
    // group, it does not demote the room.
    expect(document.getElementById('task-detail-section-chatroom')).not.toBeNull()
  })

  test('dynamic-workflow canonical default remains stable when its room phase advances', async () => {
    installFetch(() => undefined)
    const dynamic = task('dynamic', {
      workgroupId: 'wg_dynamic',
      workgroupName: 'Dynamic crew',
    })
    const { qc, router } = renderTaskRoute('/tasks/dynamic?focus=node-dw', [dynamic], {
      room: dynamicRoom('dynamic', 'awaiting_confirm'),
    })

    await waitFor(() => {
      expect(router.state.location.search).toEqual({
        tab: 'dw-orchestration',
        focus: 'node-dw',
      })
      expectActivePanel('dw-orchestration')
    })

    act(() => {
      qc.setQueryData(workgroupRoomKey('dynamic'), dynamicRoom('dynamic', 'executing'))
    })
    await waitFor(() => {
      expect(router.state.location.search.tab).toBe('dw-orchestration')
      expectActivePanel('dw-orchestration')
    })
  })

  test('room error keeps the raw URL, Details is a push target, and retry resolves without losing adjacent search', async () => {
    let roomAttempt = 0
    const fetchSpy = installFetch((path) => {
      if (path !== '/api/workgroup-tasks/crew/room') return undefined
      roomAttempt += 1
      return roomAttempt === 1
        ? json({ code: 'room-unavailable', message: 'room unavailable' }, 503)
        : json(turnRoom('crew'))
    })
    const crew = task('crew', { workgroupId: 'wg_crew', workgroupName: 'Crew' })
    const { router } = renderTaskRoute('/tasks/crew?tab=chatroom&focus=node-3', [crew])

    await screen.findByRole('alert')
    expect(router.state.location.search).toEqual({ tab: 'chatroom', focus: 'node-3' })
    expect(document.querySelector('.task-detail__pane:not([hidden])')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /详细信息|Details/ }))
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'details', focus: 'node-3' })
      expectActivePanel('details')
    })

    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/ }))
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(router.state.location.search).toEqual({ tab: 'details', focus: 'node-3' })
      expectActivePanel('details')
    })
  })

  test('switching task ids re-resolves the panel shape instead of leaving the previous task panel visible', async () => {
    installFetch(() => undefined)
    const plain = task('plain', { worktreePath: '/worktree/plain', baseCommit: 'abc123' })
    const crew = task('crew', { workgroupId: 'wg_crew', workgroupName: 'Crew' })
    const { router } = renderTaskRoute('/tasks/plain?tab=worktree-diff&focus=keep', [plain, crew], {
      room: turnRoom('crew'),
    })

    await waitFor(() => expectActivePanel('worktree-diff'))
    await router.navigate({
      to: '/tasks/$id',
      params: { id: 'crew' },
      search: (previous) => previous,
    })

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Task crew/ })).toBeTruthy()
      expect(router.state.location.search).toEqual({ tab: 'chatroom', focus: 'keep' })
      expectActivePanel('chatroom')
    })
    expect(document.getElementById('task-detail-section-worktree-diff')).toBeNull()
  })

  test('a programmatic canvas jump pushes the questions panel and preserves adjacent search', async () => {
    installFetch(() => undefined)
    const { router } = renderTaskRoute('/tasks/plain?tab=workflow-status&focus=node-4', [
      task('plain'),
    ])
    await waitFor(() => expectActivePanel('workflow-status'))

    fireEvent.click(screen.getByTestId('canvas-question-jump'))
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'task-questions', focus: 'node-4' })
      expectActivePanel('task-questions')
    })

    router.history.back()
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'workflow-status', focus: 'node-4' })
      expectActivePanel('workflow-status')
    })
  })

  test('a failed task refetch keeps cached detail visible and offers an inline retry', async () => {
    const stale = task('stale')
    let taskFetches = 0
    installFetch((path) => {
      if (path !== '/api/tasks/stale') return undefined
      taskFetches += 1
      return json({ code: 'poll-failed', message: 'poll failed' }, 503)
    })
    const { qc } = renderTaskRoute('/tasks/stale?tab=details', [stale])
    await screen.findByRole('heading', { name: /Task stale/ })

    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['tasks', 'stale'], exact: true })
    })
    await screen.findByRole('alert')
    expect(screen.getByRole('heading', { name: /Task stale/ })).toBeTruthy()
    expectActivePanel('details')
    expect(taskFetches).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/ }))
    await waitFor(() => expect(taskFetches).toBe(2))
    expect(screen.getByRole('heading', { name: /Task stale/ })).toBeTruthy()
  })

  test('workflow-status exposes node-runs initial failure and retry beside the live canvas', async () => {
    let attempts = 0
    installFetch((path) => {
      if (path !== '/api/tasks/node-state/node-runs') return undefined
      attempts += 1
      return attempts === 1
        ? json({ code: 'node-runs-unavailable', message: 'node runs unavailable' }, 503)
        : json({ runs: [], outputs: [] })
    })
    renderTaskRoute('/tasks/node-state?tab=workflow-status', [task('node-state')], {
      primeNodeRuns: false,
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('node runs unavailable')
    expect(screen.getByTestId('workflow-canvas-stub')).toBeTruthy()
    expectActivePanel('workflow-status')

    fireEvent.click(screen.getByRole('button', { name: /重试|Retry/ }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(attempts).toBe(2)
    expect(screen.getByTestId('workflow-canvas-stub')).toBeTruthy()
  })
})
