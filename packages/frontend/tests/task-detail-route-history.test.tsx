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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { NodeRun, Task } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const actorState = vi.hoisted(() => ({
  permissions: ['memory:read'] as string[],
  error: null as Error | null,
  fetchStatus: 'idle' as 'idle' | 'fetching',
  requestAllowed: true,
  refetch: vi.fn(),
}))

vi.mock('@/hooks/useTaskSync', () => ({ useTaskSync: vi.fn() }))
vi.mock('@/hooks/useActor', () => ({
  useActor: () => ({
    data: actorState.error === null ? { permissions: actorState.permissions } : undefined,
    error: actorState.error,
    status: actorState.error === null ? 'success' : 'error',
    fetchStatus: actorState.fetchStatus,
    isError: actorState.error !== null,
    isLoading: false,
    refetch: actorState.refetch,
  }),
  // RFC-222 — tasks.detail now gates its delete button on usePermission.
  usePermission: (perm: string) =>
    actorState.error === null &&
    actorState.fetchStatus === 'idle' &&
    actorState.permissions.includes(perm),
  // 2026-08-25 —— 呈现面读的「末次已解析」快照：与真实实现同形，只看解析成没成功，
  // 不看 fetchStatus（后台续期期间 react-query 保留上一份 data，权限集照旧）。
  useLastResolvedPermissions: () => ({
    resolved: actorState.error === null,
    permissions: new Set(actorState.error === null ? actorState.permissions : []),
  }),
  hasPermissionAtRequest: (_client: unknown, perm: string) =>
    actorState.requestAllowed && actorState.permissions.includes(perm),
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
    onSelect,
    callNavs,
  }: {
    onNodeQuestionBadgeClick?: (nodeId: string) => void
    onSelect?: (selection: { kind: 'node'; id: string }) => void
    callNavs?: Record<string, 'child'>
  }) => (
    <div data-testid="workflow-canvas-stub">
      <button
        type="button"
        data-testid="canvas-question-jump"
        onClick={() => onNodeQuestionBadgeClick?.('node-1')}
      >
        jump to questions
      </button>
      <button
        type="button"
        data-testid="canvas-call-jump"
        data-call-nav={callNavs?.call1}
        onClick={() => onSelect?.({ kind: 'node', id: 'call1' })}
      >
        jump to child
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
vi.mock('@/components/changes/ChangeReviewPanel', () => ({
  ChangeReviewPanel: () => <div data-testid="change-review-stub" />,
}))
vi.mock('@/components/structure/StructuralDiffView', () => ({
  StructuralDiffView: () => <div data-testid="structural-diff-stub" />,
}))
vi.mock('@/components/workgroup/room/WorkgroupRoom', () => ({
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
    repoGroupId: null,
    repoGroupName: null,
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
  qc.setQueryData(['tasks', 'children', row.id], [])
  qc.setQueryData(['agents'], [])
}

function nodeRun(overrides: Partial<NodeRun> = {}): NodeRun {
  return {
    id: 'run_1',
    taskId: 'parent',
    nodeId: 'call1',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    wgRound: null,
    rerunCause: null,
    reviewIteration: 0,
    status: 'done',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    pid: null,
    exitCode: 0,
    errorMessage: null,
    supersededByReview: null,
    rolledBack: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    opencodeSessionId: null,
    ...overrides,
  } satisfies NodeRun
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
    remountDeps: TaskDetailRoute.options.remountDeps,
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
  actorState.fetchStatus = 'idle'
  actorState.requestAllowed = true
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
  // 2026-08-25 用户实测：看着某个任务的结构图，一有新任务 / event 产生，页面就"刷新
  // 一下"、弹窗被关掉。那个"刷新"就是本页的整页早退分支——`permissionsReady` 一旦按
  // `fetchStatus` 判定，每一次 /me 后台续期（/ws/authority 重连、staleTime 到期后任一
  // 新观察者挂载都会触发）都会让 resolveTaskDetailTabs 返回 pending，整页被换成
  // <LoadingState>，面板连同它持有的 UI 状态（开着的弹窗、选中的文件、展开的分组）一起
  // 被卸载，续期结束后重新挂载的是全新空状态。这条锁住"续期期间这一页什么都不动"。
  test('a background /me refresh never collapses the page into its loading state', async () => {
    installFetch(() => undefined)
    const row = task('plain')
    const { router, qc } = renderTaskRoute('/tasks/plain?tab=details', [row])
    await waitFor(() => expectActivePanel('details'))
    const panel = document.getElementById('task-detail-section-details')

    await act(async () => {
      // 现场就是这样发生的：一条 WS 帧带来任务数据刷新，与此同时 /me 正在后台续期。
      actorState.fetchStatus = 'fetching'
      qc.setQueryData(['tasks', 'plain'], { ...row, name: 'Task plain (live update)' })
      await router.invalidate()
    })
    // `.task-detail__name` 只存在于完整页面上：它拿到新名字，就同时证明了「这一帧确实
    // 重渲染过」和「页面没有塌成 <LoadingState>」（早退分支只剩 PageHeader + 转圈）。
    await waitFor(() =>
      expect(document.querySelector('.task-detail__name')?.textContent).toBe(
        'Task plain (live update)',
      ),
    )
    expectActivePanel('details')
    // 同一个 DOM 实例 = 没有重挂载，面板里的局部状态（开着的弹窗等）才留得住。
    expect(document.getElementById('task-detail-section-details')).toBe(panel)
  })

  // 2026-08-25 修正：**后台续期不是撤权**。此前 `fetching` 期间 `canDeleteTask` 翻假，
  // 打开着的确认弹窗被关掉、用户输了一半的任务名被清空——而一次 /me 续期在真实会话里
  // 几秒就来一次。现在续期期间弹窗照旧留着，真正的把关仍在请求边界
  // （hasPermissionAtRequest）：陈旧的确认点击一个 DELETE 都发不出去。
  test('delete dialog survives a background refresh, closes on error, and stale confirms send zero DELETE', async () => {
    actorState.permissions = ['memory:read', 'tasks:delete']
    const row = task('deletable', { name: 'Delete me', spaceKind: 'remote' })
    const fetchSpy = installFetch((path) =>
      path === '/api/tasks/deletable' ? json({ taskId: 'deletable' }) : undefined,
    )
    const { router } = renderTaskRoute('/tasks/deletable?tab=details', [row])
    fireEvent.click(await screen.findByTestId('task-detail-delete'))
    let dialog = await screen.findByRole('dialog', { name: 'Delete Delete me?' })
    fireEvent.change(within(dialog).getByTestId('confirm-input'), {
      target: { value: 'Delete me' },
    })
    const staleConfirm = within(dialog).getByRole('button', { name: 'Delete' })
    let invocations = 0
    staleConfirm.addEventListener('click', () => {
      invocations += 1
    })
    await act(async () => {
      actorState.fetchStatus = 'fetching'
      actorState.requestAllowed = false
      fireEvent.click(staleConfirm)
      await router.invalidate()
    })
    expect(invocations).toBe(1)
    expect(
      fetchSpy.mock.calls.filter(
        (call: [RequestInfo | URL, RequestInit?]) => call[1]?.method === 'DELETE',
      ),
    ).toHaveLength(0)
    // 续期中：弹窗还在，用户输入的确认文本也还在（页面没有整页重挂）。
    dialog = screen.getByRole('dialog', { name: 'Delete Delete me?' })
    expect((within(dialog).getByTestId('confirm-input') as HTMLInputElement).value).toBe(
      'Delete me',
    )

    actorState.fetchStatus = 'idle'
    actorState.requestAllowed = true
    await router.invalidate()
    // 弹窗自始至终是同一个实例（没有被卸载重建），所以点击计数器也照旧挂在它身上。
    dialog = await screen.findByRole('dialog', { name: 'Delete Delete me?' })
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBe(staleConfirm)
    await act(async () => {
      actorState.error = new Error('me refresh failed')
      actorState.requestAllowed = false
      fireEvent.click(staleConfirm)
      await router.invalidate()
    })
    expect(invocations).toBe(2)
    expect(
      fetchSpy.mock.calls.filter(
        (call: [RequestInfo | URL, RequestInit?]) => call[1]?.method === 'DELETE',
      ),
    ).toHaveLength(0)
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Delete Delete me?' })).toBeNull(),
    )
  })

  test('a reachable call node jumps directly to its child task', async () => {
    installFetch(() => undefined)
    const parent = task('parent', {
      workflowSnapshot: {
        $schema_version: 4,
        inputs: [],
        nodes: [{ id: 'call1', kind: 'call-workflow', workflowName: 'child-flow' }],
        edges: [],
      } as Task['workflowSnapshot'],
    })
    const child = task('child', { parentTaskId: 'parent' })
    const { qc, router } = renderTaskRoute('/tasks/parent?tab=workflow-status', [parent, child])
    act(() => {
      qc.setQueryData(['tasks', 'parent', 'node-runs'], {
        runs: [nodeRun({ childTaskId: 'child' })],
        outputs: [],
      })
      qc.setQueryData(['tasks', 'children', 'parent'], [child])
    })

    await waitFor(() => {
      expect(screen.getByTestId('canvas-call-jump').getAttribute('data-call-nav')).toBe('child')
    })
    fireEvent.click(screen.getByTestId('canvas-call-jump'))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/tasks/child')
      expect(document.querySelector('.task-detail__name')?.textContent).toBe('Task child')
      expect(document.querySelector('.task-canvas-layout--with-drawer')).toBeNull()
    })
  })

  test('call-row run detail stays reachable and task-to-task navigation clears its drawer state', async () => {
    installFetch(() => undefined)
    const parent = task('parent', {
      workflowSnapshot: {
        $schema_version: 4,
        inputs: [],
        // Legacy/corrupt snapshots may no longer resolve the node kind; the
        // wire-level childTaskId still proves this is a call row.
        nodes: [],
        edges: [],
      } as Task['workflowSnapshot'],
    })
    const next = task('next')
    const { qc, router } = renderTaskRoute('/tasks/parent?tab=node-runs', [parent, next])
    act(() => {
      qc.setQueryData(['tasks', 'parent', 'node-runs'], {
        runs: [nodeRun({ childTaskId: 'legacy-child' })],
        outputs: [],
      })
    })

    fireEvent.click(await screen.findByTestId('node-run-detail-run_1'))
    await waitFor(() => {
      expect(router.state.location.search.tab).toBe('workflow-status')
      expect(document.querySelector('.task-canvas-layout--with-drawer')).not.toBeNull()
    })

    await act(async () => {
      await router.navigate({
        to: '/tasks/$id',
        params: { id: 'next' },
        search: { tab: 'workflow-status' },
      })
    })
    await waitFor(() => {
      expect(document.querySelector('.task-detail__name')?.textContent).toBe('Task next')
      expect(document.querySelector('.task-canvas-layout--with-drawer')).toBeNull()
    })
  })

  test('no-worktree task filters artifact leaves and replaces an old diff deep link', async () => {
    installFetch(() => undefined)
    const { router } = renderTaskRoute('/tasks/no-worktree?tab=changes&focus=keep', [
      task('no-worktree'),
    ])

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'workflow-status', focus: 'keep' })
      expectActivePanel('workflow-status')
    })
    expect(document.getElementById('task-detail-section-changes')).toBeNull()
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
          mountPath: '',
          subdir: '',
          readonly: false,
          readonlyDirtyCount: null,
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
          mountPath: '',
          subdir: '',
          readonly: false,
          readonlyDirtyCount: null,
          hasSubmodules: null,
          submoduleInitOk: null,
          submoduleInitError: null,
        },
      ],
    })
    // legacy tab value in an old deep link normalizes to the merged pane
    const { router } = renderTaskRoute('/tasks/multi?tab=worktree-diff&focus=keep', [multi])

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'changes', focus: 'keep' })
      expectActivePanel('changes')
    })
    expect(screen.getByTestId('change-review-stub')).toBeTruthy()
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

    fireEvent.click(sectionDestination('changes'))
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tab: 'changes' })
      expectActivePanel('changes')
    })
    expect(screen.getByTestId('change-review-stub')).toBeTruthy()
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
    const { router } = renderTaskRoute('/tasks/plain?tab=changes&focus=keep', [plain, crew], {
      room: turnRoom('crew'),
    })

    await waitFor(() => expectActivePanel('changes'))
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
