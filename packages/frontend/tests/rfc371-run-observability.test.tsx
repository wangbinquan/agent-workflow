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
import { ObservationPlatformCapture } from '../src/components/observability/ObservationPlatformCapture'
import { Metrics } from '../src/components/observability/ObservationMetrics'
import { ObservationPlatformNativeCaptureSchema } from '@agent-workflow/shared'
import { observationRuntimeKey } from '@agent-workflow/shared'
import { validateObservationSearch } from '../src/routes/observability'
import nativeCapture from '../../shared/tests/fixtures/crewstation-native-capture-v2.json'
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
    changes: ObservationSearch[] = [],
    state = {
      error: false,
      empty: false,
      detail: detail(),
      overview: overview(),
      ...options,
    }
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
test('run views have no CSV export operation', async () => {
  const f = fixture({ ...search, tab: 'agents', agent: '["agent-1",3,"task"]' })
  await screen.findByRole('heading', { name: '该 Agent 的任务贡献' })
  expect(screen.queryByRole('button', { name: /CSV|导出/ })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: '性能与数据质量' }))
  await screen.findByRole('heading', { name: '用量与估值的数据质量' })
  expect(screen.queryByRole('button', { name: /CSV|导出/ })).toBeNull()
  expect(f.paths.every((url) => !url.pathname.includes('/exports'))).toBe(true)
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
  const f = fixture({ ...search, after: 'old-page', workflow: 'workflow-1' })
  await screen.findByRole('button', { name: '真实任务' })
  fireEvent.change(screen.getByRole('textbox', { name: '任务名称或 ID' }), {
    target: { value: '真实任务' },
  })
  await waitFor(() => expect(f.paths.at(-1)?.searchParams.get('q')).toBe('真实任务'))
  expect(f.paths.at(-1)?.searchParams.has('after')).toBe(false)
  fireEvent.change(screen.getByRole('textbox', { name: '仓库' }), {
    target: { value: '/team/repo' },
  })
  expect(screen.queryByRole('textbox', { name: /工作流 ID/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /更多筛选/ })).toBeNull()
  expect(screen.getByText('关联工作流：workflow-1')).toBeTruthy()
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

function runtimeMetrics(total: string, amount: string | null): ObservationMetrics {
  const base = metrics()
  return {
    ...base,
    invocations: 1,
    observedInvocations: 1,
    tokens: {
      ...base.tokens,
      known: { ...base.tokens.known, input: total },
      totalKnown: total,
      complete: true,
    },
    cost: {
      ...base.cost,
      knownAmount: amount,
      complete: amount !== null,
      reasons: amount === null ? ['not-authorized'] : [],
      priceVersionIds: amount === null ? [] : ['frozen-CNY'],
    },
    authorities: ['local'],
  }
}
function runtimeOverview(): ObservationOverview {
  const base = overview()
  const whole = {
    ...runtimeMetrics('1000', '9'),
    invocations: 2,
    observedInvocations: 2,
    records: 2,
  }
  return {
    ...base,
    metrics: whole,
    tasks: [{ ...base.tasks[0]!, metrics: whole }],
    runtimes: [
      {
        authority: 'local',
        sourceId: null,
        registrationId: 'opaque-registration-A',
        configurationRevision: 7,
        protocol: 'opencode',
        acceptedNames: ['original-name'],
        unnamedInvocations: 0,
        metrics: runtimeMetrics('300', '1.25'),
        tasks: [{ taskId: task.id, metrics: runtimeMetrics('300', '1.25') }],
      },
      {
        authority: 'local',
        sourceId: null,
        registrationId: 'opaque-registration-B',
        configurationRevision: 8,
        protocol: 'opencode',
        acceptedNames: ['other-name'],
        unnamedInvocations: 0,
        metrics: runtimeMetrics('700', '7.75'),
        tasks: [{ taskId: task.id, metrics: runtimeMetrics('700', '7.75') }],
      },
    ],
  }
}

test.each(['zh-CN', 'en-US'])(
  'runtime Dialog shows its own contribution and returns from whole-task detail with context and focus in %s',
  async (language) => {
    await i18n.changeLanguage(language)
    const data = runtimeOverview()
    const f = fixture(
      { ...search, tab: 'usage', q: '真实任务', repository: '/team/repo' },
      { overview: data, detail: { ...detail(), metrics: data.metrics } },
    )
    const opener = await screen.findByRole('button', {
      name: /(?:查看运行时贡献|View runtime contributions) · original-name/,
    })
    expect(opener.className).toContain('task-operations__name')
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('opaque-registration-A')
    const table = within(dialog).getByRole('table')
    expect(within(table).getByText('300')).toBeTruthy()
    expect(within(table).getByText('¥1.25')).toBeTruthy()
    expect(within(dialog).queryByText('1,000')).toBeNull()
    expect(within(dialog).queryByText('¥9')).toBeNull()
    const body = dialog.querySelector<HTMLElement>('.dialog__body')!
    body.scrollTop = 137
    fireEvent.click(within(table).getByRole('button', { name: '真实任务' }))
    await screen.findByRole('heading', { name: language === 'zh-CN' ? '任务整体' : 'Task total' })
    expect(screen.getAllByText('1,000').length).toBeGreaterThan(0)
    fireEvent.click(
      screen.getByRole('button', {
        name: language === 'zh-CN' ? '返回统计分析' : 'Back to analysis',
      }),
    )
    const returned = await screen.findByRole('dialog')
    const restored = within(returned).getByRole('button', { name: '真实任务' })
    await waitFor(() => expect(document.activeElement).toBe(restored))
    expect(returned.querySelector<HTMLElement>('.dialog__body')!.scrollTop).toBe(137)
    expect(f.changes.at(-1)).toMatchObject({
      from: search.from,
      to: search.to,
      tab: 'usage',
      runtime: observationRuntimeKey(data.runtimes[0]!),
      q: '真实任务',
      repository: '/team/repo',
    })
    expect(f.paths.filter((url) => url.pathname === '/api/observability/overview')).toHaveLength(1)
    expect(f.paths.every((url) => !url.searchParams.has('runtime'))).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(
      screen.getByRole('button', {
        name: /(?:查看运行时贡献|View runtime contributions) · original-name/,
      }),
    )
    fireEvent.change(
      screen.getByRole('textbox', {
        name: language === 'zh-CN' ? '任务名称或 ID' : 'Task name or ID',
      }),
      { target: { value: 'new-scope' } },
    )
    expect(f.changes.at(-1)?.runtime).toBeUndefined()
  },
)

test('legacy runtime responses show missing names and unavailable task contributions without substituting whole-task metrics', async () => {
  const data = runtimeOverview(),
    original = data.runtimes[0]!
  const { acceptedNames: _names, tasks: _tasks, ...legacy } = original
  fixture(
    { ...search, tab: 'usage' },
    { overview: { ...data, runtimes: [{ ...legacy, unnamedInvocations: 1 }] } },
  )
  fireEvent.click(
    await screen.findByRole('button', { name: '查看运行时贡献 · 受理时未记录运行时名称' }),
  )
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('opaque-registration-A')).toBeTruthy()
  expect(within(dialog).getByText(/1 次调用在受理时未记录名称/)).toBeTruthy()
  expect(within(dialog).getByText(/当前响应未提供运行时的任务贡献/)).toBeTruthy()
  expect(within(dialog).queryByRole('table')).toBeNull()
  expect(within(dialog).queryByText('1,000')).toBeNull()
})

test('an absent runtime key has an explicit empty Dialog and a stable close focus target', async () => {
  fixture({ ...search, tab: 'usage', runtime: 'missing-runtime-key' })
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('该运行时不在当前统计范围中')).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect((document.activeElement as HTMLElement).getAttribute('tabindex')).toBe('-1')
})

test('runtime URL keys are bounded display state and do not alter server query validation', () => {
  const runtime = observationRuntimeKey(runtimeOverview().runtimes[0]!)
  expect(validateObservationSearch({ ...search, tab: 'usage', runtime }).runtime).toBe(runtime)
  for (const runtime of ['', ' ', 'x'.repeat(2049), 42])
    expect(validateObservationSearch({ ...search, runtime }).runtime).toBeUndefined()
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
    columns.map((column) => column.querySelector('.observation-trend__value')?.textContent),
  ).toEqual(['18,014,398,509,481,986', '≥ 9,007,199,254,740,993', '0', '—'])
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
test('overview omits the attention card for both failed and empty task sets', async () => {
  for (const tasks of [
    [{ task: { ...task, status: 'failed' }, metrics: metrics(), wallMs: 10000, runningMs: 5000 }],
    [],
  ]) {
    fixture({ ...search, tab: 'overview' }, { overview: { ...overview(), tasks } })
    await screen.findByRole('heading', { name: '任务用量趋势' })
    expect(screen.queryByRole('region', { name: '需要关注的任务' })).toBeNull()
    expect(screen.queryByText('在任务中心查看全部')).toBeNull()
    cleanup()
  }
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

test('platform turn details use the shared dialog and return focus to the last row in both languages', async () => {
  const capture = ObservationPlatformNativeCaptureSchema.parse(nativeCapture.capture)
  const rows = Array.from({ length: 30 }, (_, index) => ({
    invocationId: 'invocation-' + index,
    nodeRunId: 'attempt-' + index,
    sourceId: 'cs-installation',
    schemaVersion: 2 as const,
    capture: {
      ...capture,
      id: 'capture-' + index,
      proof: { ...capture.proof, turn: 'turn-' + index },
    },
    issues: [],
  }))
  for (const language of ['zh-CN', 'en-US']) {
    await i18n.changeLanguage(language)
    const view = render(<ObservationPlatformCapture rows={rows} />)
    const last = screen
      .getAllByRole('button', { name: i18n.t('runObservability.nativeCaptureDetails') })
      .at(-1)!
    // WebKit mouse clicks do not focus buttons: return must use the actual trigger.
    fireEvent.click(last)
    const dialog = await screen.findByRole('dialog', {
      name: i18n.t('runObservability.platformCaptureTitle'),
    })
    expect(within(dialog).getByText('turn-29')).toBeTruthy()
    expect(within(dialog).getByText(i18n.t('runObservability.nativeUnresolved'))).toBeTruthy()
    expect(within(dialog).getByText(i18n.t('runObservability.nativeCorrected'))).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(last))
    expect(
      screen.getAllByRole('button', { name: i18n.t('runObservability.nativeCaptureDetails') }),
    ).toHaveLength(30)
    view.unmount()
  }
})

test('an empty proven tree displays all four zero buckets while unobserved usage keeps dashes', () => {
  const value = metrics({
    records: 0,
    observedInvocations: 1,
    tokens: { ...metrics().tokens, hasKnown: true, complete: true },
  })
  const view = render(<Metrics value={value} />)
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(
      screen.getByText(i18n.t('runObservability.' + key)).nextElementSibling?.textContent,
    ).toBe('0')
  view.rerender(
    <Metrics
      value={{
        ...value,
        observedInvocations: 0,
        tokens: { ...value.tokens, hasKnown: false, complete: false },
      }}
    />,
  )
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(
      screen.getByText(i18n.t('runObservability.' + key)).nextElementSibling?.textContent,
    ).toBe('—')
})
