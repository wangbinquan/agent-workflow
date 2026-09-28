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
    collection: {
      retainedRecords: 0,
      pendingRecords: 0,
      firstObservedAt: null,
      lastObservedAt: null,
      tasks: [],
      platforms: [],
    },
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
        platformProjectId: 'cs-project',
        platformTaskId: 'cs-task',
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
    exports: unknown[] = [],
    changes: ObservationSearch[] = [],
    state = {
      error: false,
      empty: false,
      exportError: false,
      detail: detail(),
      overview: overview(),
      ...options,
    }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const url = new URL(String(raw))
    paths.push(url)
    if (url.pathname === '/api/observability/exports/snapshot') {
      expect(init?.method).toBe('POST')
      exports.push(JSON.parse(String(init?.body)))
      return state.exportError
        ? Response.json(
            { error: { code: 'unavailable', message: 'Export offline' } },
            { status: 503 },
          )
        : Response.json({
            filename: `aw-observations-agents-${search.from}-${search.to}.csv`,
            mediaType: 'text/csv;charset=utf-8',
            content: '\ufeff"tokens","cost_cny"\r\n"10","0"\r\n',
            asOf: NOW,
            rows: 1,
            partial: true,
            bounded: true,
          })
    }
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
  return { paths, changes, state, exports }
}
test('CSV downloads the selected agent revision, resets feedback on view changes and preserves read data on failure', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:observation-export')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const downloads: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download)
  })
  const agent = '["agent-1",3,"task"]'
  const f = fixture({ ...search, tab: 'agents', agent })
  await screen.findByRole('heading', { name: '该 Agent 的任务贡献' })
  fireEvent.click(screen.getByRole('button', { name: '导出当前快照 CSV' }))
  await screen.findByText(/已生成 1 行/)
  expect(f.exports).toEqual([
    {
      window: {
        from: search.from,
        to: search.to,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      view: 'agents',
      agent,
    },
  ])
  expect(downloads).toEqual([`aw-observations-agents-${search.from}-${search.to}.csv`])
  expect((create.mock.calls[0]![0] as Blob).type).toBe('text/csv;charset=utf-8')
  expect(await (create.mock.calls[0]![0] as Blob).text()).toContain('"10","0"')
  expect(screen.getByText(/CSV 中已标明部分统计/)).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '性能与数据质量' }))
  await screen.findByRole('heading', { name: '用量与估值的数据质量' })
  expect(screen.queryByText(/已生成 1 行/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '估值待同步 · 1' }))
  f.state.exportError = true
  fireEvent.click(screen.getByRole('button', { name: '导出当前快照 CSV' }))
  await screen.findByRole('button', { name: '重试' })
  expect(f.exports.at(-1)).toMatchObject({ view: 'tasks', quality: 'pending' })
  expect(f.exports.at(-1)).not.toHaveProperty('agent')
  expect(downloads).toHaveLength(1)
  expect(screen.getByRole('button', { name: '真实任务' })).toBeTruthy()
})
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

test('native capture distinguishes pending, empty completed scans and historical revisions without claiming new spend', async () => {
  const value = detail(),
    before = { usage: { input: '10', output: '0', cacheRead: null, cacheWrite: '0' }, model: null }
  fixture(
    { ...search, task: 'task-1' },
    {
      detail: {
        ...value,
        nativeCaptures: [
          {
            invocationId: 'pending-call',
            nodeRunId: 'pending-run',
            state: 'pending',
            priorRevisionGap: false,
            proof: null,
          },
          {
            invocationId: 'empty-call',
            nodeRunId: 'empty-run',
            state: 'complete',
            priorRevisionGap: false,
            proof: {
              contract: 'opencode-child-steps-v1',
              nativeSource: 'db',
              rootSessionId: 'empty-root',
              state: 'complete',
              baseline: { kind: 'fresh', fingerprint: null },
              snapshotFingerprint: 'scan',
              observedAt: NOW,
              scannedSessions: 1,
              scannedSteps: 0,
              issues: [],
              priorRevisions: [],
            },
          },
          {
            invocationId: 'revised-call',
            nodeRunId: 'revised-run',
            state: 'partial',
            priorRevisionGap: true,
            proof: {
              contract: 'opencode-child-steps-v1',
              nativeSource: 'db',
              rootSessionId: 'root',
              state: 'partial',
              baseline: { kind: 'resume', fingerprint: 'before' },
              snapshotFingerprint: 'after',
              observedAt: NOW,
              scannedSessions: 2,
              scannedSteps: 1,
              issues: ['native-prior-revision-gap'],
              priorRevisions: [
                {
                  sessionId: 'child',
                  stepId: 'historical-step',
                  before,
                  after: { ...before, usage: { ...before.usage, input: '20' } },
                },
              ],
            },
          },
        ],
      },
    },
  )
  await screen.findByRole('heading', { name: '原生子 Agent 采集' })
  expect(screen.getByText('等待最终子树采集')).toBeTruthy()
  expect(screen.getByText('最终扫描已投影')).toBeTruthy()
  expect(screen.getByText('1 / 0')).toBeTruthy()
  const trigger = screen.getByRole('button', { name: '查看历史步骤修订' })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: '查看历史步骤修订' })
  expect(within(dialog).getByText('historical-step')).toBeTruthy()
  expect(within(dialog).getByText('10 → 20')).toBeTruthy()
  expect(within(dialog).getAllByText('0 → 0')).toHaveLength(2)
  expect(within(dialog).getAllByText('未观测 → 未观测')).toHaveLength(2)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
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
test('task filters reach list and analysis queries, survive drill-down and reset pagination', async () => {
  const f = fixture({ ...search, after: 'old-page' })
  await screen.findByRole('button', { name: '真实任务' })
  fireEvent.change(screen.getByRole('textbox', { name: '任务名称或 ID' }), {
    target: { value: '真实任务' },
  })
  await waitFor(() => expect(f.paths.at(-1)?.searchParams.get('q')).toBe('真实任务'))
  expect(f.paths.at(-1)?.searchParams.has('after')).toBe(false)
  fireEvent.change(screen.getByRole('textbox', { name: '仓库' }), {
    target: { value: '/team/repo' },
  })
  fireEvent.change(screen.getByRole('textbox', { name: '工作流 ID' }), {
    target: { value: 'workflow-1' },
  })
  fireEvent.click(screen.getByRole('combobox', { name: '执行状态' }))
  fireEvent.mouseDown(await screen.findByRole('option', { name: i18n.t('tasks.status.running') }))
  await waitFor(() => expect(f.paths.at(-1)?.searchParams.get('status')).toBe('running'))
  fireEvent.click(screen.getByRole('tab', { name: '总览' }))
  await screen.findByRole('heading', { name: '任务用量趋势' })
  expect(f.paths.at(-1)?.pathname).toBe('/api/observability/overview')
  for (const [key, value] of Object.entries({
    q: '真实任务',
    repository: '/team/repo',
    workflow: 'workflow-1',
    status: 'running',
  }))
    expect(f.paths.at(-1)?.searchParams.get(key)).toBe(value)
  fireEvent.click(screen.getAllByRole('button', { name: '真实任务' })[0]!)
  await screen.findByRole('heading', { name: '任务整体' })
  fireEvent.click(screen.getByRole('button', { name: '返回统计分析' }))
  await screen.findByRole('heading', { name: '任务用量趋势' })
  expect((screen.getByRole('textbox', { name: '仓库' }) as HTMLInputElement).value).toBe(
    '/team/repo',
  )
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
  await waitFor(() => expect(f.paths.at(-1)?.searchParams.has('q')).toBe(false))
  expect(f.paths.at(-1)?.searchParams.has('repository')).toBe(false)
  expect(f.paths.at(-1)?.searchParams.has('workflow')).toBe(false)
  expect(f.paths.at(-1)?.searchParams.has('status')).toBe(false)
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
// User requested vertical columns matching CS; preserve exact large totals, zero and unknown semantics.
test('trend columns scale exact large totals and expose focused interval details without treating unknown as zero', async () => {
  const data: ObservationOverview = {
    ...overview(),
    trend: ['18014398509481986', '9007199254740993', '0', null].map((total, i) => {
      const value = metrics()
      return {
        from: search.from + i * 86400000,
        to: search.from + (i + 1) * 86400000,
        taskCount: i + 1,
        metrics: {
          ...value,
          tokens: {
            ...value.tokens,
            known: { ...value.tokens.known, input: total ?? '0' },
            totalKnown: total ?? '0',
            hasKnown: total !== null,
            complete: i === 0 || i === 2,
          },
          cost: {
            ...value.cost,
            knownAmount: ['0.000000000001', '9007199254740993.9999999', '0', null][i]!,
            reasons: i === 3 ? ['not-authorized'] : ['pending'],
          },
        },
      }
    }),
  }
  const f = fixture({ ...search, tab: 'overview' }, { overview: data })
  const chart = await screen.findByRole('list', { name: '任务用量趋势' })
  const columns = within(chart).getAllByRole('button')
  expect(columns).toHaveLength(4)
  expect(
    columns.map(
      (button) => (button.querySelector('.observation-trend__bar') as HTMLElement).style.height,
    ),
  ).toEqual(['100%', '50%', '0%', '0%'])
  expect(columns[1]!.getAttribute('aria-label')).toContain('9007199254740993 Token · 部分数据')
  expect(columns[2]!.getAttribute('aria-label')).toContain('0 Token')
  expect(columns[3]!.getAttribute('aria-label')).toContain('未观测 Token')
  expect(columns[0]!.title).toContain('¥0.000000000001')
  expect(columns[1]!.getAttribute('aria-label')).toContain('¥9007199254740993.9999999')
  expect(columns[3]!.title).not.toContain('部分桶未定价')
  const detail = screen.getByRole('group', { name: '当前趋势区间' })
  fireEvent.focus(columns[1]!)
  expect(within(detail).getByText('9,007,199,254,740,993')).toBeTruthy()
  expect(detail.textContent).toContain('2 个任务')
  expect(detail.textContent).toContain('¥9007199254740993.9999999')
  fireEvent.mouseEnter(columns[3]!)
  expect(within(detail).getByText('未观测')).toBeTruthy()
  fireEvent.click(columns[1]!)
  await waitFor(() =>
    expect(f.changes.at(-1)).toMatchObject({
      from: data.trend[1]!.from,
      to: data.trend[1]!.to,
      period: 'custom',
      tab: 'tasks',
    }),
  )
})
test('attention is a five-item action summary with real causes, scope counts and task-center links', async () => {
  const statuses = [
    'failed',
    'running',
    'awaiting_review',
    'failed',
    'interrupted',
    'failed',
    'awaiting_human',
    'failed',
    'awaiting_human',
  ]
  const data: ObservationOverview = {
    ...overview(),
    partial: true,
    tasks: statuses.map((status, i) => ({
      task: {
        ...task,
        id: `attention-${i}`,
        name: `关注事项 ${i}`,
        status,
        startedAt: NOW - (9 - i) * 1000,
        errorSummary: status === 'failed' ? 'daemon-restart' : null,
      },
      metrics: metrics(),
      wallMs: 10000,
      runningMs: 5000,
    })),
  }
  const f = fixture({ ...search, tab: 'overview' }, { overview: data })
  const card = await screen.findByRole('region', { name: '需要关注的任务' })
  const rows = within(within(card).getByRole('list')).getAllByRole('listitem')
  expect(rows).toHaveLength(5)
  expect(rows.map((row) => within(row).getByRole('link').getAttribute('href'))).toEqual([
    '/tasks/attention-8',
    '/tasks/attention-6',
    '/tasks/attention-2',
    '/tasks/attention-7',
    '/tasks/attention-5',
  ])
  expect(within(rows[0]!).getByText('去回答')).toBeTruthy()
  expect(within(rows[2]!).getByText('去评审')).toBeTruthy()
  expect(within(rows[3]!).getByText(i18n.t('tasks.failure.summary.daemonRestart'))).toBeTruthy()
  expect(within(rows[3]!).getByText('查看失败')).toBeTruthy()
  expect(card.textContent).toContain('已加载范围内共 8 项，显示前 5 项')
  const counts = within(card).getByRole('group', { name: '当前已加载范围内的关注任务数' })
  for (const [status, count] of [
    ['awaiting_human', 2],
    ['awaiting_review', 1],
    ['failed', 4],
    ['interrupted', 1],
  ] as const)
    expect(counts.textContent).toContain(`${i18n.t(`tasks.status.${status}`)} ${count}`)
  const all = new URL(
    within(card).getByRole('link', { name: '在任务中心查看全部' }).getAttribute('href')!,
    'http://localhost',
  )
  expect(all.pathname).toBe('/tasks')
  expect(all.searchParams.get('statuses')!.split(',').sort()).toEqual([
    'awaiting_human',
    'awaiting_review',
    'failed',
    'interrupted',
  ])
  expect(all.searchParams.get('scope')).toBe('all')
  expect(all.searchParams.has('view')).toBe(false)
  expect(card.textContent).toContain('任务中心展示所有时间、仓库')
  expect(screen.getByText('当前为部分统计')).toBeTruthy()
  expect(f.paths.filter((path) => path.pathname === '/api/observability/overview')).toHaveLength(1)
  expect(f.paths.some((path) => path.pathname.startsWith('/api/tasks'))).toBe(false)
})
test('attention preserves unknown interruption and raw causes, with an explicit loaded-scope empty state', async () => {
  const data: ObservationOverview = {
    ...overview(),
    tasks: ['failed', 'interrupted', 'interrupted'].map((status, i) => ({
      task: {
        ...task,
        id: `cause-${i}`,
        status,
        errorSummary: i === 2 ? 'Worker disconnected while saving result' : null,
      },
      metrics: metrics(),
      wallMs: 10000,
      runningMs: 5000,
    })),
  }
  fixture({ ...search, tab: 'overview' }, { overview: data })
  const card = await screen.findByRole('region', { name: '需要关注的任务' })
  expect(within(card).getByText('任务执行失败，原因未记录。')).toBeTruthy()
  expect(within(card).getByText('执行已中断，原因未记录。')).toBeTruthy()
  expect(within(card).getByText('Worker disconnected while saving result')).toBeTruthy()
  cleanup()
  fixture({ ...search, tab: 'overview' })
  const empty = await screen.findByRole('region', { name: '需要关注的任务' })
  expect(within(empty).getByText('已加载任务中暂无待处理项')).toBeTruthy()
  expect(within(empty).queryByRole('list')).toBeNull()
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
test('collection status exposes pending evidence, unknown observation time and platform gaps with task drilldown', async () => {
  const data = overview()
  const f = fixture(
    { ...search, tab: 'performance', q: '真实' },
    {
      overview: {
        ...data,
        collection: {
          retainedRecords: 7,
          pendingRecords: 2,
          firstObservedAt: null,
          lastObservedAt: null,
          tasks: [
            {
              taskId: task.id,
              retainedRecords: 7,
              pendingRecords: 2,
              firstObservedAt: null,
              lastObservedAt: null,
            },
          ],
          platforms: [
            {
              taskId: task.id,
              sourceId: 'cs-installation',
              platformProjectId: 'cs-project',
              platformTaskId: 'failed-platform-task',
              status: 'failed',
              asOf: null,
              error: 'source-unavailable',
              costsVisible: false,
              hasGaps: true,
            },
            {
              taskId: task.id,
              sourceId: 'cs-installation',
              platformProjectId: 'cs-project',
              platformTaskId: 'ready-platform-task',
              status: 'ready',
              asOf: null,
              error: null,
              costsVisible: true,
              hasGaps: false,
            },
          ],
        },
      },
    },
  )
  const heading = await screen.findByRole('heading', { name: '采集与投影状态' })
  const card = within(heading.closest('.card') as HTMLElement)
  expect(card.getAllByText('7')).toHaveLength(2)
  expect(card.getAllByText('2')).toHaveLength(2)
  // Null collection times use the explicit unknown label for both bounds and the task row.
  expect(card.getAllByText('未观测')).toHaveLength(3)
  expect(screen.getByText('同步失败')).toBeTruthy()
  expect(screen.getByText('存在缺口')).toBeTruthy()
  const failedRow = screen.getByText('平台任务 failed-platform-task').closest('tr')!
  const readyRow = screen.getByText('平台任务 ready-platform-task').closest('tr')!
  expect(within(failedRow).getByText('同步失败')).toBeTruthy()
  expect(within(readyRow).getByText('同步就绪')).toBeTruthy()
  expect(screen.getByRole('heading', { name: '当前采集能力' })).toBeTruthy()
  fireEvent.click(card.getByRole('button', { name: '真实任务' }))
  await screen.findByRole('heading', { name: '任务整体' })
  expect(f.changes.at(-1)).toMatchObject({ tab: 'performance', q: '真实', task: task.id })
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
            platformProjectId: 'cs-project',
            platformTaskId: 'cs-task',
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
