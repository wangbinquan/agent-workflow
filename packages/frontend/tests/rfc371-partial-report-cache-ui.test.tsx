// RFC-371: the actual report hook must request current partial-CNY capability without rewriting retained history.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { CompleteObservationReport, CompleteObservationMetrics } from '@agent-workflow/shared'
import { completeObservationReportContent } from '@agent-workflow/shared'
import { CompleteCost } from '../src/components/observability/CompleteObservationMetrics'
import { CompleteObservationTiming } from '../src/components/observability/CompleteObservationDetails'
import { useCompleteObservationReport } from '../src/components/observability/completeReportClient'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'
const now = Date.parse('2026-10-04T00:00:00Z')
const filters = { from: now, to: now + 60000, timezone: 'UTC' }
const metrics: Extract<CompleteObservationMetrics, { state: 'not-ready' }> = {
  state: 'not-ready',
  gaps: ['usage-incomplete'],
  tokenCoverage: {
    invocations: '1',
    observedInvocations: '1',
    records: '1',
    bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '0' },
  },
  recordedUsage: {
    invocations: '1',
    observedInvocations: '1',
    records: '1',
    bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '0' },
    tokens: { input: '120', cacheRead: null, cacheWrite: '0', output: null, total: '120' },
  },
  costCoverage: {
    records: '1',
    pricedRecords: '0',
    partiallyPricedRecords: '1',
    visibility: 'visible',
  },
  recordedCost: {
    currency: 'CNY',
    amount: '0.00012',
    records: '1',
    pricedRecords: '0',
    partiallyPricedRecords: '1',
  },
}
const current: CompleteObservationReport = {
  state: 'not-ready',
  reportId: 'current-partial-cny-report',
  gaps: ['usage-incomplete'],
  facts: {
    header: {
      reportId: 'current-partial-cny-report',
      projectionVersion: 2,
      generation: 'original-generation',
      snapshotId: 'original-snapshot',
      asOf: now,
      sourceRevision: 'original-source-revision',
      actorScope: 'original-actor',
      authorizationRevision: 'original-authorization',
      filters,
      taskId: null,
    },
    summary: {
      metrics,
      inventory: { tasks: '1', attempts: '1', invocations: '1' },
      statuses: { done: '1' },
      timing: { p50Ms: '10', p95Ms: '10', wallMs: '10', runningMs: '10', unknown: '0' },
      rootTask: null,
    },
    counts: {},
  },
}
let client: QueryClient | undefined
beforeEach(async () => {
  setBaseUrl('http://partial-cny.test')
  setToken('test')
  await i18n.changeLanguage('zh')
})
afterEach(() => {
  cleanup()
  client?.clear()
  client = undefined
  vi.restoreAllMocks()
})
test('cached capability seven cannot suppress the original partial amount and its historical cache stays unchanged', async () => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  })
  const oldKey = ['run-observability-complete', 'scope-metrics/7', filters, null, 0] as const
  const legacy: CompleteObservationReport = {
    state: 'not-ready',
    reportId: 'retained-capability-seven',
    gaps: ['old-partial-valuation-mask'],
  }
  client.setQueryData(oldKey, legacy)
  const original = JSON.stringify(client.getQueryData(oldKey)),
    requests: { path: string; method: string }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const path = new URL(String(raw)).pathname,
      method = init?.method ?? 'GET'
    requests.push({ path, method })
    if (path !== '/api/observability/reports' || method !== 'POST')
      throw new Error('Retained capability-seven history must not be reused')
    const body = JSON.parse(String(init?.body)) as { filters: typeof filters }
    expect(body.filters).toEqual(filters)
    return Response.json(current)
  })
  function Probe() {
    const query = useCompleteObservationReport(filters, undefined, 0, true)
    const content = query.data ? completeObservationReportContent(query.data) : null
    return content ? (
      <CompleteCost value={content.summary.metrics} />
    ) : (
      <p>Waiting for actual partial CNY</p>
    )
  }
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  expect(await screen.findByText('¥0.00012')).toBeTruthy()
  expect(
    screen.getByText(
      i18n.t('runObservability.recordedPartialCostCoverage', {
        priced: '0',
        partial: '1',
        records: '1',
      }),
    ),
  ).toBeTruthy()
  expect(requests).toEqual([{ path: '/api/observability/reports', method: 'POST' }])
  expect(JSON.stringify(client.getQueryData(oldKey))).toBe(original)
  const newKey = ['run-observability-complete', 'scope-metrics/13', filters, null, 0] as const
  expect(client.getQueryData(newKey)).toEqual(current)
})

test('cached family twelve wall alias is retained while the actual hook requests nullable running-state proof', async () => {
  if (current.state !== 'not-ready' || !current.facts) throw new Error('Original facts missing')
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  })
  const oldKey = ['run-observability-complete', 'scope-metrics/12', filters, null, 0] as const
  const legacy: CompleteObservationReport = {
    ...current,
    reportId: 'retained-system-wall-alias',
    facts: {
      ...current.facts,
      header: { ...current.facts.header, reportId: 'retained-system-wall-alias' },
      summary: {
        ...current.facts.summary,
        timing: { ...current.facts.summary.timing, wallMs: '8291976', runningMs: '8291976' },
      },
    },
  }
  client.setQueryData(oldKey, legacy)
  const original = JSON.stringify(client.getQueryData(oldKey))
  const corrected: CompleteObservationReport = {
    ...current,
    reportId: 'current-system-running-state-proof',
    facts: {
      ...current.facts,
      header: { ...current.facts.header, reportId: 'current-system-running-state-proof' },
      summary: {
        ...current.facts.summary,
        timing: {
          ...current.facts.summary.timing,
          wallMs: '8291976',
          runningMs: null,
          runningCoverage: { tasks: '1', observedTasks: '0' },
        },
      },
    },
  }
  const requests: { path: string; method: string }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const path = new URL(String(raw)).pathname,
      method = init?.method ?? 'GET'
    requests.push({ path, method })
    if (path !== '/api/observability/reports' || method !== 'POST')
      throw new Error('The retained System wall alias must not be reused')
    expect(JSON.parse(String(init?.body)).filters).toEqual(filters)
    return Response.json(corrected)
  })
  function Probe() {
    const query = useCompleteObservationReport(filters, undefined, 0, true)
    const content = query.data ? completeObservationReportContent(query.data) : null
    return content ? <CompleteObservationTiming report={content} /> : <p>Waiting for time proof</p>
  }
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  const coverage = await screen.findByText(
    i18n.t('runObservability.runningCoverage', { observed: '0', tasks: '1' }),
    { exact: false },
  )
  expect(coverage.parentElement?.textContent).toContain('—')
  expect(screen.queryByText(i18n.t('runObservability.recordedRunning'))).toBeNull()
  expect(requests).toEqual([{ path: '/api/observability/reports', method: 'POST' }])
  expect(JSON.stringify(client.getQueryData(oldKey))).toBe(original)
  expect(
    client.getQueryData(['run-observability-complete', 'scope-metrics/13', filters, null, 0]),
  ).toEqual(corrected)
})
