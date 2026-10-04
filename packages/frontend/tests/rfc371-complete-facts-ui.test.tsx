// Display contract only; original SQLite/PostgreSQL source completeness is verified separately.
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  CompleteObservationFactSummary,
  CompleteObservationReport,
  CompleteObservationTask,
  ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { CompleteRunObservability } from '../src/components/observability/CompleteRunObservability'
import {
  CompleteObservationPage,
  type CompletePageState,
} from '../src/components/observability/CompleteObservationPager'
import type { ObservationSearch } from '../src/components/observability/RunObservability'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'

const NOW = Date.parse('2026-10-04T00:00:00Z')
const metrics = { state: 'not-ready' as const, gaps: ['native-capture-unobserved'] }
const row = (id: string): CompleteObservationTask => ({
  task: {
    id,
    name: '执行事实 ' + id,
    status: 'done',
    parentTaskId: null,
    startedAt: NOW - 10,
    finishedAt: NOW,
    runningMs: 10,
    runningSince: null,
  },
  metrics,
  attemptCount: '1',
  timing: {
    wallMs: '10',
    runningMs: '10',
    range: { from: NOW - 10, to: NOW },
    intervals: { state: 'complete', activeUnionMs: '10', cumulativeMs: '10', unknown: '0' },
  },
})
type Facts = Extract<CompleteObservationReport, { state: 'not-ready' }> & {
  facts: NonNullable<Extract<CompleteObservationReport, { state: 'not-ready' }>['facts']>
}
function fixture(indexed = true, reason = metrics.gaps[0]!) {
  const valueMetrics = { state: 'not-ready' as const, gaps: [reason] }
  const reports = new Map<string, Facts>(),
    requests: string[] = [],
    state = { damaged: false }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const url = new URL(String(raw))
    requests.push(url.pathname + url.search)
    if (url.pathname === '/api/observability/reports' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
          taskId?: string
          filters: ObservationOverviewQuery
        },
        id = crypto.randomUUID()
      const summary: CompleteObservationFactSummary = {
        metrics: valueMetrics,
        inventory: { tasks: body.taskId ? '1' : '202', attempts: '1', invocations: '1' },
        statuses: { done: body.taskId ? '1' : '202' },
        timing: { wallMs: '10', runningMs: '10', p50Ms: '10', p95Ms: '10', unknown: '0' },
        rootTask: body.taskId ? row(body.taskId) : null,
      }
      const value: Facts = {
        state: 'not-ready',
        reportId: id,
        gaps: valueMetrics.gaps,
        facts: {
          header: {
            reportId: id,
            projectionVersion: 2,
            generation: 'original-facts',
            snapshotId: 'complete-original-snapshot',
            asOf: NOW,
            sourceRevision: 'sealed-original-source',
            actorScope: 'reader',
            authorizationRevision: '0',
            filters: body.filters,
            taskId: body.taskId ?? null,
          },
          summary,
          counts: {
            tasks: summary.inventory.tasks,
            quality: '1',
            attempts: '1',
            invocations: '1',
            agents: '0',
            runtimes: '0',
            models: '0',
            'span-facts': '0',
            'span-statuses': '0',
          },
        },
      }
      reports.set(id, value)
      return Response.json(value)
    }
    const match = /^\/api\/observability\/reports\/([^/]+)(\/pages)?$/.exec(url.pathname)
    if (!match) throw new Error('Unexpected legacy observation request')
    const value = reports.get(match[1]!)!
    if (!match[2])
      return Response.json(
        state.damaged
          ? { state: 'not-ready', reportId: value.reportId, gaps: ['retained-output-unverified'] }
          : value,
      )
    if (state.damaged)
      return Response.json(
        { error: { code: 'report-changed', message: 'retained fact missing' } },
        { status: 409 },
      )
    const section = url.searchParams.get('section')!,
      parent = url.searchParams.get('parent'),
      offset = Number(url.searchParams.get('after') ?? 0)
    if (
      ['allocations', 'native-captures', 'platform-captures', 'span-captures', 'receipts'].includes(
        section,
      )
    )
      throw new Error('Incomplete numeric collection requested')
    const total =
      section === 'quality-tasks'
        ? value.facts.summary.inventory.tasks
        : (value.facts.counts[section as keyof typeof value.facts.counts] ?? '0')
    let items: unknown[] = [],
      nextCursor: string | null = null
    if (section === 'quality')
      items = [
        {
          key: reason,
          taskCount: value.facts.summary.inventory.tasks,
          ...(indexed ? { taskIndexVersion: 1 } : {}),
        },
      ]
    if (section === 'tasks' || section === 'quality-tasks') {
      items = Array.from({ length: Math.min(100, Number(total) - offset) }, (_, i) =>
        row(String(offset + i).padStart(4, '0')),
      )
      if (offset + items.length < Number(total)) nextCursor = String(offset + items.length)
    }
    if (section === 'attempts')
      items = [
        {
          id: 'retained-run',
          taskId: value.facts.header.taskId,
          taskName: '执行事实 0000',
          nodeId: '事实节点',
          status: 'done',
          computeKind: 'agent',
          startedAt: NOW - 10,
          finishedAt: NOW,
          durationMs: '10',
          open: false,
          metrics,
        },
      ]
    if (section === 'invocations')
      items = [
        {
          invocationId: 'retained-call',
          taskId: value.facts.header.taskId,
          taskName: '执行事实 0000',
          nodeRunId: 'retained-run',
          agentId: 'actual-agent',
          agentName: '事实 Agent',
          agentRevision: 1,
          purpose: 'task',
          acceptedAt: NOW - 10,
          priceBookRevision: 1,
          authority: {
            kind: 'local',
            runtime: {
              registrationId: 'validation-runtime',
              acceptedName: '验证算力',
              configurationRevision: 1,
              protocol: 'opencode',
            },
          },
          metrics,
        },
      ]
    return Response.json({ reportId: value.reportId, section, parent, total, items, nextCursor })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  function Page() {
    const [search, setSearch] = useState<ObservationSearch>({
      from: NOW - 1000,
      to: NOW + 1,
      period: 'all',
      tab: 'tasks',
    })
    return <CompleteRunObservability search={search} onChange={setSearch} />
  }
  render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
  return { requests, state }
}
beforeEach(async () => {
  setBaseUrl('http://facts.test')
  setToken('test')
  await i18n.changeLanguage('zh')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('not-ready keeps every fact page and Task/attempt/call entry, four unknown buckets, and no numeric collection request', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: '执行事实 0000' })
  expect(screen.getAllByText(i18n.t('runObservability.reportNotReady')).length).toBeGreaterThan(0)
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'])
    expect(screen.getAllByText(i18n.t('runObservability.' + bucket)).length).toBeGreaterThan(0)
  expect(document.querySelector('[data-complete-observation]')?.textContent).not.toContain('¥')
  fireEvent.click(screen.getByRole('button', { name: i18n.t('runObservability.next') }))
  await screen.findByRole('button', { name: '执行事实 0100' })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('runObservability.next') }))
  await screen.findByRole('button', { name: '执行事实 0201' })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('runObservability.first') }))
  fireEvent.click(await screen.findByRole('button', { name: '执行事实 0000' }))
  await screen.findByRole('heading', { level: 1, name: '执行事实 0000' })
  fireEvent.click(
    await screen.findByRole('button', { name: i18n.t('runObservability.detail') + ' · 事实节点' }),
  )
  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByRole('button', { name: '事实 Agent' })).toBeTruthy()
  expect(dialog.textContent).not.toContain('¥')
  expect(
    f.requests.some((path) =>
      /section=(allocations|native-captures|platform-captures|span-captures|receipts)/.test(path),
    ),
  ).toBe(false)
})

test('a damaged retained page clears the sealed fact summary instead of keeping stale counts', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: '执行事实 0000' })
  f.state.damaged = true
  fireEvent.click(screen.getByRole('button', { name: i18n.t('runObservability.next') }))
  await screen.findByText('retained-output-unverified')
  expect(screen.queryByRole('button', { name: '执行事实 0000' })).toBeNull()
  expect(document.querySelector('.observation-summary')).toBeNull()
})

// The original parent count covers all pages; Task drilling retains the quality disclosure and page.
test.each(['zh', 'en'])(
  'usage gaps explain available facts and preserve the last affected Task on return in %s',
  async (language) => {
    await i18n.changeLanguage(language)
    const f = fixture()
    const reason = i18n.t('runObservability.gap_native-capture-unobserved')
    const trigger = await screen.findByRole('button', {
      name: i18n.t('runObservability.viewGapTasks', { reason }),
    })
    expect(screen.getByText(i18n.t('runObservability.factsAvailable'))).toBeTruthy()
    trigger.focus()
    fireEvent.click(trigger)
    let dialog = await screen.findByRole('dialog')
    fireEvent.click(
      await within(dialog).findByRole('button', { name: i18n.t('runObservability.next') }),
    )
    await within(dialog).findByRole('button', { name: '执行事实 0100' })
    fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('runObservability.next') }))
    const last = await within(dialog).findByRole('button', { name: '执行事实 0201' })
    last.focus()
    fireEvent.click(last)
    await screen.findByRole('heading', { level: 1, name: '执行事实 0201' })
    fireEvent.click(
      screen.getByRole('button', { name: '← ' + i18n.t('runObservability.backAnalysis') }),
    )
    dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('button', { name: '执行事实 0201' })).toBeTruthy()
    expect(dialog.textContent).not.toContain('¥')
    expect(
      f.requests.some(
        (path) => path.includes('section=quality-tasks') && path.includes('after=200'),
      ),
    ).toBe(true)
    expect(within(dialog).queryByRole('button', { name: '执行事实 0000' })).toBeNull()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      i18n.t('runObservability.viewGapTasks', { reason }),
    )
  },
)
test('an older report has no fabricated affected-Task index and unknown original reasons stay readable', async () => {
  fixture(false, 'original-new-runtime-gap')
  await screen.findByRole('button', { name: '执行事实 0000' })
  expect(screen.getAllByText('original-new-runtime-gap').length).toBeGreaterThan(0)
  expect(screen.getByText(i18n.t('runObservability.gapIndexUnavailable'))).toBeTruthy()
  expect(
    screen.queryByRole('button', {
      name: i18n.t('runObservability.viewGapTasks', { reason: 'original-new-runtime-gap' }),
    }),
  ).toBeNull()
})

test('mouse-opened quality disclosure closes back to its actual reason button', async () => {
  fixture()
  const reason = i18n.t('runObservability.gap_native-capture-unobserved')
  const trigger = await screen.findByRole('button', {
    name: i18n.t('runObservability.viewGapTasks', { reason }),
  })
  const other = screen.getByRole('button', { name: i18n.t('runObservability.refresh') })
  other.focus()
  // Mouse opening does not itself guarantee focus moves to the trigger in WebKit.
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog')
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test('compact quality actions only disappear for a true single page; later pages retain navigation', () => {
  const first = vi.fn(),
    previous = vi.fn(),
    next = vi.fn()
  const query: CompletePageState<unknown> = {
    data: {
      reportId: 'original-report',
      section: 'quality',
      parent: null,
      items: [{ key: 'original-gap', taskCount: '201' }],
      total: '1',
      nextCursor: null,
    },
    error: null,
    isPending: false,
    isFetching: false,
    page: 1,
    first,
    previous,
    next,
    refetch: async () => undefined,
  }
  const view = (value: CompletePageState<unknown>) => (
    <CompleteObservationPage query={value} hideSinglePageActions>
      {() => <span>Original reasons</span>}
    </CompleteObservationPage>
  )
  const { rerender } = render(view(query))
  expect(screen.queryByRole('button', { name: i18n.t('runObservability.next') })).toBeNull()
  rerender(view({ ...query, data: { ...query.data!, total: '101', nextCursor: 'original-next' } }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('runObservability.next') }))
  expect(next).toHaveBeenCalledTimes(1)
  rerender(view({ ...query, page: 2, data: { ...query.data!, total: '101', nextCursor: null } }))
  expect(
    (screen.getByRole('button', { name: i18n.t('runObservability.next') }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: i18n.t('runObservability.previous') }))
  fireEvent.click(screen.getByRole('button', { name: i18n.t('runObservability.first') }))
  expect(previous).toHaveBeenCalledTimes(1)
  expect(first).toHaveBeenCalledTimes(1)
})
