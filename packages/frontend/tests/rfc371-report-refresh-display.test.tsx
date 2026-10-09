// RFC-371: a same-scope refresh keeps a dated completed snapshot, never invalid old totals.
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  CompleteObservationReport,
  CompleteObservationTask,
  ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { completeObservationReportContent } from '@agent-workflow/shared'
import { CompleteRunObservability } from '../src/components/observability/CompleteRunObservability'
import {
  useCompleteObservationPage,
  useCompleteObservationReport,
} from '../src/components/observability/completeReportClient'
import { setBaseUrl, setToken } from '../src/stores/auth'
import {
  discardObservationReportBookmark,
  observationReportBookmark,
} from '../src/components/observability/completeReportBookmark'
import i18n from '../src/i18n'
import { Route, validateObservationSearch } from '../src/routes/observability'

const NOW = Date.parse('2026-10-09T00:00:00Z')
const filters: ObservationOverviewQuery = { from: NOW - 60000, to: NOW + 1, timezone: 'UTC' }
type Ready = Extract<CompleteObservationReport, { state: 'ready' }>
function ready(
  id: string,
  scope: ObservationOverviewQuery,
  taskId: string | null,
  delta = 0,
): Ready {
  return {
    state: 'ready',
    header: {
      reportId: id,
      projectionVersion: 2,
      generation: 'original-generation',
      snapshotId: 'original-snapshot-' + id,
      asOf: NOW + delta * 1000,
      sourceRevision: 'original-revision-' + id,
      actorScope: 'reader',
      authorizationRevision: 'original-access',
      filters: scope,
      taskId,
    },
    summary: {
      metrics: {
        state: 'ready',
        invocations: '1',
        observedInvocations: '1',
        records: '1',
        tokens: {
          input: String(12 + delta),
          cacheRead: String(34 + delta),
          cacheWrite: '0',
          output: String(56 + delta),
          total: String(102 + delta * 3),
        },
        cost: { currency: 'CNY', state: 'complete', amount: delta ? '0.132' : '0.102' },
      },
      inventory: {
        tasks: '1',
        attempts: '1',
        invocations: '1',
        numericRecords: '1',
        nativeCaptures: '0',
      },
      statuses: { done: '1' },
      timing: { wallMs: '1000', runningMs: '1000', p50Ms: '1000', p95Ms: '1000', unknown: '0' },
      rootTask: null,
    },
    counts: { tasks: '1', trends: '1' },
  }
}
let client: QueryClient
let fixtureSequence = 0
const bookmarkPrefix = 'agent-workflow.observation-complete-bookmark/13:'
function storedBookmarks(): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(bookmarkPrefix)) entries.push([key, localStorage.getItem(key)!])
  }
  return entries
}
function clearBookmarks() {
  for (const [key] of storedBookmarks()) localStorage.removeItem(key)
}
function fixture() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const fixtureId = ++fixtureSequence
  const reports: Ready[] = []
  const requests: { path: string; method: string; reportId?: string }[] = []
  const states = new Map<string, CompleteObservationReport>()
  const blocked = new Map<
    string,
    { promise: Promise<Response>; resolve: (value: Response) => void }
  >()
  const control = { firstBuilding: false, pageFailure: false }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET'
    const match = /^\/api\/observability\/reports\/([^/]+)(\/pages)?$/.exec(url.pathname)
    requests.push({ path: url.pathname, method, ...(match ? { reportId: match[1] } : {}) })
    if (url.pathname === '/api/observability/reports' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        filters: ObservationOverviewQuery
        taskId?: string
      }
      const report = ready(
        'refresh-report-' + fixtureId + '-' + reports.length,
        body.filters,
        body.taskId ?? null,
        reports.length ? 10 : 0,
      )
      reports.push(report)
      const value: CompleteObservationReport =
        reports.length === 1 && !control.firstBuilding
          ? report
          : { state: 'building', reportId: report.header.reportId, phase: 'collecting' }
      states.set(report.header.reportId, value)
      return Response.json(value)
    }
    if (!match) throw new Error('Unexpected report API: ' + url.pathname)
    const id = match[1]!,
      report = reports.find((value) => value.header.reportId === id)!
    if (!match[2]) return blocked.get(id)?.promise ?? Response.json(states.get(id))
    if (control.pageFailure && id === reports[0]!.header.reportId)
      return Response.json(
        { error: { code: 'report-changed', message: 'Original row missing' } },
        { status: 409 },
      )
    const section = url.searchParams.get('section')!,
      parent = url.searchParams.get('parent')
    const facts = completeObservationReportContent(states.get(id) ?? report) ?? report
    const task: CompleteObservationTask = {
      task: {
        id: 'original-task',
        name: '原任务 ' + id,
        status: 'done',
        parentTaskId: null,
        startedAt: NOW - 1000,
        finishedAt: NOW,
        runningMs: 1000,
        runningSince: null,
      },
      metrics: facts.summary.metrics,
      attemptCount: '1',
      timing: {
        wallMs: '1000',
        runningMs: '1000',
        range: { from: NOW - 1000, to: NOW },
        intervals: { state: 'complete', cumulativeMs: '1000', activeUnionMs: '1000', unknown: '0' },
      },
    }
    const items =
      section === 'tasks'
        ? [task]
        : section === 'trends'
          ? [
              {
                key: 'original-day',
                from: filters.from,
                to: filters.to,
                tasks: '1',
                metrics: facts.summary.metrics,
              },
            ]
          : []
    return Response.json({
      reportId: id,
      section,
      parent,
      total: facts.counts[section as keyof typeof facts.counts] ?? '0',
      items,
      nextCursor: null,
    })
  })
  return {
    reports,
    requests,
    states,
    control,
    block(id: string) {
      let resolve!: (value: Response) => void
      const promise = new Promise<Response>((done) => {
        resolve = done
      })
      blocked.set(id, { promise, resolve })
      return (
        value: CompleteObservationReport | { error: { code: string; message: string } },
        status = 200,
      ) => {
        blocked.delete(id)
        resolve(Response.json(value, { status }))
      }
    },
    async finish(value: CompleteObservationReport) {
      const id = value.state === 'ready' ? value.header.reportId : value.reportId
      states.set(id, value)
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['run-observability-complete'] })
      })
    },
  }
}
function Probe({ scope = filters, taskId }: { scope?: ObservationOverviewQuery; taskId?: string }) {
  const [revision, setRevision] = useState(0)
  const query = useCompleteObservationReport(scope, taskId, revision, true)
  const page = useCompleteObservationPage(query.displayContent, 'tasks')
  const value = query.displayContent
  return (
    <>
      <button disabled={query.busy} onClick={() => setRevision((value) => value + 1)}>
        刷新探针
      </button>
      <button onClick={() => void page.refetch()}>重新读取原明细</button>
      {value && (
        <output data-testid="snapshot">
          {JSON.stringify({
            id: value.header.reportId,
            asOf: value.header.asOf,
            metrics: value.summary.metrics,
          })}
        </output>
      )}
      {query.refreshingPrevious && <p>显示上次完成统计</p>}
    </>
  )
}
function mountProbe(props: { scope?: ObservationOverviewQuery; taskId?: string } = {}) {
  return render(
    <QueryClientProvider client={client}>
      <Probe {...props} />
    </QueryClientProvider>,
  )
}
beforeEach(async () => {
  clearBookmarks()
  setBaseUrl('http://report-refresh.test')
  setToken('test')
  await i18n.changeLanguage('zh')
})
afterEach(() => {
  cleanup()
  client?.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  clearBookmarks()
})

function remountProbe(
  view: ReturnType<typeof mountProbe>,
  props: { scope?: ObservationOverviewQuery; taskId?: string } = {},
) {
  view.unmount()
  client.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return mountProbe(props)
}

test.each(['ambient-digest', 'fallback-digest'] as const)(
  'a cold QueryClient with %s reads the original report and only an explicit refresh starts a new report',
  async (digest) => {
    if (digest === 'fallback-digest') {
      const original = globalThis.crypto
      vi.stubGlobal('crypto', {
        randomUUID: original.randomUUID.bind(original),
        getRandomValues: original.getRandomValues.bind(original),
      })
    }
    const f = fixture(),
      view = mountProbe()
    const old = (await screen.findByTestId('snapshot')).textContent
    const bookmark = await observationReportBookmark(filters, undefined)
    expect(bookmark.read()).toBe(f.reports[0]!.header.reportId)
    const stored = storedBookmarks()
    expect(stored).toHaveLength(1)
    expect(stored[0]![0]).toMatch(/13:[a-f0-9]{64}$/)
    expect(stored[0]![0]).not.toContain('test')
    expect(stored[0]![1]).toBe(f.reports[0]!.header.reportId)
    remountProbe(view)
    await screen.findByTestId('snapshot')
    const button = screen.getByRole('button', { name: '刷新探针' }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(screen.getByTestId('snapshot').textContent).toBe(old)
    expect(screen.queryByText('显示上次完成统计')).toBeNull()
    expect(f.reports).toHaveLength(1)
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    fireEvent.click(button)
    await screen.findByText('显示上次完成统计')
    await waitFor(() => expect(f.reports).toHaveLength(2))
    expect(screen.getByTestId('snapshot').textContent).toBe(old)
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(2)
    expect(
      f.requests.filter(
        (request) => request.method === 'GET' && request.path.endsWith(bookmark.read()!),
      ),
    ).toHaveLength(1)
    await f.finish(f.reports[1]!)
    await waitFor(() => expect(screen.getByTestId('snapshot').textContent).not.toBe(old))
    expect(screen.getByTestId('snapshot').textContent).toContain('"input":"22"')
    expect(screen.getByTestId('snapshot').textContent).toContain('"amount":"0.132"')
    expect(screen.queryByText('显示上次完成统计')).toBeNull()
    expect(bookmark.read()).toBe(f.reports[1]!.header.reportId)
    // A late rejection of the old ID cannot erase the newly completed pointer.
    discardObservationReportBookmark(f.reports[0]!.header.reportId)
    expect(bookmark.read()).toBe(f.reports[1]!.header.reportId)
  },
)

test('a cold incomplete report restores its known buckets, unknown cache bucket and partial CNY', async () => {
  const f = fixture()
  f.control.firstBuilding = true
  const view = mountProbe()
  await waitFor(() => expect(f.reports).toHaveLength(1))
  const original = f.reports[0]!
  await f.finish({
    state: 'not-ready',
    reportId: original.header.reportId,
    gaps: ['native-token-bucket-unknown'],
    facts: {
      header: original.header,
      counts: original.counts,
      summary: {
        ...original.summary,
        metrics: {
          state: 'not-ready',
          gaps: ['native-token-bucket-unknown'],
          recordedUsage: {
            invocations: '1',
            observedInvocations: '1',
            records: '1',
            bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '1' },
            tokens: { input: '12', cacheRead: null, cacheWrite: '0', output: '56', total: '68' },
          },
          costCoverage: {
            records: '1',
            pricedRecords: '0',
            partiallyPricedRecords: '1',
            visibility: 'visible',
          },
          recordedCost: {
            currency: 'CNY',
            amount: '0.068',
            records: '1',
            pricedRecords: '0',
            partiallyPricedRecords: '1',
          },
        },
      },
    },
  })
  const old = (await screen.findByTestId('snapshot')).textContent
  remountProbe(view)
  await screen.findByTestId('snapshot')
  const button = screen.getByRole('button', { name: '刷新探针' }) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  expect(screen.getByTestId('snapshot').textContent).toBe(old)
  expect(screen.queryByText('显示上次完成统计')).toBeNull()
  expect(f.reports).toHaveLength(1)
  expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  fireEvent.click(button)
  await screen.findByText('显示上次完成统计')
  await waitFor(() => expect(f.reports).toHaveLength(2))
  expect(screen.getByTestId('snapshot').textContent).toBe(old)
  expect(old).toContain('"cacheRead":null')
  expect(old).toContain('"amount":"0.068"')
  expect(old).toContain('native-token-bucket-unknown')
})

test.each(['failed', 'missing-facts'] as const)(
  'a failed background %s removes the captured restored bookmark',
  async (failure) => {
    const f = fixture(),
      view = mountProbe()
    await screen.findByTestId('snapshot')
    const bookmark = await observationReportBookmark(filters, undefined)
    remountProbe(view)
    await screen.findByTestId('snapshot')
    const button = screen.getByRole('button', { name: '刷新探针' }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(f.reports).toHaveLength(1)
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    fireEvent.click(button)
    await screen.findByText('显示上次完成统计')
    await waitFor(() => expect(f.reports).toHaveLength(2))
    const id = f.reports[1]!.header.reportId
    await f.finish(
      failure === 'failed'
        ? { state: 'failed', reportId: id, error: 'Original background failed', retryable: true }
        : { state: 'not-ready', reportId: id, gaps: ['missing-original-record'] },
    )
    await waitFor(() => expect(screen.queryByTestId('snapshot')).toBeNull())
    expect(bookmark.read()).toBeNull()
  },
)

test.each(['token', 'base', 'filters', 'task'] as const)(
  'a cold %s scope never restores another scope',
  async (changed) => {
    const f = fixture(),
      view = mountProbe()
    await screen.findByTestId('snapshot')
    if (changed === 'token') setToken('other-reader')
    if (changed === 'base') setBaseUrl('http://another-report.test')
    remountProbe(view, {
      ...(changed === 'filters' ? { scope: { ...filters, q: 'another scope' } } : {}),
      ...(changed === 'task' ? { taskId: 'another-task' } : {}),
    })
    await waitFor(() => expect(f.reports).toHaveLength(2))
    expect(screen.queryByTestId('snapshot')).toBeNull()
    expect(
      f.requests.filter(
        (request) =>
          request.method === 'GET' && request.path.endsWith(f.reports[0]!.header.reportId),
      ),
    ).toHaveLength(0)
    expect(screen.queryByText('显示上次完成统计')).toBeNull()
  },
)

test('an evicted original report falls back to a single normal complete generation', async () => {
  const f = fixture(),
    view = mountProbe()
  await screen.findByTestId('snapshot')
  const bookmark = await observationReportBookmark(filters, undefined),
    release = f.block(f.reports[0]!.header.reportId)
  remountProbe(view)
  await waitFor(() =>
    expect(f.requests.some((request) => request.path.endsWith(f.reports[0]!.header.reportId))).toBe(
      true,
    ),
  )
  await act(async () => {
    release({ error: { code: 'not-found', message: 'Evicted report' } }, 404)
  })
  await waitFor(() => expect(f.reports).toHaveLength(2))
  expect(bookmark.read()).toBeNull()
  expect(screen.queryByTestId('snapshot')).toBeNull()
  expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(2)
})

test.each(['403', '502', 'identity', 'filters', 'task', 'missing-content'] as const)(
  'a rejected restored %s cannot display numbers or start another report',
  async (failure) => {
    const f = fixture(),
      view = mountProbe()
    await screen.findByTestId('snapshot')
    const original = f.reports[0]!,
      bookmark = await observationReportBookmark(filters, undefined),
      release = f.block(original.header.reportId)
    remountProbe(view)
    await waitFor(() =>
      expect(f.requests.some((request) => request.path.endsWith(original.header.reportId))).toBe(
        true,
      ),
    )
    await act(async () => {
      if (failure === '403' || failure === '502')
        release(
          { error: { code: 'original-read-failed', message: 'Read failed' } },
          Number(failure),
        )
      else if (failure === 'missing-content')
        release({ state: 'not-ready', reportId: original.header.reportId, gaps: ['missing-facts'] })
      else
        release({
          ...original,
          header: {
            ...original.header,
            ...(failure === 'identity' ? { reportId: 'different-report' } : {}),
            ...(failure === 'filters' ? { filters: { ...filters, q: 'different' } } : {}),
            ...(failure === 'task' ? { taskId: 'different-task' } : {}),
          },
        })
    })
    const button = screen.getByRole('button', { name: '刷新探针' }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(screen.queryByTestId('snapshot')).toBeNull()
    expect(bookmark.read()).toBeNull()
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    fireEvent.click(button)
    await waitFor(() => expect(f.reports).toHaveLength(2))
    expect(screen.queryByTestId('snapshot')).toBeNull()
  },
)

test.each(['abort', 'identity-change'] as const)(
  'a restored continuation after %s cannot qualify or persist the old response',
  async (change) => {
    const f = fixture(),
      view = mountProbe()
    await screen.findByTestId('snapshot')
    const original = f.reports[0]!,
      bookmark = await observationReportBookmark(filters, undefined),
      release = f.block(original.header.reportId)
    remountProbe(view)
    await waitFor(() =>
      expect(f.requests.some((request) => request.path.endsWith(original.header.reportId))).toBe(
        true,
      ),
    )
    await act(async () => {
      if (change === 'abort')
        await client.cancelQueries({ queryKey: ['run-observability-complete'] })
      else setToken('changed-during-original-read')
      release(original)
    })
    await waitFor(() =>
      expect(client.isFetching({ queryKey: ['run-observability-complete'] })).toBe(0),
    )
    expect(screen.queryByTestId('snapshot')).toBeNull()
    expect(bookmark.read()).toBeNull()
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  },
)

test('unavailable bookmark storage uses the original cold path without an extra report read', async () => {
  const f = fixture(),
    view = mountProbe()
  await screen.findByTestId('snapshot')
  const originalGet = localStorage.getItem.bind(localStorage),
    originalSet = localStorage.setItem.bind(localStorage)
  vi.spyOn(localStorage, 'getItem').mockImplementation((key) => {
    if (key.startsWith(bookmarkPrefix)) throw new Error('Bookmark storage unavailable')
    return originalGet(key)
  })
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.startsWith(bookmarkPrefix)) throw new Error('Bookmark storage unavailable')
    return originalSet(key, value)
  })
  remountProbe(view)
  await waitFor(() => expect(f.reports).toHaveLength(2))
  expect(screen.queryByTestId('snapshot')).toBeNull()
  expect(
    f.requests.filter(
      (request) => request.method === 'GET' && request.path.endsWith(f.reports[0]!.header.reportId),
    ),
  ).toHaveLength(0)
  await f.finish(f.reports[1]!)
  expect((await screen.findByTestId('snapshot')).textContent).toContain(
    f.reports[1]!.header.reportId,
  )
})

test('an invalid old detail removes the persistent pointer across a cold QueryClient', async () => {
  const f = fixture(),
    view = mountProbe()
  await screen.findByTestId('snapshot')
  const bookmark = await observationReportBookmark(filters, undefined)
  f.control.pageFailure = true
  fireEvent.click(screen.getByRole('button', { name: '重新读取原明细' }))
  await waitFor(() => expect(screen.queryByTestId('snapshot')).toBeNull())
  expect(bookmark.read()).toBeNull()
  remountProbe(view)
  await waitFor(() => expect(f.reports).toHaveLength(2))
  expect(screen.queryByTestId('snapshot')).toBeNull()
  expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(2)
})

test('formal cold open reads the completed report and its dated buckets, CNY and bars without rebuilding', async () => {
  const f = fixture()
  const page = () => (
    <QueryClientProvider client={client}>
      <CompleteRunObservability
        search={{ ...filters, period: 'custom', tab: 'overview' }}
        onChange={() => {}}
      />
    </QueryClientProvider>
  )
  const view = render(page())
  await screen.findByRole('button', { name: /1 个任务.*102 Token/ })
  const originalId = f.reports[0]!.header.reportId
  const originalTime = screen.getByText(
    i18n.t('runObservability.completeAsOf', { time: new Date(NOW).toLocaleString('zh') }),
  ).textContent
  view.unmount()
  client.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const requestsBeforeOpen = f.requests.length
  render(page())
  await screen.findByRole('button', { name: /1 个任务.*102 Token/ })
  const refresh = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement
  await waitFor(() => expect(refresh.disabled).toBe(false))
  const tokenCard = screen
    .getByRole('heading', { name: '完整 Token 消耗' })
    .closest<HTMLElement>('.card')!
  expect(
    [...tokenCard.querySelectorAll('[data-token-bucket] dd')].map((node) => node.textContent),
  ).toEqual(['12', '34', '0', '56'])
  const costCard = screen
    .getByRole('heading', { name: i18n.t('runObservability.cost') })
    .closest<HTMLElement>('.card')!
  expect(within(costCard).getByText('¥0.102')).toBeTruthy()
  expect(screen.getByText(originalTime!)).toBeTruthy()
  expect(screen.queryByText(i18n.t('runObservability.refreshingPrevious'))).toBeNull()
  expect(f.reports).toHaveLength(1)
  expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  const reopenedRequests = f.requests.slice(requestsBeforeOpen)
  expect(reopenedRequests).toContainEqual({
    path: '/api/observability/reports/' + originalId,
    method: 'GET',
    reportId: originalId,
  })
  expect(reopenedRequests.some((request) => request.path.endsWith('/pages'))).toBe(true)
  expect(reopenedRequests.every((request) => request.reportId === originalId)).toBe(true)
})

test('formal refresh retains the dated four buckets, CNY and bars and blocks duplicate jobs until full replacement', async () => {
  const f = fixture()
  render(
    <QueryClientProvider client={client}>
      <CompleteRunObservability
        search={{ ...filters, period: 'custom', tab: 'overview' }}
        onChange={() => {}}
      />
    </QueryClientProvider>,
  )
  const card = (
    await screen.findByRole('heading', { name: '完整 Token 消耗' })
  ).closest<HTMLElement>('.card')!
  const values = () =>
    [...card.querySelectorAll('[data-token-bucket] dd')].map((node) => node.textContent)
  await screen.findByRole('button', { name: /1 个任务.*102 Token/ })
  expect(values()).toEqual(['12', '34', '0', '56'])
  const costs = within(
    screen
      .getByRole('heading', { name: i18n.t('runObservability.cost') })
      .closest<HTMLElement>('.card')!,
  )
  expect(costs.getByText('¥0.102')).toBeTruthy()
  const originalTime = screen.getByText(
    i18n.t('runObservability.completeAsOf', { time: new Date(NOW).toLocaleString('zh') }),
  ).textContent
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(f.reports).toHaveLength(2))
  await screen.findByText(i18n.t('runObservability.refreshingPrevious'))
  expect(values()).toEqual(['12', '34', '0', '56'])
  expect(costs.getByText('¥0.102')).toBeTruthy()
  expect(screen.getByText(originalTime!)).toBeTruthy()
  const refresh = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement
  expect(refresh.disabled).toBe(true)
  fireEvent.click(refresh)
  expect(f.requests.filter((row) => row.method === 'POST')).toHaveLength(2)
  await f.finish(f.reports[1]!)
  await costs.findByText('¥0.132')
  const newCard = screen
    .getByRole('heading', { name: '完整 Token 消耗' })
    .closest<HTMLElement>('.card')!
  expect(
    [...newCard.querySelectorAll('[data-token-bucket] dd')].map((node) => node.textContent),
  ).toEqual(['22', '44', '0', '66'])
  expect(costs.queryByText('¥0.102')).toBeNull()
  expect(screen.queryByText(originalTime!)).toBeNull()
  expect(screen.queryByText(i18n.t('runObservability.refreshingPrevious'))).toBeNull()
  expect(refresh.disabled).toBe(false)
  expect(f.requests.filter((row) => row.method === 'POST')).toHaveLength(2)
})

test('initial building, changed filters and another Task never display the previous scope', async () => {
  const f = fixture()
  f.control.firstBuilding = true
  const page = mountProbe()
  await waitFor(() => expect(f.reports).toHaveLength(1))
  expect(screen.queryByTestId('snapshot')).toBeNull()
  await f.finish(f.reports[0]!)
  await screen.findByTestId('snapshot')
  page.rerender(
    <QueryClientProvider client={client}>
      <Probe scope={{ ...filters, q: 'another scope' }} />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(f.reports).toHaveLength(2))
  expect(screen.queryByTestId('snapshot')).toBeNull()
  page.rerender(
    <QueryClientProvider client={client}>
      <Probe scope={filters} taskId="another-task" />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(f.reports).toHaveLength(3))
  expect(screen.queryByTestId('snapshot')).toBeNull()
  expect(f.reports[2]!.header.taskId).toBe('another-task')
})

test('same-report header GET keeps its verified snapshot while the request is in flight', async () => {
  const f = fixture()
  mountProbe()
  const old = (await screen.findByTestId('snapshot')).textContent
  const release = f.block(f.reports[0]!.header.reportId)
  let finished!: Promise<void>
  act(() => {
    finished = client.invalidateQueries({ queryKey: ['run-observability-complete'] })
  })
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '刷新探针' }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  )
  expect(screen.getByTestId('snapshot').textContent).toBe(old)
  await act(async () => {
    release(f.reports[0]!)
    await finished
  })
  expect(screen.getByTestId('snapshot').textContent).toBe(old)
  expect(f.requests.filter((row) => row.method === 'POST')).toHaveLength(1)
})

test('a qualified incomplete report retains known token buckets, the unknown cache bucket and partial CNY during refresh', async () => {
  const f = fixture()
  f.control.firstBuilding = true
  mountProbe()
  await waitFor(() => expect(f.reports).toHaveLength(1))
  const original = f.reports[0]!
  const partial: CompleteObservationReport = {
    state: 'not-ready',
    reportId: original.header.reportId,
    gaps: ['native-token-bucket-unknown'],
    facts: {
      header: original.header,
      counts: original.counts,
      summary: {
        ...original.summary,
        inventory: { tasks: '1', attempts: '1', invocations: '1' },
        metrics: {
          state: 'not-ready',
          gaps: ['native-token-bucket-unknown'],
          recordedUsage: {
            invocations: '1',
            observedInvocations: '1',
            records: '1',
            bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '1' },
            tokens: { input: '12', cacheRead: null, cacheWrite: '0', output: '56', total: '68' },
          },
          costCoverage: {
            records: '1',
            pricedRecords: '0',
            partiallyPricedRecords: '1',
            visibility: 'visible',
          },
          recordedCost: {
            currency: 'CNY',
            amount: '0.068',
            records: '1',
            pricedRecords: '0',
            partiallyPricedRecords: '1',
          },
        },
      },
    },
  }
  await f.finish(partial)
  const old = (await screen.findByTestId('snapshot')).textContent
  expect(old).toContain('"cacheRead":null')
  expect(old).toContain('"amount":"0.068"')
  fireEvent.click(screen.getByRole('button', { name: '刷新探针' }))
  await waitFor(() => expect(f.reports).toHaveLength(2))
  await screen.findByText('显示上次完成统计')
  expect(screen.getByTestId('snapshot').textContent).toBe(old)
})

test('an old detail failure removes the fallback even after its original query has been collected and a new header read is blocked', async () => {
  const f = fixture()
  mountProbe()
  await screen.findByTestId('snapshot')
  fireEvent.click(screen.getByRole('button', { name: '刷新探针' }))
  await waitFor(() => expect(f.reports).toHaveLength(2))
  await screen.findByText('显示上次完成统计')
  await waitFor(() =>
    expect(
      client.getQueryData(['run-observability-complete', 'scope-metrics/13', filters, null, 0]),
    ).toBeUndefined(),
  )
  const release = f.block(f.reports[1]!.header.reportId)
  f.control.pageFailure = true
  fireEvent.click(screen.getByRole('button', { name: '重新读取原明细' }))
  await waitFor(() => expect(screen.queryByTestId('snapshot')).toBeNull())
  expect(screen.queryByText('显示上次完成统计')).toBeNull()
  await act(async () => {
    release(f.reports[1]!)
  })
  const next = await screen.findByTestId('snapshot')
  expect(next.textContent).toContain(f.reports[1]!.header.reportId)
  expect(next.textContent).not.toContain(f.reports[0]!.header.reportId)
})

test.each(['failed', 'missing-facts'] as const)(
  'terminal %s removes prior numbers and a subsequent refresh cannot revive them',
  async (mode) => {
    const f = fixture()
    mountProbe()
    await screen.findByTestId('snapshot')
    fireEvent.click(screen.getByRole('button', { name: '刷新探针' }))
    await waitFor(() => expect(f.reports).toHaveLength(2))
    await screen.findByText('显示上次完成统计')
    const id = f.reports[1]!.header.reportId
    await f.finish(
      mode === 'failed'
        ? { state: 'failed', reportId: id, error: 'Original report failed', retryable: true }
        : { state: 'not-ready', reportId: id, gaps: ['missing-original-record'] },
    )
    await waitFor(() => expect(screen.queryByTestId('snapshot')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '刷新探针' }))
    await waitFor(() => expect(f.reports).toHaveLength(3))
    expect(screen.queryByTestId('snapshot')).toBeNull()
  },
)

test('a new report HTTP error cannot resurrect the previous snapshot', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const f = fixture()
    mountProbe()
    await screen.findByTestId('snapshot')
    // A restored report is visible while its header request is still settling.
    // Wait for the actual user action to become available before clicking it.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '刷新探针' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '刷新探针' }))
    // Vitest advances its fake intervals; DOM waitFor cannot poll this non-DOM counter.
    await vi.waitFor(() => expect(f.reports).toHaveLength(2), { timeout: 5000 })
    // The fixture records POST before its query settles. Invalidation during that
    // first fetch reuses POST instead of starting the intended blocked header GET.
    await vi.waitFor(
      () => expect(client.isFetching({ queryKey: ['run-observability-complete'] })).toBe(0),
      { timeout: 5000 },
    )
    const release = f.block(f.reports[1]!.header.reportId)
    const requestsBeforeHeaderRead = f.requests.length
    let finished!: Promise<void>
    act(() => {
      finished = client.invalidateQueries({ queryKey: ['run-observability-complete'] })
    })
    await vi.waitFor(
      () =>
        expect(f.requests.slice(requestsBeforeHeaderRead)).toContainEqual({
          path: '/api/observability/reports/' + f.reports[1]!.header.reportId,
          method: 'GET',
          reportId: f.reports[1]!.header.reportId,
        }),
      { timeout: 5000 },
    )
    await act(async () => {
      release({ error: { code: 'upstream-failed', message: 'Read failed' } }, 502)
      await finished
    })
    await waitFor(() => expect(screen.queryByTestId('snapshot')).toBeNull())
    const refresh = screen.getByRole('button', { name: '刷新探针' }) as HTMLButtonElement
    await waitFor(() => expect(refresh.disabled).toBe(false))
    const requestsAfterError = f.requests.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(f.requests).toHaveLength(requestsAfterError)
    expect(screen.queryByTestId('snapshot')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '刷新探针' }))
    await vi.waitFor(() => expect(f.reports).toHaveLength(3), { timeout: 5000 })
    expect(screen.queryByTestId('snapshot')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

// The sidebar supplies no dates. Its second visit must use the actual completed
// range, rather than Date.now() creating another full historical report.
function mountSidebarPage() {
  const root = createRootRoute({
    component: () => (
      <>
        <Link to="/tasks">离开观测</Link>
        <Link to="/observability">侧栏返回观测</Link>
        <Outlet />
      </>
    ),
  })
  const observation = createRoute({
    getParentRoute: () => root,
    path: '/observability',
    validateSearch: validateObservationSearch,
    component: Route.options.component,
  })
  const tasks = createRoute({
    getParentRoute: () => root,
    path: '/tasks',
    component: () => <h1>任务路由</h1>,
  })
  const history = createMemoryHistory({ initialEntries: ['/observability'] })
  const router = createRouter({ routeTree: root.addChildren([observation, tasks]), history })
  render(
    <QueryClientProvider client={client}>
      {/* The focused tree keeps production route IDs and the complete page. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { router, history }
}

function defaultWeek(): ObservationOverviewQuery {
  return {
    from: NOW + 1 - 7 * 86400000,
    to: NOW + 1,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

function partialFacts(original: Ready): CompleteObservationReport {
  return {
    state: 'not-ready',
    reportId: original.header.reportId,
    gaps: ['native-token-bucket-unknown'],
    facts: {
      header: original.header,
      counts: original.counts,
      summary: {
        ...original.summary,
        metrics: {
          state: 'not-ready',
          gaps: ['native-token-bucket-unknown'],
          recordedUsage: {
            invocations: '1',
            observedInvocations: '1',
            records: '1',
            bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '1' },
            tokens: { input: '12', cacheRead: null, cacheWrite: '0', output: '56', total: '68' },
          },
          costCoverage: {
            records: '1',
            pricedRecords: '0',
            partiallyPricedRecords: '1',
            visibility: 'visible',
          },
          recordedCost: {
            currency: 'CNY',
            amount: '0.068',
            records: '1',
            pricedRecords: '0',
            partiallyPricedRecords: '1',
          },
        },
      },
    },
  }
}

test.each(['ready', 'incomplete'] as const)(
  'real sidebar return keeps the qualified %s range, dated buckets, CNY and bars without a second build',
  async (mode) => {
    const f = fixture()
    // Use the real application's five-minute default. The report hook must
    // collect its own unobserved entries without clearing this QueryClient.
    client.setQueryDefaults(['run-observability-complete'], { gcTime: 5 * 60000 })
    setToken('sidebar-' + fixtureSequence)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    f.control.firstBuilding = mode === 'incomplete'
    const { router, history } = mountSidebarPage()
    await waitFor(() => expect(f.reports).toHaveLength(1))
    const original = f.reports[0]!
    if (mode === 'incomplete') await f.finish(partialFacts(original))
    const trendName = mode === 'ready' ? /1 个任务.*102 Token/ : /1 个任务.*已记录 68/
    await screen.findByRole('button', { name: trendName })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    const originalScope = original.header.filters
    const originalTime = screen.getByText(
      i18n.t('runObservability.completeAsOf', { time: new Date(NOW).toLocaleString('zh') }),
    ).textContent!
    expect(originalScope).toEqual(defaultWeek())
    fireEvent.click(screen.getByRole('link', { name: '离开观测' }))
    await screen.findByRole('heading', { name: '任务路由' })
    await waitFor(() =>
      expect(client.getQueriesData({ queryKey: ['run-observability-complete'] })).toHaveLength(0),
    )
    clock.mockReturnValue(NOW + 2 * 3600000)
    const beforeReturn = f.requests.length
    fireEvent.click(screen.getByRole('link', { name: '侧栏返回观测' }))
    await screen.findByRole('button', { name: trendName })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    expect(router.state.location.search).toMatchObject({
      from: originalScope.from,
      to: originalScope.to,
      period: 'week',
      tab: 'overview',
    })
    expect(history.location.search).toBe(router.state.location.searchStr)
    expect(screen.getByText(originalTime)).toBeTruthy()
    const tokenCard = screen
      .getByRole('heading', {
        name: i18n.t(
          'runObservability.' + (mode === 'ready' ? 'totalTokens' : 'recordedTokenUsage'),
        ),
      })
      .closest<HTMLElement>('.card')!
    expect(
      [...tokenCard.querySelectorAll('[data-token-bucket] dd')].map((node) =>
        node.firstChild?.textContent?.trim(),
      ),
    ).toEqual(['12', mode === 'ready' ? '34' : i18n.t('runObservability.unknown'), '0', '56'])
    const costCard = screen
      .getByRole('heading', {
        name: i18n.t('runObservability.' + (mode === 'ready' ? 'cost' : 'recordedCost')),
      })
      .closest<HTMLElement>('.card')!
    expect(within(costCard).getByText(mode === 'ready' ? '¥0.102' : '¥0.068')).toBeTruthy()
    if (mode === 'incomplete') expect(within(tokenCard).getByText(/记录不完整/)).toBeTruthy()
    expect(f.reports).toHaveLength(1)
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    const reopened = f.requests.slice(beforeReturn)
    expect(reopened).toContainEqual({
      path: '/api/observability/reports/' + original.header.reportId,
      method: 'GET',
      reportId: original.header.reportId,
    })
    expect(reopened.some((request) => request.path.endsWith('/pages'))).toBe(true)
    expect(reopened.every((request) => request.reportId === original.header.reportId)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(f.reports).toHaveLength(2))
    await screen.findByText(i18n.t('runObservability.refreshingPrevious'))
    expect(screen.getByText(originalTime)).toBeTruthy()
    const refresh = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement
    expect(refresh.disabled).toBe(true)
    fireEvent.click(refresh)
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(2)
    await f.finish(f.reports[1]!)
    await screen.findByRole('button', { name: /1 个任务.*132 Token/ })
    expect(f.reports[1]!.header.filters).toEqual(originalScope)
    expect(screen.queryByText(originalTime)).toBeNull()
    const refreshedCostCard = screen
      .getByRole('heading', { name: i18n.t('runObservability.cost') })
      .closest<HTMLElement>('.card')!
    expect(within(refreshedCostCard).getByText('¥0.132')).toBeTruthy()
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(2)

    const initialCache = client.getQueryData<CompleteObservationReport>([
      'run-observability-complete',
      'scope-metrics/13',
      originalScope,
      null,
      0,
    ])
    expect(completeObservationReportContent(initialCache!)?.header.reportId).toBe(
      original.header.reportId,
    )
    fireEvent.click(screen.getByRole('link', { name: '离开观测' }))
    await screen.findByRole('heading', { name: '任务路由' })
    await waitFor(() =>
      expect(client.getQueriesData({ queryKey: ['run-observability-complete'] })).toHaveLength(0),
    )
    const beforeLatestReturn = f.requests.length
    fireEvent.click(screen.getByRole('link', { name: '侧栏返回观测' }))
    await screen.findByRole('button', { name: /1 个任务.*132 Token/ })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    expect(screen.queryByText(originalTime)).toBeNull()
    expect(
      screen.getByText(
        i18n.t('runObservability.completeAsOf', {
          time: new Date(NOW + 10000).toLocaleString('zh'),
        }),
      ),
    ).toBeTruthy()
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(2)
    const latestReturn = f.requests.slice(beforeLatestReturn)
    expect(latestReturn).toContainEqual({
      path: '/api/observability/reports/' + f.reports[1]!.header.reportId,
      method: 'GET',
      reportId: f.reports[1]!.header.reportId,
    })
    expect(
      latestReturn.every((request) => request.reportId === f.reports[1]!.header.reportId),
    ).toBe(true)

    discardObservationReportBookmark(original.header.reportId)
    expect(validateObservationSearch({})).toMatchObject({
      from: originalScope.from,
      to: originalScope.to,
    })
    // A remount resets revision to zero. Its next explicit refresh must create
    // a new report, rather than GET the previous visit's revision=1 report.
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(f.reports).toHaveLength(3))
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(3)
    expect(f.reports[2]!.header.filters).toEqual(originalScope)
    const newest = {
      ...f.reports[2]!,
      header: { ...f.reports[2]!.header, asOf: NOW + 20000 },
    }
    await f.finish(newest)
    await screen.findByText(
      i18n.t('runObservability.completeAsOf', {
        time: new Date(NOW + 20000).toLocaleString('zh'),
      }),
    )
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(3)
    discardObservationReportBookmark(f.reports[1]!.header.reportId)
    expect(validateObservationSearch({}).to).toBe(originalScope.to)
    discardObservationReportBookmark(newest.header.reportId)
    expect(validateObservationSearch({}).to).toBe(NOW + 2 * 3600000 + 1)
  },
)

test('a warm application returning after B is evicted never revives readable A and builds exactly once', async () => {
  const f = fixture()
  client.setQueryDefaults(['run-observability-complete'], { gcTime: 5 * 60000 })
  setToken('sidebar-evicted-' + fixtureSequence)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  mountSidebarPage()
  await screen.findByRole('button', { name: /1 个任务.*102 Token/ })
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  )
  const original = f.reports[0]!
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(f.reports).toHaveLength(2))
  const refreshed = f.reports[1]!
  await f.finish(refreshed)
  await screen.findByRole('button', { name: /1 个任务.*132 Token/ })
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  )
  expect(
    completeObservationReportContent(
      client.getQueryData<CompleteObservationReport>([
        'run-observability-complete',
        'scope-metrics/13',
        original.header.filters,
        null,
        0,
      ])!,
    )?.header.reportId,
  ).toBe(original.header.reportId)
  const release = f.block(refreshed.header.reportId)
  fireEvent.click(screen.getByRole('link', { name: '离开观测' }))
  await screen.findByRole('heading', { name: '任务路由' })
  await waitFor(() =>
    expect(client.getQueriesData({ queryKey: ['run-observability-complete'] })).toHaveLength(0),
  )
  const beforeReturn = f.requests.length
  fireEvent.click(screen.getByRole('link', { name: '侧栏返回观测' }))
  await waitFor(() =>
    expect(f.requests.slice(beforeReturn)).toContainEqual({
      path: '/api/observability/reports/' + refreshed.header.reportId,
      method: 'GET',
      reportId: refreshed.header.reportId,
    }),
  )
  expect(screen.queryByRole('button', { name: /1 个任务.*102 Token/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /1 个任务.*132 Token/ })).toBeNull()
  await act(async () => {
    release({ error: { code: 'not-found', message: 'Evicted report' } }, 404)
  })
  await waitFor(() => expect(f.reports).toHaveLength(3))
  expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(3)
  expect(screen.queryByRole('button', { name: /1 个任务.*102 Token/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /1 个任务.*132 Token/ })).toBeNull()
  expect(
    f.requests.slice(beforeReturn).some((request) => request.reportId === original.header.reportId),
  ).toBe(false)
  const replacement = {
    ...f.reports[2]!,
    header: { ...f.reports[2]!.header, asOf: NOW + 20000 },
  }
  expect(replacement.header.filters).toEqual(original.header.filters)
  await f.finish(replacement)
  await screen.findByText(
    i18n.t('runObservability.completeAsOf', {
      time: new Date(NOW + 20000).toLocaleString('zh'),
    }),
  )
  await screen.findByRole('button', { name: /1 个任务.*132 Token/ })
  expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(3)
  expect(
    f.requests.slice(beforeReturn).some((request) => request.reportId === original.header.reportId),
  ).toBe(false)
  // A remains readable at its owner; collecting the client query did not delete it.
  expect(f.states.get(original.header.reportId)).toEqual(original)
})

test('a completed default cannot replace any explicit URL field or a user-selected time period', async () => {
  const f = fixture()
  setToken('sidebar-explicit-' + fixtureSequence)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  mountProbe({ scope: defaultWeek() })
  await screen.findByTestId('snapshot')
  clock.mockReturnValue(NOW + 3600000)
  const { from, to } = defaultWeek()
  expect(validateObservationSearch({ tab: 'usage' })).toMatchObject({
    from,
    to,
    tab: 'usage',
  })
  for (const raw of [
    { period: 'week' },
    { period: 'month' },
    { period: 'custom' },
    { period: 'all' },
    { task: 'task-id' },
    { cohort: 'usage' },
    { cohort: 'started' },
    { q: 'search' },
    { status: 'done' },
    { repository: 'repo' },
    { workflow: 'workflow' },
    { selection: JSON.stringify({ purpose: 'memory' }) },
    { runtime: 'runtime' },
    { model: 'model' },
    { attempt: 'attempt' },
    { span: 'span' },
    { agent: 'agent' },
    { quality: 'gap' },
    { after: 'cursor' },
    { unknown: 'keep-original-validation' },
    { from: undefined },
  ]) {
    expect(validateObservationSearch(raw).to).toBe(NOW + 3600000 + 1)
  }
  expect(validateObservationSearch({ from: 1000, to: 2000, period: 'custom' })).toMatchObject({
    from: 1000,
    to: 2000,
    period: 'custom',
  })
  expect(validateObservationSearch({ to: 2000 })).toMatchObject({ from: 0, to: 2000 })
  expect(validateObservationSearch({ from: 1000 }).from).toBe(1000)
  expect(f.reports).toHaveLength(1)
})

test('the formal period control still selects a fresh month instead of the remembered default week', async () => {
  const f = fixture()
  setToken('sidebar-period-' + fixtureSequence)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const { router } = mountSidebarPage()
  await screen.findByRole('button', { name: /1 个任务.*102 Token/ })
  clock.mockReturnValue(NOW + 3600000)
  fireEvent.click(screen.getByRole('combobox', { name: i18n.t('runObservability.period') }))
  fireEvent.mouseDown(await screen.findByRole('option', { name: i18n.t('runObservability.month') }))
  await waitFor(() => expect(f.reports).toHaveLength(2))
  expect(f.reports[1]!.header.filters).toEqual({
    from: NOW + 3600001 - 30 * 86400000,
    to: NOW + 3600001,
    timezone: defaultWeek().timezone,
  })
  expect(router.state.location.search).toMatchObject({
    from: NOW + 3600001 - 30 * 86400000,
    to: NOW + 3600001,
    period: 'month',
  })
  expect(screen.queryByRole('button', { name: /1 个任务.*102 Token/ })).toBeNull()
  await f.finish(f.reports[1]!)
  await screen.findByRole('button', { name: /1 个任务.*132 Token/ })
  expect(validateObservationSearch({}).to).toBe(NOW + 1)
})

test.each([
  { cohort: 'usage' as const },
  { cohort: 'started' as const },
  { q: 'filtered' },
  { status: 'done' as const },
  { repository: 'repository' },
  { workflow: 'workflow' },
  { selection: JSON.stringify({ purpose: 'memory' }) },
  { from: NOW - 60000 },
] as const)('a report filtered by %j never supplies the sidebar default', async (extra) => {
  const f = fixture()
  setToken('sidebar-filtered-' + fixtureSequence)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const scope: ObservationOverviewQuery = { ...defaultWeek(), ...extra }
  f.control.firstBuilding = true
  mountProbe({ scope })
  await waitFor(() => expect(f.reports).toHaveLength(1))
  const original = f.reports[0]!
  // Qualify the original usage-cohort report with its required window evidence.
  if (scope.cohort === 'usage') {
    await f.finish({
      ...original,
      summary: {
        ...original.summary,
        usageWindow: {
          candidateTasks: '1',
          timingBasis: 'task-lifecycle',
          partitions: {
            'in-window': { records: '1', metrics: original.summary.metrics },
            'outside-window': { records: '0', metrics: { state: 'not-applicable' } },
            'unassigned-time': { records: '0', metrics: { state: 'not-applicable' } },
          },
        },
      },
    })
  } else {
    await f.finish(original)
  }
  await screen.findByTestId('snapshot')
  clock.mockReturnValue(NOW + 60000)
  expect(validateObservationSearch({}).to).toBe(NOW + 60001)
})

test.each(['task', 'timezone', 'building', 'failed', 'missing-facts'] as const)(
  '%s responses cannot qualify a default root range',
  async (mode) => {
    const f = fixture()
    setToken('sidebar-ineligible-' + fixtureSequence)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    f.control.firstBuilding = mode !== 'task' && mode !== 'timezone'
    const scope = defaultWeek()
    if (mode === 'timezone') scope.timezone = scope.timezone === 'UTC' ? 'Asia/Shanghai' : 'UTC'
    mountProbe({ scope, ...(mode === 'task' ? { taskId: 'original-task' } : {}) })
    await waitFor(() => expect(f.reports).toHaveLength(1))
    if (mode === 'failed')
      await f.finish({
        state: 'failed',
        reportId: f.reports[0]!.header.reportId,
        error: 'Original failed',
        retryable: true,
      })
    else if (mode === 'missing-facts')
      await f.finish({
        state: 'not-ready',
        reportId: f.reports[0]!.header.reportId,
        gaps: ['missing-facts'],
      })
    else if (mode === 'task' || mode === 'timezone') await screen.findByTestId('snapshot')
    clock.mockReturnValue(NOW + 60000)
    expect(validateObservationSearch({}).to).toBe(NOW + 60001)
  },
)

test.each(['account', 'service', 'timezone'] as const)(
  'a changed %s makes the remembered range unavailable',
  async (mode) => {
    const f = fixture()
    const token = 'sidebar-identity-' + fixtureSequence
    setToken(token)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    mountProbe({ scope: defaultWeek() })
    await screen.findByTestId('snapshot')
    clock.mockReturnValue(NOW + 60000)
    expect(validateObservationSearch({}).to).toBe(NOW + 1)
    if (mode === 'account') setToken(token + '-other')
    else if (mode === 'service') setBaseUrl('http://other-report-service.test')
    else {
      const options = Intl.DateTimeFormat().resolvedOptions()
      vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
        ...options,
        timeZone: options.timeZone === 'UTC' ? 'Asia/Shanghai' : 'UTC',
      })
    }
    expect(validateObservationSearch({}).to).toBe(NOW + 60001)
    if (mode === 'account') {
      setToken(token)
      expect(validateObservationSearch({}).to).toBe(NOW + 60001)
    }
    expect(f.reports).toHaveLength(1)
  },
)

test('a rejected original detail retires its default range as well as its displayed numbers', async () => {
  const f = fixture()
  setToken('sidebar-rejected-' + fixtureSequence)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  mountProbe({ scope: defaultWeek() })
  await screen.findByTestId('snapshot')
  clock.mockReturnValue(NOW + 60000)
  expect(validateObservationSearch({}).to).toBe(NOW + 1)
  f.control.pageFailure = true
  fireEvent.click(screen.getByRole('button', { name: '重新读取原明细' }))
  await waitFor(() => expect(screen.queryByTestId('snapshot')).toBeNull())
  expect(validateObservationSearch({}).to).toBe(NOW + 60001)
})
