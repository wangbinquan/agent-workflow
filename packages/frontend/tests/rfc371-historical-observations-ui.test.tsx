// Display regression only; original sources, EOF, deduplication and CNY are covered by dual-provider tests.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  CompleteHistoricalObservationExecution,
  CompleteHistoricalObservationRecord,
  CompleteHistoricalObservationReference,
  CompleteObservationMetrics,
  CompleteObservationTrend,
} from '@agent-workflow/shared'
import {
  CompleteHistoricalRecords,
  CompleteHistoricalExecutions,
} from '../src/components/observability/CompleteHistoricalObservations'
import {
  CompleteCost,
  CompleteTokens,
} from '../src/components/observability/CompleteObservationMetrics'
import type { ReadableObservationReport } from '../src/components/observability/completeReportClient'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'

const NOW = Date.parse('2026-10-08T00:00:00Z')
const metrics: Extract<CompleteObservationMetrics, { state: 'not-ready' }> = {
  state: 'not-ready',
  gaps: ['historical-invocation-unobserved'],
  tokenCoverage: {
    invocations: '0',
    observedInvocations: '0',
    historicalReferences: '1',
    observedHistoricalReferences: '1',
    records: '1',
    bucketRecords: { input: '1', cacheRead: '1', cacheWrite: '1', output: '1' },
  },
  recordedUsage: {
    invocations: '0',
    observedInvocations: '0',
    historicalReferences: '1',
    observedHistoricalReferences: '1',
    records: '1',
    bucketRecords: { input: '1', cacheRead: '1', cacheWrite: '1', output: '1' },
    tokens: { input: '123', cacheRead: '45', cacheWrite: '6', output: '7', total: '181' },
  },
  costCoverage: { records: '1', pricedRecords: '0', visibility: 'visible' },
}
function report(id = 'original-history'): ReadableObservationReport {
  return {
    header: {
      reportId: id,
      projectionVersion: 2,
      generation: 'original',
      snapshotId: 'original',
      asOf: NOW,
      sourceRevision: 'original',
      actorScope: 'reader',
      authorizationRevision: '0',
      filters: { from: 0, to: NOW + 1, timezone: 'UTC' },
      taskId: null,
    },
    summary: {
      metrics,
      inventory: { tasks: '0', attempts: '0', invocations: '0', historicalReferences: '1' },
      statuses: {},
      timing: { p50Ms: null, p95Ms: null, wallMs: '0', runningMs: '0', unknown: '0' },
      rootTask: null,
    },
    counts: { 'historical-records': '101', 'historical-executions': '2' },
  }
}
const execution: CompleteHistoricalObservationExecution = {
  referenceRole: 'execution',
  execution: {
    kind: 'historical-observed',
    referenceId: 'original-memory-reference',
    sourceKind: 'memory-distill',
    ownerId: 'original-memory-job',
    attemptId: '0',
    nodeRunId: null,
    parentTaskId: 'original-task',
    name: '原始记忆提取',
    status: 'done',
    createdAt: NOW - 1000,
    startedAt: null,
    finishedAt: null,
    agentId: null,
    agentRevision: null,
    agentName: null,
    purpose: 'memory',
    runtime: null,
    rootSessionId: 'original-native-root',
    recordedUsage: null,
  },
  parentTaskName: '所属原任务',
  scopeMatch: 'matched',
  timeBasis: 'task-cohort',
  cohortAt: NOW - 1000,
  coveredByAcceptedRecords: false,
  metrics,
  issues: ['historical-invocation-unobserved'],
}
const record = (n: number): CompleteHistoricalObservationRecord => ({
  kind: 'historical-observed',
  nativeSource: 'original-native-source',
  recordId: 'opencode:step:original-' + n,
  sessionId: 'original-native-root',
  occurredAt: NOW - 1000,
  model: { provider: 'original-provider', id: 'original-model-' + n },
  originalUsage: { input: '123', cacheRead: '45', cacheWrite: '6', output: '7' },
  candidateCount: '2',
  scopeMatch: 'matched',
  coveredByAcceptedRecords: false,
  includedInTotals: true,
  metrics,
  issues: [],
})
const clients: QueryClient[] = []
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
  setBaseUrl('http://history.test')
  setToken('display-fixture')
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
})
function fixture() {
  const requests: {
    report: string
    section: string
    parent: string | null
    after: string | null
  }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
    const url = new URL(String(raw)),
      id = url.pathname.split('/')[4]!,
      section = url.searchParams.get('section')!,
      parent = url.searchParams.get('parent'),
      after = url.searchParams.get('after')
    requests.push({ report: id, section, parent, after })
    let items: unknown[] = [],
      total = '0',
      nextCursor: string | null = null
    if (section === 'historical-records') {
      total = '101'
      items = after === null ? Array.from({ length: 100 }, (_, n) => record(n)) : [record(100)]
      nextCursor = after === null ? 'original-next' : null
    } else if (section === 'historical-record-references') {
      total = '2'
      items = [
        {
          referenceId: 'in',
          execution: execution.execution,
          scopeMatch: 'matched',
          timeBasis: 'task-cohort',
          cohortAt: NOW - 1000,
        },
        {
          referenceId: 'out',
          execution: { ...execution.execution, referenceId: 'outside', name: '范围外原作业' },
          scopeMatch: 'excluded',
          timeBasis: 'owner-created',
          cohortAt: 0,
        },
      ] satisfies CompleteHistoricalObservationReference[]
    } else if (section === 'historical-executions') {
      total = '2'
      items = [
        execution,
        {
          ...execution,
          execution: {
            ...execution.execution,
            referenceId: 'known-clock',
            name: '有原始时间的执行',
            startedAt: NOW - 5000,
            finishedAt: NOW - 1000,
          },
        },
      ]
    }
    return new Response(
      JSON.stringify({ reportId: id, section, parent, total, items, nextCursor }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { requests, Wrapper }
}
test('native records show all four buckets, every display page, original candidate scopes and no guessed CNY', async () => {
  const f = fixture()
  render(<CompleteHistoricalRecords report={report()} />, { wrapper: f.Wrapper })
  const table = await screen.findByRole('table')
  expect(within(table).getByRole('columnheader', { name: '非缓存输入' })).toBeTruthy()
  expect(within(table).getByRole('columnheader', { name: '缓存读取' })).toBeTruthy()
  expect(within(table).getByRole('columnheader', { name: '缓存写入' })).toBeTruthy()
  expect(within(table).getByRole('columnheader', { name: '输出' })).toBeTruthy()
  expect(within(table).getAllByText('历史费率未观测')).toHaveLength(100)
  fireEvent.click(screen.getByRole('button', { name: 'original-model-0' }))
  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByText('范围外原作业')).toBeTruthy()
  expect(within(dialog).getByText('在所选范围外')).toBeTruthy()
  expect(within(dialog).getByText('opencode:step:original-0')).toBeTruthy()
  expect(f.requests.find((value) => value.section === 'historical-record-references')?.parent).toBe(
    JSON.stringify(['original-native-source', 'opencode:step:original-0']),
  )
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  expect(await screen.findByRole('button', { name: 'original-model-100' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'original-model-0' })).toBeNull()
  expect(f.requests.some((value) => value.after === 'original-next')).toBe(true)
  expect(screen.queryByText(/\$/)).toBeNull()
})
test('refreshing to a different sealed report closes stale native detail instead of joining old rows to a new report', async () => {
  const f = fixture(),
    ui = render(<CompleteHistoricalRecords report={report('before')} />, { wrapper: f.Wrapper })
  fireEvent.click(await screen.findByRole('button', { name: 'original-model-0' }))
  await screen.findByRole('dialog')
  ui.rerender(<CompleteHistoricalRecords report={report('after')} />)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await screen.findByRole('button', { name: 'original-model-0' })
  expect(
    f.requests.filter(
      (value) => value.report === 'after' && value.section === 'historical-record-references',
    ),
  ).toHaveLength(0)
})
test('historical executions use plain task links and real swimlanes, leaving unknown start/finish without a fabricated bar', async () => {
  const f = fixture(),
    ui = render(<CompleteHistoricalExecutions report={report()} timeline />, { wrapper: f.Wrapper })
  const tables = await screen.findAllByRole('table')
  await waitFor(() => expect(tables.length).toBe(2))
  expect(ui.container.querySelectorAll('.execution-swimlane__bar')).toHaveLength(1)
  const unknown = ui.container.querySelector('[data-execution-id="original-memory-reference"]')!
  expect(unknown.querySelector('.execution-swimlane__bar')).toBeNull()
  expect(unknown.textContent).toContain('区间不完整')
  const link = within(tables[1]!).getByRole('button', {
    name: '原始记忆提取',
  }).classList
  expect(link.contains('data-table__link')).toBe(true)
  expect(link.contains('btn')).toBe(false)
  expect(screen.getAllByText('所属原任务').length).toBeGreaterThan(0)
})
test('historical-only known Token remains visible while CNY clearly says its original rate is unknown', async () => {
  render(
    <>
      <CompleteTokens value={metrics} />
      <CompleteCost value={metrics} />
    </>,
  )
  expect(await screen.findByText('181')).toBeTruthy()
  expect(screen.getByText('历史费率未观测')).toBeTruthy()
  expect(screen.queryByText('0 / 0')).toBeNull()
  expect(screen.queryByText(/\$/)).toBeNull()
})
test('a retained legacy trend shows its known four buckets without fabricating historical reference coverage', async () => {
  const recordedUsage: CompleteObservationTrend['recordedUsage'] = {
    invocations: '2',
    observedInvocations: '1',
    records: '1',
    tokens: { input: '123', cacheRead: '45', cacheWrite: '6', output: '7', total: '181' },
  }
  render(
    <CompleteTokens
      value={{ state: 'not-ready', gaps: ['usage-incomplete'] }}
      recordedUsage={recordedUsage}
      compact
    />,
  )
  expect(await screen.findByText('181')).toBeTruthy()
  for (const value of ['123', '45', '6', '7']) expect(screen.getByText(value)).toBeTruthy()
  expect(
    screen.getByText(
      i18n.t('runObservability.recordedUsageCompact', { observed: '1', calls: '2' }),
    ),
  ).toBeTruthy()
  expect(screen.queryByText(/原历史来源|历史来源覆盖/)).toBeNull()
})
test('an absent historical observed count remains unknown instead of becoming a measured zero', async () => {
  const { observedHistoricalReferences: _absent, ...recordedUsage } = metrics.recordedUsage!
  render(<CompleteTokens value={{ ...metrics, recordedUsage }} compact />)
  expect(await screen.findByText('181')).toBeTruthy()
  expect(
    screen.getByText(
      i18n.t('runObservability.historicalObservedCoverage', {
        observed: i18n.t('runObservability.unknown'),
        references: '1',
      }),
    ),
  ).toBeTruthy()
})
