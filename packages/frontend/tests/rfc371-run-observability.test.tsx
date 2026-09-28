// RFC-371: the real read page distinguishes missing/zero, keeps its query window and opens attempt details.
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  type AnyRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  ObservationOverview,
  ObservationMetrics,
  ObservationTaskDetail,
  ObservationTaskPage,
} from '@agent-workflow/shared'
import {
  RunObservability,
  type ObservationSearch,
} from '../src/components/observability/RunObservability'
import { formatObservationCny } from '../src/components/observability/formatObservations'
import { ExecutionSwimlane } from '../src/components/ExecutionSwimlane'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const NOW = 1_790_553_600_000
const search: ObservationSearch = { from: NOW - 7 * 86400000, to: NOW, period: 'week' }
function metrics(patch: Partial<ObservationMetrics> = {}): ObservationMetrics {
  return {
    invocations: 2,
    observedInvocations: 1,
    records: 1,
    tokens: {
      known: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
      totalKnown: '0',
      hasKnown: true,
      complete: false,
      unknownBuckets: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
    cost: {
      currency: 'CNY',
      knownAmount: '0',
      complete: false,
      pricedRecords: 1,
      priceVersionIds: ['cs-price-7'],
      reasons: ['pending'],
    },
    authorities: ['crewstation'],
    truncated: false,
    ...patch,
  }
}
const task = {
  id: 'task-1',
  name: '真实任务',
  status: 'running',
  parentTaskId: null,
  startedAt: NOW - 10000,
  finishedAt: null,
  runningMs: 2000,
  runningSince: NOW - 3000,
}
function overview(): ObservationOverview {
  const value = metrics(),
    summary = { task, metrics: value, wallMs: 10000, runningMs: 5000 }
  return {
    asOf: NOW,
    projectionVersion: 1,
    cohort: 'started',
    taskScope: 'direct',
    filtersEcho: { from: search.from, to: search.to, timezone: 'UTC' },
    partial: false,
    limits: { tasks: 200, invocations: 10000, records: 20000 },
    metrics: value,
    tasks: [summary],
    statuses: [{ status: 'running', count: 1 }],
    trend: [{ from: search.from, to: search.to, taskCount: 1, metrics: value }],
    agents: [
      {
        agentId: 'agent-1',
        agentRevision: 3,
        purpose: 'task',
        metrics: value,
        tasks: [{ taskId: task.id, metrics: value }],
      },
    ],
    models: [
      {
        authority: 'crewstation',
        sourceId: 'cs-installation',
        provider: null,
        model: 'platform-ref',
        metrics: value,
      },
    ],
    runtimes: [
      {
        authority: 'crewstation',
        sourceId: 'cs-installation',
        registrationId: null,
        configurationRevision: null,
        protocol: null,
        metrics: value,
      },
    ],
    durations: { completedTasks: 0, p50Ms: null, p95Ms: null, maxMs: null },
    quality: [{ reason: 'pending', taskIds: [task.id] }],
  }
}
function detail(): ObservationTaskDetail {
  return {
    task,
    metrics: metrics(),
    wallMs: 10000,
    runningMs: 5000,
    asOf: NOW,
    projectionVersion: 1,
    taskScope: 'direct',
    agents: [{ agentId: 'agent-1', agentRevision: 3, purpose: 'task', metrics: metrics() }],
    attempts: [
      {
        attempt: {
          id: 'attempt-1',
          nodeId: '实现',
          status: 'done',
          startedAt: NOW - 9000,
          finishedAt: NOW - 4000,
          retryIndex: 1,
          iteration: 2,
          wgRound: 3,
          reviewIteration: 4,
        },
        metrics: metrics(),
        interval: { start: NOW - 9000, end: NOW - 4000, open: false },
        agents: [{ id: 'agent-1', revision: 3 }],
      },
    ],
    attemptsTruncated: false,
    intervals: {
      cumulativeMs: 5000,
      activeUnionMs: 5000,
      knownAttempts: 1,
      unknownAttempts: 0,
      unlinkedInvocations: 0,
    },
    sources: [
      {
        sourceId: 'cs-instance',
        status: 'failed',
        asOf: new Date(NOW - 1000).toISOString(),
        error: 'unavailable',
        costsVisible: true,
        hasGaps: false,
      },
    ],
  }
}
beforeEach(async () => {
  setBaseUrl('http://localhost')
  setToken('fixture')
  await i18n.changeLanguage('zh-CN')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setToken('')
})
function fixture(
  initial: ObservationSearch = search,
  options: {
    error?: boolean
    empty?: boolean
    detail?: ObservationTaskDetail
    overview?: ObservationOverview
  } = {},
) {
  const paths: URL[] = [],
    changes: ObservationSearch[] = [],
    state = { error: false, empty: false, detail: detail(), overview: overview(), ...options }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const url = new URL(String(raw))
    paths.push(url)
    expect(init?.method ?? 'GET').toBe('GET')
    if (state.error)
      return Response.json({ error: { code: 'unavailable', message: 'offline' } }, { status: 503 })
    if (url.pathname === '/api/observability/tasks/task-1') return Response.json(state.detail)
    if (url.pathname === '/api/observability/overview') return Response.json(state.overview)
    if (url.pathname !== '/api/observability/tasks')
      throw new Error('Unexpected API: ' + url.pathname)
    const page: ObservationTaskPage = {
      items: state.empty ? [] : [{ task, metrics: metrics(), wallMs: 10000, runningMs: 5000 }],
      nextCursor: url.searchParams.has('after') ? null : 'opaque-next',
      asOf: NOW,
      projectionVersion: 1,
      cohort: 'started',
      taskScope: 'direct',
      filtersEcho: { ...search, timezone: 'UTC', limit: 20 },
    }
    return Response.json(page)
  })
  function Page() {
    const [current, change] = useState(initial)
    return (
      <RunObservability
        search={current}
        onChange={(next) => {
          changes.push(next)
          change(next)
        }}
      />
    )
  }
  const root = createRootRoute({ component: Page })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as AnyRouter} />
    </QueryClientProvider>,
  )
  return { paths, changes, state }
}
test('page → task → attempt → back preserves the original filter and exact-zero CNY', async () => {
  const f = fixture()
  const open = await screen.findByRole('button', { name: '真实任务' })
  expect(screen.getByText('¥0')).toBeTruthy()
  expect(screen.getByText('CS 托管')).toBeTruthy()
  fireEvent.click(open)
  expect(await screen.findByRole('heading', { name: 'Agent 贡献' })).toBeTruthy()
  expect(screen.getByText('同步失败，展示历史数据')).toBeTruthy()
  const bar = screen.getByRole('button', { name: '查看尝试统计 · 实现 · attempt-1' })
  bar.focus()
  expect(document.activeElement).toBe(bar)
  fireEvent.click(bar)
  expect(await screen.findByRole('heading', { name: '尝试 attempt-1' })).toBeTruthy()
  expect(screen.getByText(/技术重试 1/).textContent).toContain('工作组轮次 3')
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(bar)
  fireEvent.click(screen.getByRole('button', { name: '返回任务消耗' }))
  await screen.findByRole('button', { name: '真实任务' })
  expect(f.changes.at(-1)).toEqual({ ...search, task: undefined })
  expect(f.paths.some((url) => url.pathname.endsWith('/task-1'))).toBe(true)
  expect(
    f.paths
      .filter((url) => url.pathname.endsWith('/tasks'))
      .every((url) => url.searchParams.get('from') === String(search.from)),
  ).toBe(true)
})
test('pagination requests the opaque cursor and disabling next does not erase first-page recovery', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: '真实任务' })
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() =>
    expect(f.paths.some((url) => url.searchParams.get('after') === 'opaque-next')).toBe(true),
  )
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: '第一页' }))
  expect(f.changes.at(-1)?.after).toBeUndefined()
})
test('overview tabs share one server snapshot and agent drill-down restores its scope', async () => {
  const f = fixture({ ...search, tab: 'overview' })
  await screen.findByRole('heading', { name: '任务用量趋势' })
  expect(f.paths.filter((path) => path.pathname === '/api/observability/overview')).toHaveLength(1)
  fireEvent.click(screen.getByRole('tab', { name: 'Agent 分析' }))
  await screen.findByRole('heading', { name: '跨任务 Agent 汇总' })
  fireEvent.click(screen.getByRole('button', { name: /agent-1/ }))
  await screen.findByRole('heading', { name: '该 Agent 的任务贡献' })
  expect(f.changes.at(-1)?.agent).toBe('["agent-1",3,"task"]')
  fireEvent.click(screen.getByRole('button', { name: '真实任务' }))
  await screen.findByRole('heading', { name: '任务整体' })
  fireEvent.click(screen.getByRole('button', { name: '返回统计分析' }))
  await screen.findByRole('heading', { name: '该 Agent 的任务贡献' })
  expect(f.changes.at(-1)).toMatchObject({
    tab: 'agents',
    agent: '["agent-1",3,"task"]',
    from: search.from,
    to: search.to,
  })
  fireEvent.click(screen.getByRole('tab', { name: 'Token 与成本' }))
  await screen.findByRole('heading', { name: '实际模型消耗分布' })
  expect(screen.getByText('platform-ref')).toBeTruthy()
  expect(screen.getAllByText('平台来源 cs-installation')).toHaveLength(2)
  expect(screen.getAllByText('¥0').length).toBeGreaterThan(0)
  expect(screen.getByText('CS 管理的运行时')).toBeTruthy()
  expect(f.paths.filter((path) => path.pathname === '/api/observability/overview')).toHaveLength(1)
})
test('trend drill-down fixes an exact interval; refresh preserves a custom window', async () => {
  const f = fixture({ ...search, tab: 'overview' })
  await screen.findByRole('heading', { name: '任务用量趋势' })
  fireEvent.click(screen.getByRole('button', { name: /→.*1 个任务/ }))
  await screen.findByRole('button', { name: '真实任务' })
  expect(f.changes.at(-1)).toEqual({
    from: search.from,
    to: search.to,
    period: 'custom',
    tab: 'tasks',
  })
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 86400000)
  const count = f.paths.length
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(f.paths.length).toBeGreaterThan(count))
  expect(f.paths.at(-1)?.searchParams.get('to')).toBe(String(search.to))
})
test('performance distinguishes absent completed samples and quality drill-down from a healthy collector claim', async () => {
  const f = fixture(
    { ...search, tab: 'performance' },
    { overview: { ...overview(), partial: true } },
  )
  await screen.findByRole('heading', { name: '用量与估值的数据质量' })
  expect(screen.getByText('当前为部分统计')).toBeTruthy()
  const p50 = screen.getByRole('heading', { name: '任务墙钟 P50' }).closest('.card')!
  expect(within(p50 as HTMLElement).getByText('—')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '估值待同步 · 1' }))
  fireEvent.click(await screen.findByRole('button', { name: '真实任务' }))
  await screen.findByRole('heading', { name: '任务整体' })
  expect(f.changes.at(-1)).toMatchObject({ tab: 'performance', task: 'task-1', quality: 'pending' })
  fireEvent.click(screen.getByRole('button', { name: '返回统计分析' }))
  await screen.findByRole('button', { name: '真实任务' })
  expect(screen.getByRole('button', { name: '估值待同步 · 1' }).getAttribute('aria-pressed')).toBe(
    'true',
  )
  expect(f.changes.at(-1)).toMatchObject({
    tab: 'performance',
    quality: 'pending',
    from: search.from,
    to: search.to,
  })
})
test.each(['week', 'all'] as const)(
  'explicit refresh reanchors %s and resets pagination so new tasks enter the cohort',
  async (period) => {
    const f = fixture({ ...search, period, after: 'old-page' })
    await screen.findByRole('button', { name: '真实任务' })
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 86400000)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    const to = NOW + 86400000 + 1
    await waitFor(() =>
      expect(f.paths.some((url) => url.searchParams.get('to') === String(to))).toBe(true),
    )
    expect(f.changes.at(-1)).toEqual({ period, from: period === 'all' ? 0 : to - 7 * 86400000, to })
    expect(f.paths.at(-1)?.searchParams.has('after')).toBe(false)
  },
)
test('no measured interval is unknown, and an unlinked invocation is explained', async () => {
  fixture(
    { ...search, task: 'task-1' },
    {
      detail: {
        ...detail(),
        intervals: {
          cumulativeMs: 0,
          activeUnionMs: 0,
          knownAttempts: 0,
          unknownAttempts: 0,
          unlinkedInvocations: 1,
        },
      },
    },
  )
  await screen.findByRole('heading', { name: '任务整体' })
  expect(screen.getByText('1 次调用尚无可关联的尝试时间，未计入时长小计。')).toBeTruthy()
  const label = screen.getByText('已知尝试累计')
  expect(label.nextElementSibling?.textContent).toBe('—')
})
test('an initial missing observation stays a dash in English, with a platform explanation', async () => {
  await i18n.changeLanguage('en-US')
  fixture(
    { ...search, task: 'task-1' },
    {
      detail: {
        ...detail(),
        metrics: metrics({
          tokens: { ...metrics().tokens, hasKnown: false },
          cost: { ...metrics().cost, knownAmount: null, reasons: ['not-authorized'] },
        }),
        sources: [
          {
            sourceId: 'cs-instance',
            status: 'initial',
            asOf: null,
            error: null,
            costsVisible: false,
            hasGaps: false,
          },
        ],
      },
    },
  )
  const heading = await screen.findByRole('heading', { name: 'Task total' })
  const card = heading.closest('.card')!
  expect(within(card as HTMLElement).getAllByText('—').length).toBeGreaterThan(0)
  expect(within(card as HTMLElement).queryByText('¥0')).toBeNull()
  expect(screen.getByText('Project costs hidden')).toBeTruthy()
  expect(screen.getByText('Awaiting initial sync')).toBeTruthy()
})
test('read failures have a retry and the empty state remains explicit', async () => {
  const f = fixture(search, { error: true })
  const retry = await screen.findByRole('button', { name: '重试' })
  f.state.error = false
  f.state.empty = true
  fireEvent.click(retry)
  expect(await screen.findByText('该时间范围内没有可见任务')).toBeTruthy()
})
test('shared lanes keep a common axis and a missing end never becomes a fabricated bar', () => {
  const select = vi.fn()
  const { container } = render(
    <ExecutionSwimlane
      label="Intervals"
      rowHeading="Attempt"
      timeHeading="0–100"
      unknownLabel="Unknown"
      from={0}
      to={100}
      onSelect={select}
      rows={[
        { id: 'one', label: 'One', start: 25, end: 75, description: 'Open One', detail: '50 ms' },
        { id: 'two', label: 'Two', start: 10, end: null, description: 'Open Two', detail: '' },
      ]}
    />,
  )
  const bar = container.querySelector<HTMLElement>('.execution-swimlane__bar')!
  expect(bar.style.left).toBe('25%')
  expect(bar.style.width).toBe('50%')
  expect(container.querySelectorAll('.execution-swimlane__bar')).toHaveLength(1)
  const button = screen.getByRole('button', { name: 'Open Two' })
  button.focus()
  fireEvent.click(button)
  expect(select).toHaveBeenCalledWith('two', button)
  expect(screen.getByText('Unknown')).toBeTruthy()
})
test('CNY presentation preserves exact large values, tiny nonzero amounts and real zero', () => {
  expect(formatObservationCny(null)).toBe('—')
  expect(formatObservationCny('0')).toBe('¥0')
  expect(formatObservationCny('0.000000000001')).toBe('<¥0.000001')
  expect(formatObservationCny('9007199254740993.9999999')).toBe('¥9007199254740994')
})
