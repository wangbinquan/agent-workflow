// RFC-359 W20: task detail and node-runs load independently. A real canvas
// click before node-runs arrives must survive until that node has a run, while
// switching/clearing selection and picking an exact run remain authoritative.
// The real route, canvas, drawer, session and inventory are mounted. Only
// transport response order and unrelated shell panels are controlled here.

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
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { NodeRun, Task, TaskNodeRuns } from '@agent-workflow/shared'
import i18n from '@/i18n'
import type * as ActorModule from '@/hooks/useActor'

// Same opaque shell inputs as the existing rendered task-detail route harness.
// Actual task query, node-runs query, TaskStatusCanvas, WorkflowCanvas,
// NodeDetailDrawer, SessionTab and RuntimeInventorySection are NOT mocked.
vi.mock('@/hooks/useTaskSync', () => ({ useTaskSync: vi.fn() }))
vi.mock('@/hooks/useActor', async (importOriginal) => ({
  ...(await importOriginal<typeof ActorModule>()),
  useActor: () => ({
    data: { permissions: ['memory:read'] },
    error: null,
    status: 'success',
    fetchStatus: 'idle',
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  usePermission: () => false,
  useLastResolvedPermissions: () => ({ resolved: true, permissions: new Set(['memory:read']) }),
  hasPermissionAtRequest: () => false,
}))
vi.mock('@/components/tasks/RecoverySection', () => ({ RecoverySection: () => null }))
vi.mock('@/components/tasks/StuckTaskBanner', () => ({ StuckTaskBanner: () => null }))
vi.mock('@/components/tasks/WorkflowSyncBanner', () => ({ WorkflowSyncBanner: () => null }))
vi.mock('@/components/tasks/TaskFeedbackList', () => ({ TaskFeedbackList: () => null }))
vi.mock('@/components/tasks/TaskQuestionList', () => ({ TaskQuestionList: () => null }))
vi.mock('@/components/tasks/TaskMembersPanel', () => ({ TaskMembersDialogButton: () => null }))
vi.mock('@/components/tasks/TaskReviewersLinkButton', () => ({
  TaskReviewersLinkButton: () => null,
}))
vi.mock('@/components/TaskSubjectLink', () => ({ TaskSubjectLink: () => null }))
vi.mock('@/components/TaskOutputPanel', () => ({
  collectPorts: () => [],
  TaskOutputPanel: () => null,
}))
vi.mock('@/components/WorktreeFilesPanel', () => ({ WorktreeFilesPanel: () => null }))
vi.mock('@/components/changes/ChangeReviewPanel', () => ({ ChangeReviewPanel: () => null }))
vi.mock('@/components/workgroup/room/WorkgroupRoom', () => ({ WorkgroupRoom: () => null }))
vi.mock('@/components/workgroup/DynamicWorkflowPanel', () => ({ DynamicWorkflowPanel: () => null }))

vi.mock('@/components/agents/NodeDependencyTreeSection', () => ({
  NodeDependencyTreeSection: () => null,
}))

import { Route as TaskDetailRoute } from '@/routes/tasks.detail'
import { setBaseUrl, setToken } from '@/stores/auth'
import { TASK_QUERY_KEYS } from '@/lib/query-keys'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
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
    containerRunId: null,
    scopePath: '',
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

const clients: QueryClient[] = []
let unexpectedRequests: string[] = []

// Same measured desktop surface as task-detail-route-history.test.tsx.
class DesktopResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe = (target: Element) => {
    this.callback(
      [
        {
          target,
          contentRect: { width: 1024, height: 768 },
          contentBoxSize: [{ inlineSize: 1024, blockSize: 768 }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }
  disconnect = () => {}
  unobserve = () => {}
}

beforeEach(() => {
  unexpectedRequests = []
  vi.stubGlobal('ResizeObserver', DesktopResizeObserver)
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  expect(unexpectedRequests).toEqual([])
})

function mountTask() {
  const requests: string[] = []
  const taskResponse = deferred<Response>()
  const runsResponse = deferred<TaskNodeRuns>()
  let readRuns = () => runsResponse.promise
  const row = task('inventory-task', {
    workflowSnapshot: {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'agent_1',
          kind: 'agent-single',
          agentId: 'agent-1',
          agentName: 'coder',
          position: { x: 0, y: 0 },
        },
        {
          id: 'agent_2',
          kind: 'agent-single',
          agentId: 'agent-2',
          agentName: 'reviewer',
          position: { x: 320, y: 0 },
        },
      ],
      edges: [],
    },
  })
  const run = nodeRun({ id: 'run-inventory', taskId: row.id, nodeId: 'agent_1' })
  const otherRun = nodeRun({ id: 'run-reviewer', taskId: row.id, nodeId: 'agent_2' })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(qc)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
    const path = new URL(request.toString()).pathname
    requests.push(path)
    if (path === `/api/tasks/${row.id}`) return taskResponse.promise
    if (path === `/api/tasks/${row.id}/node-runs`) return json(await readRuns())
    if (path === '/api/agents') return json([])
    if (path === '/api/workflows') return json([])
    if (path === '/api/auth/me')
      return json({
        id: 'fixture-user',
        username: 'fixture',
        displayName: 'fixture',
        permissions: ['memory:read'],
        role: 'admin',
        status: 'active',
      })
    if (path === `/api/tasks/${row.id}/questions`) return json([])
    if (path === `/api/tasks/${row.id}/clarify-directives`) return json({})
    if (path.endsWith('/events')) return json({ events: [], cursor: null })
    if (path.endsWith('/startup-verification'))
      return json({ available: false, reason: 'not-produced' })
    if (path.endsWith('/inventory'))
      return json({
        declaration: {
          agents: { support: 'supported', fields: {} },
          skills: { support: 'unsupported', fields: {} },
          mcps: { support: 'unsupported', fields: {} },
          plugins: { support: 'unsupported', fields: {} },
          tools: { support: 'unsupported', fields: {} },
        },
        observation: {
          state: 'captured',
          capturedAt: 1700000000000,
          faces: { agents: [{ key: 'coder', name: 'coder' }] },
        },
      })
    if (path.endsWith('/session'))
      return json({
        tree: {
          sessionId: 'fixture',
          parentSessionId: null,
          agentName: 'coder',
          messages: [],
          captureComplete: true,
        },
      })
    unexpectedRequests.push(path)
    throw new Error(`Unexpected request in task selection regression: ${path}`)
  })
  const root = createRootRoute({ component: () => <Outlet /> })
  const route = createRoute({
    getParentRoute: () => root,
    path: '/tasks/$id',
    validateSearch: TaskDetailRoute.options.validateSearch,
    remountDeps: TaskDetailRoute.options.remountDeps,
    component: TaskDetailRoute.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/tasks/${row.id}?tab=workflow-status`] }),
  })
  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return {
    row,
    run,
    otherRun,
    qc,
    view,
    requests,
    async showTask() {
      await act(async () => {
        taskResponse.resolve(json(row))
      })
    },
    async resolveRuns(runs: NodeRun[] = [run]) {
      await act(async () => {
        runsResponse.resolve({ runs, outputs: [] })
      })
      await waitFor(() =>
        expect(qc.getQueryState(TASK_QUERY_KEYS.nodeRuns(row.id))?.status).toBe('success'),
      )
    },
    async refetchRuns(runs: NodeRun[]) {
      readRuns = async () => ({ runs, outputs: [] })
      await act(async () => {
        await qc.refetchQueries({ queryKey: TASK_QUERY_KEYS.nodeRuns(row.id) })
      })
      expect(qc.getQueryData<TaskNodeRuns>(TASK_QUERY_KEYS.nodeRuns(row.id))?.runs).toEqual(runs)
    },
  }
}

type Harness = ReturnType<typeof mountTask>

async function nodeCard(h: Harness, nodeId = 'agent_1') {
  const selector = `.react-flow__node[data-id="${nodeId}"] .canvas-node--agent`
  await waitFor(() => expect(h.view.container.querySelector(selector)).not.toBeNull())
  return h.view.container.querySelector(selector)!
}

async function expectCanvasDone(h: Harness, nodeId = 'agent_1') {
  const card = await nodeCard(h, nodeId)
  // This waits for the actual React/query observer render, not only cache data.
  await waitFor(() => expect(card.getAttribute('data-status')).toBe('done'))
}

function expectRunDetail(h: Harness, run: NodeRun) {
  expect(h.view.container.querySelector('.inspector__id')?.textContent).toBe(
    `${run.nodeId} / ${run.id.slice(-6)}`,
  )
  expect(h.view.container.querySelector('[data-testid="runtime-inventory-section"]')).not.toBeNull()
}

function expectNoRunDetail(h: Harness) {
  expect(h.view.container.querySelector('.inspector')).toBeNull()
  expect(h.view.container.querySelector('[data-testid="runtime-inventory-section"]')).toBeNull()
}

test('normal response order: one click mounts the actual RuntimeInventorySection', async () => {
  const h = mountTask()
  await h.resolveRuns()
  await h.showTask()
  await expectCanvasDone(h)
  fireEvent.click(await nodeCard(h))
  await screen.findByTestId('runtime-inventory-section')
  await screen.findByTestId('inventory-chips')
  expectRunDetail(h, h.run)
  expect(h.view.container.querySelectorAll('.inspector')).toHaveLength(1)
})

test('delayed node-runs response: the first real canvas click should survive the nonempty response', async () => {
  const h = mountTask()
  await h.showTask()
  const card = await nodeCard(h)
  expect(h.qc.getQueryState(TASK_QUERY_KEYS.nodeRuns(h.row.id))?.fetchStatus).toBe('fetching')
  expect(card.getAttribute('data-status')).toBe('default')
  fireEvent.click(card)
  expectNoRunDetail(h)
  await h.resolveRuns()
  await expectCanvasDone(h)
  expect(
    h.qc.getQueryData<TaskNodeRuns>(TASK_QUERY_KEYS.nodeRuns(h.row.id))?.runs.map((r) => r.id),
  ).toEqual(['run-inventory'])
  expect(h.view.container.querySelector('.react-flow__node.selected')).not.toBeNull()
  expectRunDetail(h, h.run)
})

test('switching nodes while runs are pending only opens the last selected node', async () => {
  const h = mountTask()
  await h.showTask()
  fireEvent.click(await nodeCard(h))
  fireEvent.click(await nodeCard(h, 'agent_2'))
  await h.resolveRuns([h.run])
  await expectCanvasDone(h)
  expectNoRunDetail(h)
  expect(h.requests.filter((path) => path.endsWith('/inventory'))).toEqual([])
  await h.refetchRuns([h.run, h.otherRun])
  await expectCanvasDone(h, 'agent_2')
  expectRunDetail(h, h.otherRun)
  await screen.findByTestId('inventory-chips')
  expect(h.requests.filter((path) => path.endsWith('/inventory'))).toEqual([
    `/api/tasks/${h.row.id}/node-runs/${h.otherRun.id}/inventory`,
  ])
})

test('clearing the canvas while runs are pending cancels the pending selection', async () => {
  const h = mountTask()
  await h.showTask()
  fireEvent.click(await nodeCard(h))
  const pane = h.view.container.querySelector('.react-flow__pane')
  expect(pane).not.toBeNull()
  fireEvent.click(pane!)
  await h.resolveRuns()
  await expectCanvasDone(h)
  expectNoRunDetail(h)
  expect(h.requests.filter((path) => path.endsWith('/inventory'))).toEqual([])
  fireEvent.click(await nodeCard(h))
  await screen.findByTestId('runtime-inventory-section')
  expectRunDetail(h, h.run)
})

test('an explicitly chosen history run is not replaced by newer node-runs data', async () => {
  const h = mountTask()
  const newest = nodeRun({
    ...h.run,
    id: 'run-newest',
    retryIndex: 1,
    startedAt: 1_700_000_002_000,
  })
  await h.resolveRuns([h.run, newest])
  await h.showTask()
  await expectCanvasDone(h)
  fireEvent.click(await nodeCard(h))
  await screen.findByTestId('runtime-inventory-section')
  expectRunDetail(h, newest)
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('nodeDrawer.tabStats') }))
  const history = screen.getByTestId('stats-history-list')
  const previousAttempt = within(history)
    .getAllByRole<HTMLButtonElement>('button')
    .find((button) => !button.disabled)
  expect(previousAttempt).toBeDefined()
  fireEvent.click(previousAttempt!)
  expect(h.view.container.querySelector('.inspector__id')?.textContent).toBe(
    `${h.run.nodeId} / ${h.run.id.slice(-6)}`,
  )
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('nodeDrawer.tabSession') }))
  expectRunDetail(h, h.run)
  const later = nodeRun({ ...newest, id: 'run-later', retryIndex: 2, startedAt: 1_700_000_003_000 })
  await h.refetchRuns([h.run, newest, later])
  expectRunDetail(h, h.run)
  expect(h.requests.filter((path) => path.endsWith(`/${later.id}/inventory`))).toEqual([])
})

test('closing a resolved pending selection stays closed after refresh and permits a fresh click', async () => {
  const h = mountTask()
  await h.showTask()
  fireEvent.click(await nodeCard(h))
  await h.resolveRuns()
  await expectCanvasDone(h)
  expectRunDetail(h, h.run)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('inspector.closeAria') }))
  expectNoRunDetail(h)
  const later = nodeRun({ ...h.run, id: 'run-later', retryIndex: 1, startedAt: 1_700_000_003_000 })
  await h.refetchRuns([h.run, later])
  expectNoRunDetail(h)
  fireEvent.click(await nodeCard(h))
  await screen.findByTestId('runtime-inventory-section')
  expectRunDetail(h, later)
})
