// RFC-371: the formal surface reads a sealed full report; display pages never become statistics.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  CompleteObservationDimension,
  CompleteObservationMetrics,
  CompleteObservationReport,
  CompleteObservationReportPage,
  CompleteObservationTask,
  HostExecutionStatus,
  ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { CompleteRunObservability } from '../src/components/observability/CompleteRunObservability'
import { HostExecutionProvider } from '../src/hooks/useHostExecutionAvailability'
import { observationLocalDateInput } from '../src/components/observability/observationCustomRange'
import type { ObservationSearch } from '../src/components/observability/RunObservability'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'

const NOW = Date.parse('2026-10-03T00:00:00Z')
const initial: ObservationSearch = { from: 0, to: NOW + 1, period: 'all', tab: 'tasks' }
const metrics: Extract<CompleteObservationMetrics, { state: 'ready' }> = {
  state: 'ready',
  invocations: '10001',
  observedInvocations: '10001',
  records: '20001',
  tokens: {
    input: '9007199254740993',
    cacheRead: '30003',
    cacheWrite: '50005',
    output: '70007',
    total: '9007199254891008',
  },
  cost: { currency: 'CNY', state: 'complete', amount: '2500.75005' },
}
const taskRow = (id: string, name: string): CompleteObservationTask => ({
  task: {
    id,
    name,
    status: 'done',
    parentTaskId: null,
    startedAt: NOW - 10000,
    finishedAt: NOW,
    runningMs: 3000,
    runningSince: null,
  },
  metrics,
  attemptCount: '1001',
  timing: {
    wallMs: '10000',
    runningMs: '3000',
    range: { from: NOW - 10000, to: NOW },
    intervals: { state: 'complete', cumulativeMs: '20000', activeUnionMs: '8000', unknown: '0' },
  },
})
type Ready = Extract<CompleteObservationReport, { state: 'ready' }>
const taskName = (id: string) =>
  id === 'parent'
    ? '父任务'
    : id === 'child'
      ? '子任务'
      : id === 'grandchild'
        ? '孙任务'
        : '任务 ' + id.replace('task-', '')
function ready(
  filters: ObservationOverviewQuery,
  taskId: string | null,
  unknownTiming = false,
): Ready {
  const root = taskId ? taskRow(taskId, taskName(taskId)) : null
  return {
    state: 'ready',
    header: {
      reportId: crypto.randomUUID(),
      projectionVersion: 2,
      generation: 'original-generation',
      snapshotId: 'original-snapshot',
      asOf: NOW,
      sourceRevision: 'original-revision',
      actorScope: 'reader',
      authorizationRevision: 'original-access',
      filters,
      taskId,
    },
    summary: {
      metrics,
      ...(filters.cohort === 'usage'
        ? {
            usageWindow: {
              candidateTasks: '1001',
              timingBasis: 'task-lifecycle' as const,
              partitions: {
                'in-window': { records: metrics.records, metrics },
                'outside-window': { records: '0', metrics: { state: 'not-applicable' as const } },
                'unassigned-time': { records: '0', metrics: { state: 'not-applicable' as const } },
              },
            },
          }
        : {}),
      inventory: {
        tasks: taskId ? '2' : '1001',
        attempts: '1001',
        invocations: '10001',
        numericRecords: '20001',
        nativeCaptures: '2001',
      },
      statuses: { done: '1001' },
      timing: {
        wallMs: unknownTiming ? '0' : '10000',
        runningMs: unknownTiming ? '0' : '3000',
        p50Ms: '1000',
        p95Ms: '2000',
        unknown: '0',
      },
      rootTask:
        root && unknownTiming
          ? { ...root, timing: { ...root.timing, wallMs: null, runningMs: null } }
          : root,
    },
    counts: { tasks: taskId ? '2' : '1001', agents: '1', trends: '1', 'dimension-tasks': '1' },
  }
}
const agent: CompleteObservationDimension = {
  key: 'original-agent',
  kind: 'agent',
  label: '实现 Agent',
  selection: { agent: { id: 'original-agent', revision: 3 } },
  metrics,
  taskCount: '1',
}
function fixture(
  search = initial,
  options: {
    unknownTiming?: boolean
    building?: boolean
    hostStatus?: HostExecutionStatus
    holdHostStatus?: boolean
  } = {},
) {
  const requests: { path: string; method: string; after: string | null; report: string | null }[] =
    []
  const reports = new Map<string, Ready>()
  const state = {
    missing: false,
    pageFailureReportId: null as string | null,
    holdAgentRevision: null as string | null,
    releaseAgentPage: null as (() => void) | null,
    releaseHostStatus: null as (() => void) | null,
    holdHostStatus: options.holdHostStatus ?? false,
    building: options.building ?? false,
    projection: null as { revision: string; asOf: number } | null,
    releaseReport: null as (() => void) | null,
    holdReport: false,
    abortedReports: 0,
  }
  const changes: ObservationSearch[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET'
    requests.push({
      path: url.pathname,
      method,
      after: url.searchParams.get('after'),
      report: url.pathname.split('/')[4] ?? null,
    })
    if (url.pathname === '/api/execution/status' && method === 'GET') {
      if (!options.hostStatus) throw new Error('Unexpected host status request')
      if (state.holdHostStatus)
        await new Promise<void>((resolve) => {
          state.releaseHostStatus = resolve
        })
      return Response.json(options.hostStatus)
    }
    if (url.pathname === '/api/observability/anomalies' && method === 'GET')
      return Response.json({ items: [], total: '0', nextCursor: null, asOf: Date.now() })
    if (url.pathname === '/api/observability/projection-version' && method === 'GET')
      return Response.json(state.projection)
    if (url.pathname === '/api/observability/reports' && method === 'POST') {
      const request = JSON.parse(String(init?.body)) as {
        filters: ObservationOverviewQuery
        taskId?: string
      }
      const original = ready(request.filters, request.taskId ?? null, options.unknownTiming)
      const value: Ready = state.projection
        ? {
            ...original,
            header: {
              ...original.header,
              asOf: state.projection.asOf,
              sourceRevision: state.projection.revision,
            },
          }
        : original
      reports.set(value.header.reportId, value)
      if (state.holdReport)
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal
          const abort = () => {
            state.abortedReports++
            reject(new DOMException('superseded projection', 'AbortError'))
          }
          state.releaseReport = () => {
            signal?.removeEventListener('abort', abort)
            resolve()
          }
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      return Response.json(
        state.building
          ? { state: 'building', reportId: value.header.reportId, phase: 'collecting' }
          : value,
      )
    }
    const match = /^\/api\/observability\/reports\/([^/]+)(\/pages)?$/.exec(url.pathname)
    if (!match) throw new Error('Unexpected legacy API: ' + url.pathname)
    const report = reports.get(decodeURIComponent(match[1]!))!
    if (!match[2])
      return Response.json(
        state.missing
          ? {
              state: 'not-ready',
              reportId: report.header.reportId,
              gaps: ['missing-original-record'],
            }
          : state.building
            ? { state: 'building', reportId: report.header.reportId, phase: 'collecting' }
            : report,
      )
    if (state.missing || state.pageFailureReportId === report.header.reportId)
      return Response.json(
        { error: { code: 'report-changed', message: 'missing retained record' } },
        { status: 409 },
      )
    const section = url.searchParams.get('section')!,
      parent = url.searchParams.get('parent')
    expect(url.searchParams.get('limit')).toBe('100')
    const total = report.counts[section as keyof typeof report.counts] ?? '0'
    let items: unknown[] = [],
      nextCursor: string | null = null
    if (section === 'tasks') {
      const offset = Number(url.searchParams.get('after')?.replace('opaque-', '') ?? '0')
      items = Array.from({ length: Math.min(100, Number(total) - offset) }, (_, i) =>
        taskRow('task-' + (offset + i), '任务 ' + (offset + i)),
      )
      if (offset + items.length < Number(total)) nextCursor = 'opaque-' + (offset + items.length)
    } else if (section === 'agents') {
      items = [agent]
      if (
        state.holdAgentRevision !== null &&
        state.holdAgentRevision === report.header.sourceRevision
      )
        await new Promise<void>((resolve) => {
          state.releaseAgentPage = resolve
        })
    } else if (section === 'dimension-tasks') {
      const id = report.header.taskId === 'parent' ? 'child' : 'grandchild'
      items = [taskRow(id, taskName(id))]
    } else if (section === 'trends')
      items = [{ key: '2026-10-03', from: 0, to: NOW + 1, tasks: '1001', metrics }]
    const page: CompleteObservationReportPage<unknown> = {
      reportId: report.header.reportId,
      section: section as CompleteObservationReportPage<unknown>['section'],
      parent,
      items,
      total,
      nextCursor,
    }
    return Response.json(page)
  })
  function Page() {
    const [value, setValue] = useState(search)
    return (
      <CompleteRunObservability
        search={value}
        onChange={(next) => {
          changes.push(next)
          setValue(next)
        }}
      />
    )
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      {options.hostStatus ? (
        <HostExecutionProvider>
          <Page />
        </HostExecutionProvider>
      ) : (
        <Page />
      )}
    </QueryClientProvider>,
  )
  return { requests, reports, state, changes, client }
}
beforeEach(async () => {
  setBaseUrl('http://complete.test')
  setToken('test')
  await i18n.changeLanguage('zh')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('formal route uses the complete report surface and keeps the legacy regression owner separate', () => {
  const route = readFileSync(
    resolve(import.meta.dirname, '../src/routes/observability.tsx'),
    'utf8',
  )
  expect(route).toContain('<CompleteRunObservability')
  expect(route).not.toContain('<RunObservability')
})
test('period changes share the real cutoff and returning to a finished period reads the same report without another build', async () => {
  const f = fixture({ ...initial, period: 'week', from: initial.to - 7 * 86400000 })
  await screen.findByRole('button', { name: '任务 0' })
  const original = [...f.reports.values()][0]!
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 3600_000)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('runObservability.month') }))
  await waitFor(() => expect(f.reports.size).toBe(2))
  expect(f.changes.at(-1)).toMatchObject({
    period: 'month',
    from: initial.to - 30 * 86400000,
    to: initial.to,
  })
  vi.mocked(Date.now).mockReturnValue(NOW + 7200_000)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('runObservability.week') }))
  await waitFor(() =>
    expect(
      f.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.path === '/api/observability/reports/' + original.header.reportId,
      ),
    ).toBe(true),
  )
  expect(f.reports.size).toBe(2)
  expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(2)
  expect(f.changes.at(-1)).toMatchObject({
    period: 'week',
    from: initial.to - 7 * 86400000,
    to: initial.to,
  })
})
test('the first committed projection activates the same pending report handle', async () => {
  const f = fixture({ ...initial, tab: 'overview' }, { building: true })
  await waitFor(() => expect(f.reports.size).toBe(1))
  const original = [...f.reports.values()][0]!
  f.state.building = false
  f.state.projection = { revision: '1', asOf: NOW }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await screen.findByRole('heading', { name: '完整 Token 消耗' })
  expect(f.reports.size).toBe(1)
  expect(f.requests.filter((row) => row.method === 'POST')).toHaveLength(1)
  expect(
    f.requests.some(
      (row) => row.method === 'GET' && row.path.endsWith('/' + original.header.reportId),
    ),
  ).toBe(true)
  expect(f.changes).toHaveLength(0)
})
test('automatic cutoff advancement retains exact four buckets, CNY and the old asOf until replacement', async () => {
  const f = fixture({ ...initial, period: 'week', tab: 'overview' })
  await screen.findByRole('heading', { name: '完整 Token 消耗' })
  f.state.projection = { revision: '1', asOf: NOW }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() => expect(f.reports.size).toBe(2))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  )
  f.state.holdReport = true
  f.state.projection = { revision: '2', asOf: NOW + 3600000 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() => expect(f.changes.at(-1)?.to).toBe(NOW + 3600001))
  await waitFor(() => expect(f.state.releaseReport).not.toBeNull())
  const summary = screen
    .getByRole('heading', { name: '完整 Token 消耗' })
    .closest<HTMLElement>('.card')!
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
    expect(summary.querySelector('[data-token-bucket="' + bucket + '"] dd')?.textContent).toBe(
      BigInt(metrics.tokens[bucket]).toLocaleString('zh'),
    )
  expect(
    screen.getByRole('heading', { name: '人民币估值' }).closest('.card')?.textContent,
  ).toContain('¥2500.75005')
  expect(
    screen.getByText(
      i18n.t('runObservability.completeAsOf', { time: new Date(NOW).toLocaleString('zh') }),
    ),
  ).toBeTruthy()
  expect(screen.getByText(i18n.t('runObservability.refreshingPrevious'))).toBeTruthy()
  f.state.holdReport = false
  f.state.releaseReport!()
  await screen.findByText(
    i18n.t('runObservability.completeAsOf', { time: new Date(NOW + 3600000).toLocaleString('zh') }),
  )
  expect(screen.queryByText(i18n.t('runObservability.refreshingPrevious'))).toBeNull()
})
test.each(['week', 'month', 'all'] as const)(
  'formal %s refresh advances its cutoff, clears pagination and builds current data',
  async (period) => {
    const f = fixture({ ...initial, period, after: 'old-page' })
    await screen.findByRole('button', { name: '任务 0' })
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 7200_000)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(f.reports.size).toBe(2))
    expect(f.changes.at(-1)).toMatchObject({
      to: NOW + 7200_001,
      after: undefined,
      from: period === 'all' ? 0 : NOW + 7200_001 - (period === 'week' ? 7 : 30) * 86400000,
    })
    expect([...f.reports.values()].at(-1)!.header.filters.to).toBe(NOW + 7200_001)
  },
)
test('all 1001 Tasks remain reachable with frozen exact totals, four buckets and CNY', async () => {
  const f = fixture({ ...initial, tab: 'overview' })
  const total = BigInt(metrics.tokens.total).toLocaleString('zh')
  await screen.findByRole('heading', { name: '完整 Token 消耗' })
  const activeTab = screen.getByRole('tab', { selected: true })
  const activePanel = screen.getByRole('tabpanel')
  expect(activeTab.getAttribute('aria-controls')).toBe(activePanel.id)
  expect(activePanel.getAttribute('aria-labelledby')).toBe(activeTab.id)
  const summary = screen
    .getByRole('heading', { name: '完整 Token 消耗' })
    .closest<HTMLElement>('.card')!
  expect(within(summary).getByText(total)).toBeTruthy()
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
    expect(summary.querySelector('[data-token-bucket="' + bucket + '"] dd')?.textContent).toBe(
      BigInt(metrics.tokens[bucket]).toLocaleString('zh'),
    )
  }
  expect(
    screen.getByRole('heading', { name: '人民币估值' }).closest('.card')?.textContent,
  ).toContain('¥2500.75005')
  fireEvent.click(screen.getByRole('tab', { name: '任务追踪' }))
  expect(document.querySelector('.observation-summary')).toBeNull()
  const visited = new Set<string>()
  for (let page = 0; page < 11; page++) {
    await screen.findByRole('button', { name: '任务 ' + page * 100 })
    for (const node of document.querySelectorAll<HTMLElement>('[data-observation-task]'))
      visited.add(node.dataset.observationTask!)
    expect(summary.textContent).toContain(total)
    expect(document.querySelector('.observation-summary')).toBeNull()
    const next = screen.getByRole('button', { name: '下一页' })
    if (page < 10) fireEvent.click(next)
    else expect((next as HTMLButtonElement).disabled).toBe(true)
  }
  expect(visited.size).toBe(1001)
  expect(
    f.requests.every(
      (row) =>
        row.path.startsWith('/api/observability/reports') ||
        (row.path === '/api/observability/projection-version' && row.method === 'GET'),
    ),
  ).toBe(true)
  expect(screen.queryByRole('button', { name: /CSV|更多筛选|需要关注/ })).toBeNull()
})
test('losing one retained record hides old totals while the original report is checked', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: '任务 0' })
  f.state.missing = true
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByText(i18n.t('runObservability.noIncompleteTotals'))
  expect(screen.queryByRole('heading', { name: '完整 Token 消耗' })).toBeNull()
  expect(screen.queryByText(BigInt(metrics.tokens.total).toLocaleString('zh'))).toBeNull()
})
test('task Agent contributions use their Task report and return to the parent contribution', async () => {
  const f = fixture({ ...initial, task: 'parent' })
  await screen.findByRole('heading', { name: '父任务' })
  fireEvent.click(await screen.findByRole('button', { name: /实现 Agent/ }))
  const dialog = await screen.findByRole('dialog', { name: '实现 Agent' })
  expect(dialog.classList.contains('observation-typography')).toBe(true)
  expect(dialog.closest('[data-complete-observation]')).toBeNull()
  fireEvent.click(await within(dialog).findByRole('button', { name: '子任务' }))
  await screen.findByRole('heading', { name: '子任务' })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /返回上级任务/ }))
  await screen.findByRole('heading', { name: '父任务' })
  await screen.findByRole('dialog', { name: '实现 Agent' })
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-observation-task')).toBe('child'),
  )
  expect([...f.reports.values()].every((row) => row.header.taskId !== null)).toBe(true)
  expect([...f.reports.values()].filter((row) => row.header.taskId === 'parent')).toHaveLength(1)
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-observation-dimension')).toBe(agent.key),
  )
})
test('overview renders exact Token data as bars and opens the matching complete cohort', async () => {
  const f = fixture({ ...initial, tab: 'overview' })
  const bucket = await screen.findByRole('button', {
    name: /1,001 个任务.*9,007,199,254,891,008 Token/,
  })
  expect(bucket.querySelectorAll('.observation-trend__segment').length).toBe(4)
  expect(
    [...bucket.querySelectorAll('.observation-trend__segment')].map((row) =>
      row.getAttribute('data-token-color'),
    ),
  ).toEqual(['input', 'cacheRead', 'cacheWrite', 'output'])
  expect(bucket.getAttribute('aria-label')).toContain('缓存读取 30,003')
  fireEvent.focus(bucket)
  const selected = screen.getByRole('group', { name: '当前趋势区间' })
  expect(
    [...selected.querySelectorAll('[data-token-bucket] dd')].map((row) => row.textContent),
  ).toEqual(
    (['input', 'cacheRead', 'cacheWrite', 'output'] as const).map((key) =>
      BigInt(metrics.tokens[key]).toLocaleString('zh-CN'),
    ),
  )
  fireEvent.click(bucket)
  await screen.findByRole('button', { name: '任务 0' })
  expect(f.changes.at(-1)).toMatchObject({ tab: 'tasks', period: 'custom', from: 0, to: NOW + 1 })
})
test('the existing segmented control selects consumption windows and Task drill-down preserves a full lifecycle report and original return scope', async () => {
  const f = fixture({
    ...initial,
    tab: 'overview',
    q: 'Original',
    repository: '/original',
    cohort: undefined,
  })
  const mode = await screen.findByRole('radiogroup', { name: '消耗时间口径' })
  expect(screen.getByRole('group', { name: '任务创建时间' })).toBeDefined()
  fireEvent.keyDown(within(mode).getByRole('radio', { name: '任务全程' }), { key: 'ArrowRight' })
  await waitFor(() =>
    expect([...f.reports.values()].some((r) => r.header.filters.cohort === 'usage')).toBe(true),
  )
  const usageReport = [...f.reports.values()].find((r) => r.header.filters.cohort === 'usage')!
  expect(usageReport.header.filters).toMatchObject({
    from: initial.from,
    to: initial.to,
    q: 'Original',
    repository: '/original',
  })
  expect(
    (await screen.findByRole('radio', { name: '窗口内消耗' })).getAttribute('aria-checked'),
  ).toBe('true')
  expect(screen.getByRole('group', { name: '消耗发生时间' })).toBeDefined()
  expect(screen.queryByRole('group', { name: '任务创建时间' })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: '任务追踪' }))
  const trigger = await screen.findByRole('button', { name: '任务 0' })
  fireEvent.click(trigger)
  await screen.findByRole('button', { name: '← 返回统计分析' })
  await screen.findByText('此处显示任务全程消耗；返回后恢复原窗口内统计。')
  const fullTask = [...f.reports.values()].find((r) => r.header.taskId === 'task-0')!
  expect(fullTask.header.filters.cohort).toBeUndefined()
  expect(fullTask.summary.usageWindow).toBeUndefined()
  expect(screen.getByText('此处显示任务全程消耗；返回后恢复原窗口内统计。')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: '← 返回统计分析' }))
  await screen.findByRole('button', { name: '任务 0' })
  expect(f.changes.at(-1)).toMatchObject({
    cohort: 'usage',
    q: 'Original',
    repository: '/original',
    from: initial.from,
    to: initial.to,
  })
  expect(
    [...f.reports.values()].filter(
      (r) => r.header.taskId === null && r.header.filters.cohort === 'usage',
    ),
  ).toHaveLength(1)
  fireEvent.click(screen.getByRole('tab', { name: '总览' }))
  fireEvent.keyDown(await screen.findByRole('radio', { name: '窗口内消耗' }), { key: 'ArrowLeft' })
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: '任务全程' }).getAttribute('aria-checked')).toBe(
      'true',
    ),
  )
  expect(screen.getByRole('group', { name: '任务创建时间' })).toBeDefined()
  expect(screen.queryByRole('group', { name: '消耗发生时间' })).toBeNull()
})

test('capture page controls belong to their shared Card without adding another card boundary', async () => {
  fixture({ ...initial, task: 'parent' })
  await screen.findByRole('heading', { name: '父任务' })
  for (const key of ['nativeCaptureTitle', 'platformCaptureTitle']) {
    const heading = await screen.findByRole('heading', {
      name: i18n.t('runObservability.' + key),
    })
    const card = heading.closest('.card')!
    await waitFor(() =>
      expect(within(card as HTMLElement).getByRole('button', { name: '下一页' })).toBeDefined(),
    )
    const body = card.querySelector('.card__body')!
    expect(body.querySelectorAll('.card')).toHaveLength(0)
    expect(body.querySelectorAll('.complete-observation-pager')).toHaveLength(1)
    for (const key of ['first', 'previous', 'next']) {
      expect(
        (
          within(body as HTMLElement).getByRole('button', {
            name: i18n.t('runObservability.' + key),
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true)
    }
  }
})

test('a child refresh and another descendant retain both ancestor reports and restore real dimension triggers', async () => {
  const f = fixture({ ...initial, task: 'parent' })
  await screen.findByRole('heading', { name: '父任务' })
  fireEvent.click(await screen.findByRole('button', { name: '实现 Agent' }))
  fireEvent.click(
    await within(await screen.findByRole('dialog')).findByRole('button', { name: '子任务' }),
  )
  await screen.findByRole('heading', { name: '子任务' })
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() =>
    expect([...f.reports.values()].filter((row) => row.header.taskId === 'child')).toHaveLength(2),
  )
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  )
  fireEvent.click(await screen.findByRole('button', { name: '实现 Agent' }))
  fireEvent.click(
    await within(await screen.findByRole('dialog')).findByRole('button', { name: '孙任务' }),
  )
  await screen.findByRole('heading', { name: '孙任务' })
  fireEvent.click(screen.getByRole('button', { name: /返回上级任务/ }))
  await screen.findByRole('heading', { name: '子任务' })
  await screen.findByRole('dialog', { name: '实现 Agent' })
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-observation-task')).toBe('grandchild'),
  )
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-observation-dimension')).toBe(agent.key),
  )
  fireEvent.click(screen.getByRole('button', { name: /返回上级任务/ }))
  await screen.findByRole('heading', { name: '父任务' })
  await screen.findByRole('dialog', { name: '实现 Agent' })
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-observation-task')).toBe('child'),
  )
  expect([...f.reports.values()].filter((row) => row.header.taskId === 'parent')).toHaveLength(1)
  expect([...f.reports.values()].filter((row) => row.header.taskId === 'child')).toHaveLength(2)
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-observation-dimension')).toBe(agent.key),
  )
})
test('returning from a Task preserves the full report, current display page and row focus', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: '任务 0' })
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  fireEvent.click(await screen.findByRole('button', { name: '任务 100' }))
  await screen.findByRole('heading', { name: '任务 100' })
  const back = screen.getByRole('button', { name: /返回统计分析/ })
  expect(back.classList.contains('page__heading-back')).toBe(true)
  fireEvent.click(back)
  await screen.findByRole('button', { name: '任务 100' })
  expect(screen.queryByRole('button', { name: '任务 0' })).toBeNull()
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-observation-task')).toBe('task-100'),
  )
  expect([...f.reports.values()].filter((row) => row.header.taskId === null)).toHaveLength(1)
})
test('unknown root Task wall and running durations stay unknown instead of becoming a cohort zero', async () => {
  fixture({ ...initial, task: 'parent' }, { unknownTiming: true })
  await screen.findByRole('heading', { name: '父任务' })
  expect(screen.getByText('任务墙钟').nextElementSibling?.textContent).toBe('—')
  expect(screen.getByText('任务运行态历时').nextElementSibling?.textContent).toBe('—')
})
test('a Task opens its whole tree and returning preserves the exact parent dimension URL', async () => {
  const selection = JSON.stringify(agent.selection)
  const f = fixture({ ...initial, selection })
  fireEvent.click(await screen.findByRole('button', { name: '任务 0' }))
  await screen.findByRole('heading', { name: '任务 0' })
  const selected = [...f.reports.values()].find((row) => row.header.taskId === 'task-0')
  expect(selected?.header.filters.selection).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: /返回统计分析/ }))
  await screen.findByRole('button', { name: '任务 0' })
  expect(f.changes.at(-1)?.selection).toBe(selection)
  const whole = [...f.reports.values()].filter((row) => row.header.taskId === null)
  expect(whole).toHaveLength(1)
  expect(whole[0]?.header.filters.selection).toBe(selection)
})

// Continuous committed updates can cancel a pending read without invalidating the displayed, accepted version.
test('a superseded automatic read cannot clear the previous four buckets, CNY or asOf', async () => {
  const f = fixture({ ...initial, period: 'week', tab: 'overview' })
  await screen.findByRole('heading', { name: '完整 Token 消耗' })
  f.state.projection = { revision: '1', asOf: NOW }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() => expect(f.reports.size).toBe(2))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  )
  f.state.holdReport = true
  f.state.projection = { revision: '2', asOf: NOW + 3600000 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() => expect(f.reports.size).toBe(3))
  f.state.projection = { revision: '3', asOf: NOW + 7200000 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() => expect(f.state.abortedReports).toBeGreaterThan(0))
  await waitFor(() => expect(f.reports.size).toBe(4))
  const summary = screen.getByRole('heading', { name: '完整 Token 消耗' }).closest('.card')!
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
    expect(summary.querySelector('[data-token-bucket="' + bucket + '"] dd')?.textContent).toBe(
      BigInt(metrics.tokens[bucket]).toLocaleString('zh'),
    )
  expect(
    screen.getByRole('heading', { name: '人民币估值' }).closest('.card')?.textContent,
  ).toContain('¥2500.75005')
  expect(
    screen.getByText(
      i18n.t('runObservability.completeAsOf', { time: new Date(NOW).toLocaleString('zh') }),
    ),
  ).toBeTruthy()
  expect(screen.getByText(i18n.t('runObservability.refreshingPrevious'))).toBeTruthy()
  f.state.holdReport = false
  f.state.releaseReport!()
  await screen.findByText(
    i18n.t('runObservability.completeAsOf', { time: new Date(NOW + 7200000).toLocaleString('zh') }),
  )
})

// RFC-371: a background cutoff must not truncate untouched milliseconds while
// the operator edits a CS-style date row; data still updates within that range.
test('live increments refresh the edited window without moving its cutoff, then Apply keeps the untouched exact endpoint', async () => {
  const cutoff = NOW + 12345
  const originalSearch: ObservationSearch = {
    ...initial,
    period: 'week',
    from: cutoff - 7 * 86400000,
    to: cutoff,
    tab: 'overview',
  }
  const f = fixture(originalSearch)
  await screen.findByRole('heading', { name: '完整 Token 消耗' })
  f.state.projection = { revision: '1', asOf: cutoff - 1 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() => expect(f.reports.size).toBe(2))
  const changedFrom = observationLocalDateInput(originalSearch.from - 86400000)
  fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: changedFrom } })
  expect(f.changes).toHaveLength(0)
  f.state.projection = { revision: '2', asOf: cutoff + 60000 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await screen.findByText(
    i18n.t('runObservability.completeAsOf', {
      time: new Date(cutoff + 60000).toLocaleString('zh'),
    }),
  )
  expect(f.changes).toHaveLength(0)
  expect((screen.getByLabelText('开始时间') as HTMLInputElement).value).toBe(changedFrom)
  expect((screen.getByLabelText('结束时间') as HTMLInputElement).value).toBe(
    observationLocalDateInput(cutoff),
  )
  fireEvent.click(screen.getByRole('button', { name: '应用时间范围' }))
  await waitFor(() =>
    expect(f.changes.at(-1)).toMatchObject({
      period: 'custom',
      from: Date.parse(changedFrom),
      to: cutoff,
    }),
  )
  await waitFor(() =>
    expect([...f.reports.values()].at(-1)?.header.filters).toMatchObject({
      from: Date.parse(changedFrom),
      to: cutoff,
    }),
  )
  f.state.projection = { revision: '3', asOf: cutoff + 120000 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await screen.findByText(
    i18n.t('runObservability.completeAsOf', {
      time: new Date(cutoff + 120000).toLocaleString('zh'),
    }),
  )
  expect(f.changes).toHaveLength(1)
  const summary = screen.getByRole('heading', { name: '完整 Token 消耗' }).closest('.card')!
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
    expect(summary.querySelector('[data-token-bucket="' + bucket + '"] dd')?.textContent).toBe(
      BigInt(metrics.tokens[bucket]).toLocaleString('zh'),
    )
  expect(
    screen.getByRole('heading', { name: '人民币估值' }).closest('.card')?.textContent,
  ).toContain('¥2500.75005')
})

// Leaving the date editor for a Task must release the parent's cutoff pause.
test('editing then opening a Task and returning releases the live window for the next committed revision', async () => {
  const cutoff = NOW + 12345
  const originalSearch: ObservationSearch = {
    ...initial,
    period: 'week',
    from: cutoff - 7 * 86400000,
    to: cutoff,
  }
  const f = fixture(originalSearch)
  await screen.findByRole('button', { name: '任务 0' })
  f.state.projection = { revision: '1', asOf: cutoff - 1 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() => expect(f.reports.size).toBe(2))
  fireEvent.change(screen.getByLabelText('开始时间'), {
    target: { value: observationLocalDateInput(originalSearch.from - 86400000) },
  })
  fireEvent.click(screen.getByRole('button', { name: '任务 0' }))
  const back = await screen.findByRole('button', { name: '← 返回统计分析' })
  expect(screen.queryByLabelText('开始时间')).toBeNull()
  fireEvent.click(back)
  await screen.findByRole('button', { name: '任务 0' })
  expect((screen.getByLabelText('开始时间') as HTMLInputElement).value).toBe(
    observationLocalDateInput(originalSearch.from),
  )
  f.state.projection = { revision: '2', asOf: cutoff + 60000 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() =>
    expect(f.changes.at(-1)).toMatchObject({
      period: 'week',
      from: cutoff + 60001 - 7 * 86400000,
      to: cutoff + 60001,
    }),
  )
  expect(f.changes.at(-1)?.task).toBeUndefined()
})

// Actual acceptance found a background publication dismissing the user's
// open contribution even when the Task/window was unchanged.
test('a background projection keeps the open contribution on its labelled immutable snapshot and explicit close still restores focus', async () => {
  const f = fixture({ ...initial, task: 'parent' })
  await screen.findByRole('heading', { name: '父任务' })
  fireEvent.click(await screen.findByRole('button', { name: '实现 Agent' }))
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('button', { name: '子任务' })
  const snapshot = within(dialog).getByText(
    i18n.t('runObservability.asOf', { time: new Date(NOW).toLocaleString(i18n.language) }),
  ).textContent
  const count = f.reports.size
  f.state.projection = { revision: '3', asOf: NOW + 1000 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() => expect(f.reports.size).toBeGreaterThan(count))
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(dialog.textContent).toContain(snapshot)
  expect(within(dialog).getByRole('button', { name: '子任务' })).toBeTruthy()
  fireEvent.click(within(dialog).getAllByRole('button', { name: '关闭' }).at(-1)!)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-observation-dimension')).toBe(agent.key),
  )
})

// Pause the actual new dimension page after its immutable report is ready.
// The existing fast-path regression above remains unchanged.
test.each([
  ['agent-page', 'restore'],
  ['agent-page', 'user-input'],
  ['report', 'restore'],
  ['report', 'user-input'],
] as const)(
  'closing a retained contribution during delayed %s respects %s',
  async (phase, mode) => {
    const f = fixture({ ...initial, task: 'parent' })
    await screen.findByRole('heading', { name: '父任务' })
    fireEvent.click(await screen.findByRole('button', { name: '实现 Agent' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('button', { name: '子任务' })
    const snapshot = within(dialog).getByText(
      i18n.t('runObservability.asOf', { time: new Date(NOW).toLocaleString(i18n.language) }),
    ).textContent
    const count = f.reports.size
    if (phase === 'agent-page') f.state.holdAgentRevision = '3'
    else f.state.holdReport = true
    f.state.projection = { revision: '3', asOf: NOW + 1000 }
    await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
    await waitFor(() => expect(f.reports.size).toBeGreaterThan(count))
    await waitFor(() =>
      expect(
        phase === 'agent-page' ? f.state.releaseAgentPage : f.state.releaseReport,
      ).not.toBeNull(),
    )
    const oldTrigger = document.querySelector('[data-observation-dimension="original-agent"]')
    if (phase === 'agent-page') expect(oldTrigger).toBeNull()
    else expect(oldTrigger).not.toBeNull()
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(dialog.textContent).toContain(snapshot)
    expect(within(dialog).getByRole('button', { name: '子任务' })).toBeTruthy()
    fireEvent.click(within(dialog).getAllByRole('button', { name: '关闭' }).at(-1)!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const page = document.querySelector('[data-complete-observation]') as HTMLElement
    await waitFor(() =>
      expect(document.activeElement).toBe(phase === 'agent-page' ? page : oldTrigger),
    )
    const back = screen.getByRole('button', { name: '← 返回统计分析' })
    if (mode === 'user-input') {
      fireEvent.keyDown(window, { key: 'Tab' })
      back.focus()
      expect(document.activeElement).toBe(back)
    }
    if (phase === 'agent-page') {
      f.state.holdAgentRevision = null
      f.state.releaseAgentPage!()
    } else {
      f.state.holdReport = false
      f.state.releaseReport!()
    }
    await screen.findByText(
      i18n.t('runObservability.completeAsOf', {
        time: new Date(NOW + 1000).toLocaleString(i18n.language),
      }),
    )
    const replacement = await screen.findByRole('button', { name: '实现 Agent' })
    if (mode === 'restore') await waitFor(() => expect(document.activeElement).toBe(replacement))
    else expect(document.activeElement).toBe(back)
    expect(f.reports.size).toBe(count + 1)
    const summary = screen.getByRole('heading', { name: '任务整体' }).closest('.card')!
    for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
      expect(summary.querySelector('[data-token-bucket="' + bucket + '"] dd')?.textContent).toBe(
        BigInt(metrics.tokens[bucket]).toLocaleString('zh'),
      )
    expect(summary.textContent).toContain('¥2500.75005')
  },
)

// A retained contribution must also observe its own report validity after the
// main page moves to a newer projection; the newer report remains independent.
test('an old contribution page failure withdraws that snapshot after a new projection without withdrawing the new main report', async () => {
  const f = fixture({ ...initial, task: 'parent' })
  await screen.findByRole('heading', { name: '父任务' })
  const original = [...f.reports.values()][0]!
  fireEvent.click(await screen.findByRole('button', { name: '实现 Agent' }))
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('button', { name: '子任务' })
  f.state.projection = { revision: '3', asOf: NOW + 1000 }
  await f.client.invalidateQueries({ queryKey: ['run-observability-projection-version'] })
  await waitFor(() => expect(f.reports.size).toBe(2))
  expect(screen.getByRole('dialog')).toBe(dialog)
  f.state.pageFailureReportId = original.header.reportId
  await f.client.invalidateQueries({
    queryKey: ['run-observability-complete-page', original.header.reportId],
  })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('heading', { name: '父任务' })).toBeTruthy()
  const summary = screen.getByRole('heading', { name: '任务整体' }).closest('.card')!
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
    expect(summary.querySelector('[data-token-bucket="' + bucket + '"] dd')?.textContent).toBe(
      BigInt(metrics.tokens[bucket]).toLocaleString('zh'),
    )
  expect(summary.textContent).toContain('¥2500.75005')
  expect(f.reports.size).toBe(2)
})

test.each<HostExecutionStatus>([
  { mode: 'native', status: null },
  {
    mode: 'execution',
    status: {
      phase: 'active',
      generation: 'original-host-generation',
      readyGroups: ['observation'],
      reason: null,
    },
  },
])(
  'a late %s selected-host status resumes the formal report without a manual retry',
  async (hostStatus) => {
    const f = fixture(initial, { hostStatus, holdHostStatus: true })
    await waitFor(() => expect(f.state.releaseHostStatus).toBeTypeOf('function'))
    await waitFor(() =>
      expect(
        f.requests.some(
          (row) => row.path === '/api/observability/projection-version' && row.method === 'GET',
        ),
      ).toBe(true),
    )
    expect(f.reports.size).toBe(0)
    expect(f.requests.filter((row) => row.method === 'POST')).toHaveLength(0)
    f.state.holdHostStatus = false
    f.state.releaseHostStatus!()
    await screen.findByRole('button', { name: '任务 0' })
    expect(f.reports.size).toBe(1)
    expect(f.requests.filter((row) => row.method === 'POST')).toHaveLength(1)
    expect(screen.queryByText(i18n.t('hostExecution.checking'))).toBeNull()
  },
)
