// RFC-371 v2 §6 (design/RFC-371-run-observability/redesign-v2-20261014.md):
// the run observation page — the window follows the selected range and the
// browser offset, the overview never shows an unknown price as free, the task
// list filters and pages by cursor, the task detail shows one swimlane row and
// one table row per call, unpriced models link to their price line, and system
// work is listed apart from business tasks.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ObservationCall, ObservationOverview, ObservationUsage } from '@agent-workflow/shared'
import {
  RunObservability,
  type ObservationSearch,
} from '../src/components/observability/RunObservability'
import { validateObservationSearch } from '../src/routes/observability'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const HOUR = 3_600_000

function usage(overrides: Partial<ObservationUsage> = {}): ObservationUsage {
  return {
    calls: 0,
    incompleteCalls: 0,
    failedCalls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costNano: 0,
    unpricedCalls: 0,
    ...overrides,
  }
}

const overview: ObservationOverview = {
  asOf: 1,
  from: 0,
  to: 1,
  partial: false,
  usage: usage({ calls: 3, input: 1200, output: 300, costNano: 2_000_000_000, unpricedCalls: 1 }),
  taskUsage: usage({ calls: 2, input: 1100, output: 250, costNano: 2_000_000_000 }),
  systemUsage: usage({ calls: 1, input: 100, output: 50, unpricedCalls: 1 }),
  tasks: {
    total: 4,
    done: 2,
    failed: 1,
    canceled: 0,
    running: 1,
    waiting: 0,
    interrupted: 0,
    durationSamples: 3,
    durationP50: HOUR,
    durationP95: 2 * HOUR,
    durationMax: 2 * HOUR,
  },
  daily: [
    { day: '2026-10-13', calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costNano: 0 },
    {
      day: '2026-10-14',
      calls: 3,
      input: 1200,
      cacheRead: 0,
      cacheWrite: 0,
      output: 300,
      costNano: 2_000_000_000,
    },
  ],
  topTasks: [
    { taskId: 't-1', name: 'Nightly build', usage: usage({ calls: 2, input: 1100, output: 250 }) },
    { taskId: 't-gone', name: null, usage: usage({ calls: 1, input: 10 }) },
  ],
  topAgents: [
    {
      agentId: 'a1',
      agentName: 'planner',
      tasks: 1,
      durationMs: 60_000,
      usage: usage({ input: 1100 }),
    },
  ],
}

function call(overrides: Partial<ObservationCall>): ObservationCall {
  return {
    id: 'c',
    purpose: 'task',
    taskId: 't-1',
    systemKind: null,
    systemLabel: null,
    nodeRunId: 'nr',
    nodeId: 'plan',
    attempt: 1,
    agentId: 'a1',
    agentName: 'planner',
    runtimeId: 'rt-1',
    runtimeName: 'claude-main',
    protocol: 'claude-code',
    status: 'done',
    startedAt: 1_000,
    endedAt: 61_000,
    usageState: 'complete',
    costState: 'priced',
    input: 100,
    cacheRead: 0,
    cacheWrite: 0,
    output: 10,
    reasoning: 0,
    costNano: 1_000_000,
    models: [
      {
        model: 'sonnet',
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 10,
        reasoning: 0,
        costNano: 1_000_000,
      },
    ],
    ...overrides,
  }
}

const requests: URL[] = []
const responses = new Map<string, (url: URL) => { status?: number; body: unknown }>()

function respond(path: string, handler: (url: URL) => { status?: number; body: unknown }) {
  responses.set(path, handler)
}

function mount(initial = '/observability') {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
    const url = new URL(String(raw))
    requests.push(url)
    const handler = responses.get(url.pathname)
    if (!handler) throw new Error('Unexpected request: ' + url.pathname)
    const { status = 200, body } = handler(url)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: '/observability',
    validateSearch: (raw: Record<string, unknown>) => validateObservationSearch(raw),
    component: function Page() {
      const search = page.useSearch() as ObservationSearch
      const navigate = page.useNavigate()
      return (
        <RunObservability search={search} onChange={(next) => void navigate({ search: next })} />
      )
    },
  })
  const settings = createRoute({
    getParentRoute: () => root,
    path: '/settings',
    component: () => <p>Settings page</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page, settings]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as AnyRouter} />
    </QueryClientProvider>,
  )
  return router
}

const last = (path: string) => [...requests].reverse().find((url) => url.pathname === path)

beforeEach(async () => {
  setBaseUrl('http://localhost')
  setToken('test-token')
  await i18n.changeLanguage('zh-CN')
  requests.length = 0
  responses.clear()
  respond('/api/observability/overview', () => ({ body: overview }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setToken('')
})

test('the overview shows totals, partial prices, task outcomes and exact daily values', async () => {
  mount()
  expect(await screen.findByText('1,500')).toBeDefined()
  expect(screen.getByText('¥2.00 起')).toBeDefined()
  expect(screen.getByText('1 次调用未定价或部分定价')).toBeDefined()
  expect(screen.getByText('共 4 个任务')).toBeDefined()
  expect(screen.getByText('P50 1 小时 0 分 · P95 2 小时 0 分')).toBeDefined()
  expect(screen.getByText('已删除任务')).toBeDefined()
  // The system share has tokens and no price: it is unpriced, never ¥0.
  const split = screen.getByRole('table', { name: '业务与系统消耗' })
  expect(within(split).getByText('未定价')).toBeDefined()
  expect(within(split).getByText('¥2.00')).toBeDefined()
  const day = screen.getByRole('button', { name: /^2026-10-14：3 次调用/ })
  fireEvent.focus(day)
  expect(screen.getByText(/^2026-10-14：3 次调用；输入 1,200/, { selector: 'p' })).toBeDefined()
  const window = last('/api/observability/overview')!
  expect(Number(window.searchParams.get('to')) - Number(window.searchParams.get('from'))).toBe(
    7 * 24 * HOUR,
  )
  expect(window.searchParams.get('tzOffset')).toBe(String(-new Date().getTimezoneOffset()))
})

test('choosing a range moves the window and a partial scope is announced', async () => {
  respond('/api/observability/overview', () => ({ body: { ...overview, partial: true } }))
  mount()
  expect(
    await screen.findByText('可见任务过多，统计只包含其中一部分。请缩小时间范围。'),
  ).toBeDefined()
  fireEvent.click(screen.getByRole('radio', { name: '近 24 小时' }))
  await waitFor(() => {
    const window = last('/api/observability/overview')!
    expect(Number(window.searchParams.get('to')) - Number(window.searchParams.get('from'))).toBe(
      24 * HOUR,
    )
  })
})

test('tasks filter by keyword and status and page by cursor; a task opens its calls', async () => {
  respond('/api/observability/tasks', (url) => ({
    body: {
      asOf: 1,
      nextCursor: url.searchParams.get('cursor') ? null : 'page-2',
      items: [
        {
          taskId: url.searchParams.get('cursor') ? 't-2' : 't-1',
          name: url.searchParams.get('cursor') ? 'Second page task' : 'Nightly build',
          status: 'done',
          startedAt: 0,
          finishedAt: 2 * HOUR,
          agents: 1,
          usage: usage({ calls: 2, input: 100, output: 10, unpricedCalls: 2 }),
        },
      ],
    },
  }))
  respond('/api/observability/tasks/t-1', () => ({
    body: {
      asOf: 200_000,
      task: {
        id: 't-1',
        name: 'Nightly build',
        status: 'done',
        startedAt: 0,
        finishedAt: 2 * HOUR,
        runningMs: HOUR,
      },
      usage: usage({ calls: 3, input: 300, output: 30, costNano: 2_000_000 }),
      truncated: false,
      calls: [
        call({ id: 'c-1' }),
        call({ id: 'c-2', attempt: 2, status: 'failed', startedAt: 70_000, endedAt: 80_000 }),
        call({
          id: 'c-3',
          purpose: 'system',
          nodeRunId: null,
          nodeId: null,
          attempt: null,
          systemKind: 'merge-resolve',
          agentName: 'aw-merge',
          status: 'running',
          startedAt: 90_000,
          endedAt: null,
          usageState: 'none',
          costState: 'none',
          input: 0,
          output: 0,
          costNano: 0,
          models: [],
        }),
      ],
    },
  }))
  mount('/observability?tab=tasks')
  expect(await screen.findByRole('button', { name: '查看 Nightly build' })).toBeDefined()
  expect(screen.getByText('2 小时 0 分')).toBeDefined()
  expect(screen.getByText('未定价')).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  expect(await screen.findByRole('button', { name: '查看 Second page task' })).toBeDefined()
  expect(last('/api/observability/tasks')!.searchParams.get('cursor')).toBe('page-2')
  fireEvent.click(screen.getByRole('button', { name: '上一页' }))
  expect(await screen.findByRole('button', { name: '查看 Nightly build' })).toBeDefined()

  fireEvent.change(screen.getByRole('textbox', { name: '搜索任务' }), {
    target: { value: 'night' },
  })
  await waitFor(() => expect(last('/api/observability/tasks')!.searchParams.get('q')).toBe('night'))
  expect(last('/api/observability/tasks')!.searchParams.get('cursor')).toBeNull()

  fireEvent.click(await screen.findByRole('button', { name: '查看 Nightly build' }))
  const heading = await screen.findByRole('heading', { name: 'Nightly build' })
  // Locks the 2026-10-14 visual finding: the status chip sat directly in the
  // column-flex heading and stretched across the page; the shared PageHeader
  // puts it in the meta line.
  const header = heading.closest('.page__header') as HTMLElement
  expect(within(header).getByText('已完成').closest('.page__meta')).not.toBeNull()
  const calls = screen.getByRole('table', { name: '调用明细' })
  expect(within(calls).getByText('plan · 第 2 次')).toBeDefined()
  expect(within(calls).getByText('系统 · 合并冲突处理')).toBeDefined()
  expect(within(calls).getByText('失败')).toBeDefined()
  expect(within(calls).getByText('运行时未报告')).toBeDefined()
  expect(within(calls).getAllByText('sonnet')).toHaveLength(2)
  const lanes = screen.getByRole('heading', { name: '调用泳道' }).closest('.card') as HTMLElement
  expect(within(lanes).getAllByRole('button')).toHaveLength(3)
  fireEvent.click(within(lanes).getByRole('button', { name: /^系统 · 合并冲突处理：运行中/ }))
  expect(document.activeElement?.getAttribute('data-call-id')).toBe('c-3')

  fireEvent.click(screen.getByRole('button', { name: '返回任务列表' }))
  expect(await screen.findByRole('button', { name: '查看 Nightly build' })).toBeDefined()
})

test('an invisible task explains itself instead of failing', async () => {
  respond('/api/observability/tasks/t-x', () => ({
    status: 404,
    body: { ok: false, code: 'task-not-found', message: 'Task not found' },
  }))
  mount('/observability?tab=tasks&task=t-x')
  expect(await screen.findByText('任务不存在或无权查看')).toBeDefined()
})

test('agents and models list consumption; an unpriced model links to its price line', async () => {
  respond('/api/observability/agents', () => ({
    body: {
      asOf: 1,
      partial: false,
      truncated: false,
      items: [
        {
          agentId: 'a1',
          agentName: 'planner',
          tasks: 2,
          durationMs: 90_000,
          usage: usage({ calls: 3, input: 500 }),
        },
      ],
    },
  }))
  respond('/api/observability/models', () => ({
    body: {
      asOf: 1,
      partial: false,
      truncated: false,
      items: [
        {
          runtimeId: 'rt-1',
          runtimeName: 'claude-main',
          protocol: 'claude-code',
          model: 'haiku',
          usage: usage({ calls: 1, input: 5, unpricedCalls: 1 }),
        },
        {
          runtimeId: 'rt-1',
          runtimeName: 'claude-main',
          protocol: 'claude-code',
          model: '',
          usage: usage({ calls: 1, input: 1 }),
        },
        {
          runtimeId: 'builtin:opencode',
          runtimeName: null,
          protocol: 'opencode',
          model: 'opencode-go/deepseek',
          usage: usage({ calls: 2, input: 9, unpricedCalls: 2 }),
        },
      ],
    },
  }))
  const router = mount('/observability?tab=agents')
  const agents = await screen.findByRole('table', { name: 'Agent' })
  expect(within(agents).getByText('planner')).toBeDefined()
  expect(within(agents).getByText('1 分钟')).toBeDefined()
  const models = screen.getByRole('table', { name: '运行时 × 模型' })
  expect(within(models).getByText('未归属模型')).toBeDefined()
  // A call without a runtime registration is named after its built-in runtime,
  // not shown as if it ran on a registration, and its price line is reachable.
  const builtin = within(models).getByRole('row', { name: /^内置 opencode/ })
  expect(within(builtin).getByRole('link', { name: '配置价格' })).toBeDefined()
  const link = within(models).getAllByRole('link', { name: '配置价格' })[0]!
  fireEvent.click(link)
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  expect(router.state.location.search).toMatchObject({ tab: 'runtime' })
  expect(router.state.location.hash).toBe('token-cost')
})

test('system work is listed by kind and newest calls, filtered by kind', async () => {
  respond('/api/observability/system', (url) => ({
    body: {
      asOf: 1,
      partial: false,
      nextCursor: null,
      kinds: [
        { kind: 'merge-resolve', label: null, usage: usage({ calls: 1, input: 40 }) },
        { kind: 'memory-distill', label: '记忆提取 · task', usage: usage({ calls: 1, input: 10 }) },
      ],
      recent: [
        call({
          id: 's-1',
          purpose: 'system',
          systemKind: url.searchParams.get('kind') ?? 'memory-distill',
          systemLabel: '记忆提取 · task',
          nodeId: null,
          attempt: null,
          agentName: 'aw-memory-distiller',
          costState: 'unpriced',
          costNano: 0,
        }),
      ],
    },
  }))
  mount('/observability?tab=system')
  const kinds = await screen.findByRole('table', { name: '按类别汇总' })
  expect(within(kinds).getByText('合并冲突处理')).toBeDefined()
  const recent = screen.getByRole('table', { name: '最近的系统调用' })
  expect(within(recent).getByText('记忆提取 · task')).toBeDefined()
  expect(within(recent).getByText('未定价')).toBeDefined()
  fireEvent.click(screen.getByRole('combobox', { name: '类别' }))
  // The shared Select commits on mousedown so focus stays put while it closes.
  fireEvent.mouseDown(await screen.findByRole('option', { name: '合并冲突处理' }))
  await waitFor(() =>
    expect(last('/api/observability/system')!.searchParams.get('kind')).toBe('merge-resolve'),
  )
})
