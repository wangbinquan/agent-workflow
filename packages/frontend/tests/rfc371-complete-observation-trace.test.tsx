// RFC-371: retained facts keep their historical geometry even when completeness is unknown.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { CompleteObservationTraceStatus, ObservationSpanDetail } from '@agent-workflow/shared'
import { CompleteObservationTrace } from '../src/components/observability/CompleteObservationTrace'
import type { ReadyObservationReport } from '../src/components/observability/completeReportClient'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

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
const report: ReadyObservationReport = {
  state: 'ready',
  header: {
    reportId: 'full',
    projectionVersion: 2,
    generation: 'original',
    snapshotId: 'snapshot',
    asOf: 5000,
    sourceRevision: 'source',
    actorScope: 'reader',
    authorizationRevision: '0',
    filters: { from: 0, to: 6000, timezone: 'UTC' },
    taskId: 'task',
  },
  summary: {
    metrics: { state: 'not-applicable' },
    inventory: {
      tasks: '1',
      attempts: '1',
      invocations: '1',
      numericRecords: '0',
      nativeCaptures: '0',
    },
    statuses: {},
    timing: { p50Ms: null, p95Ms: null, wallMs: '1000', runningMs: '1000', unknown: '0' },
    rootTask: null,
  },
  counts: { 'span-facts': '2', 'span-statuses': '1' },
}
const span = (key: string, known = true): ObservationSpanDetail => ({
  fact: {
    schemaVersion: 1,
    invocationId: 'call',
    spanKey: key,
    scope: {
      sourceNamespace: 'source',
      rootSessionId: 'root',
      nativeSessionId: 'root',
      parentNativeSessionId: null,
      ancestors: [],
      callId: key,
      kind: 'model',
    },
    label: key,
    parentCallId: null,
    model: null,
    measurementRecordId: null,
    state: {
      startedAt: known ? 1200 : null,
      endedAt: known ? 1500 : null,
      nativeObservedAt: 1500,
      status: known ? 'success' : 'unknown',
    },
    capturedAt: 1500,
  },
  durationMs: known ? 300 : null,
  quality: known ? 'complete' : 'partial',
  reasons: known ? [] : ['span-time-unknown'],
  usage: null,
  cost: null,
})
function fixture(status: CompleteObservationTraceStatus) {
  const paths: URL[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input))
    paths.push(url)
    const section = url.searchParams.get('section'),
      after = url.searchParams.get('after')
    return Response.json({
      reportId: 'full',
      section,
      parent: JSON.stringify(['attempt', 'run']),
      items: section === 'span-statuses' ? [status] : [span(after ? 'last' : 'first')],
      total: section === 'span-statuses' ? '1' : '2',
      nextCursor: section === 'span-facts' && !after ? 'tail' : null,
    })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <CompleteObservationTrace report={report} nodeRunId="run" />
    </QueryClientProvider>,
  )
  return paths
}
test('a missing full capture shows a warning and preserves positive historical bar width without complete counts', async () => {
  fixture({
    taskId: 'task',
    nodeRunId: 'run',
    state: 'not-ready',
    reasons: ['span-capture-pending'],
    knownRange: { from: 1000, to: 2000 },
  })
  const row = await screen.findByRole('button', { name: '模型 · first' })
  await waitFor(() =>
    expect((row.querySelector('.execution-swimlane__bar') as HTMLElement)?.style.width).toBe('30%'),
  )
  expect(screen.getByText(i18n.t('runObservability.tracePartial'))).not.toBeNull()
  expect(
    screen.queryByText(i18n.t('runObservability.traceCompleteCount', { total: '2' })),
  ).toBeNull()
})
test('the last retained page keeps the same frozen scope and the complete count is independent of the visible page', async () => {
  const paths = fixture({
    taskId: 'task',
    nodeRunId: 'run',
    state: 'complete',
    spanCount: '2',
    captureCount: '1',
    priorRepairCount: '0',
    range: { from: 1000, to: 2000 },
  })
  await screen.findByRole('button', { name: '模型 · first' })
  const next = screen
    .getAllByRole('button', { name: i18n.t('runObservability.next') })
    .find((button) => !button.hasAttribute('disabled'))!
  fireEvent.click(next)
  await screen.findByRole('button', { name: '模型 · last' })
  expect(screen.queryByRole('button', { name: '模型 · first' })).toBeNull()
  expect(
    screen.getByText(i18n.t('runObservability.traceCompleteCount', { total: '2' })),
  ).not.toBeNull()
  expect(
    paths.every((url) => url.searchParams.get('parent') === JSON.stringify(['attempt', 'run'])),
  ).toBe(true)
  expect(paths.some((url) => url.searchParams.get('after') === 'tail')).toBe(true)
  expect(
    screen
      .getAllByRole('button', { name: i18n.t('runObservability.next') })
      .every((button) => button.hasAttribute('disabled')),
  ).toBe(true)
})
