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
  ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { CompleteRunObservability } from '../src/components/observability/CompleteRunObservability'
import type { ObservationSearch } from '../src/components/observability/RunObservability'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'

const NOW = Date.parse('2026-10-03T00:00:00Z')
const initial: ObservationSearch = { from: 0, to: NOW + 1, period: 'all', tab: 'tasks' }
const metrics: CompleteObservationMetrics = {
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
function fixture(search = initial, options: { unknownTiming?: boolean } = {}) {
  const requests: { path: string; method: string; after: string | null; report: string | null }[] =
    []
  const reports = new Map<string, Ready>()
  const state = { missing: false, building: false }
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
    if (url.pathname === '/api/observability/reports' && method === 'POST') {
      const request = JSON.parse(String(init?.body)) as {
        filters: ObservationOverviewQuery
        taskId?: string
      }
      const value = ready(request.filters, request.taskId ?? null, options.unknownTiming)
      reports.set(value.header.reportId, value)
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
          : report,
      )
    if (state.missing)
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
    } else if (section === 'agents') items = [agent]
    else if (section === 'dimension-tasks') {
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
      <Page />
    </QueryClientProvider>,
  )
  return { requests, reports, state, changes }
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
  expect(f.requests.every((row) => row.path.startsWith('/api/observability/reports'))).toBe(true)
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
