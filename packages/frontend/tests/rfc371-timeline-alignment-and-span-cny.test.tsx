// RFC-371: display distant tasks without changing actual intervals or hiding known partial CNY.
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { CompleteObservationAttempt, ObservationSpanDetail } from '@agent-workflow/shared'
import { CompleteObservationTimeline } from '../src/components/observability/CompleteObservationDetails'
import { CompleteObservationTrace } from '../src/components/observability/CompleteObservationTrace'
import { projectCompleteAttemptTimeline } from '../src/components/observability/completeAttemptTimeline'
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
    asOf: 3700000,
    sourceRevision: 'source',
    actorScope: 'reader',
    authorizationRevision: '0',
    filters: { from: 0, to: 4000000, timezone: 'UTC' },
    taskId: null,
  },
  summary: {
    metrics: { state: 'not-applicable' },
    inventory: {
      tasks: '2',
      attempts: '3',
      invocations: '1',
      numericRecords: '1',
      nativeCaptures: '0',
    },
    statuses: {},
    timing: { p50Ms: '20000', p95Ms: '20000', wallMs: '40000', runningMs: '40000', unknown: '0' },
    rootTask: null,
  },
  counts: { attempts: '3', 'span-facts': '1', 'span-statuses': '1' },
}
type Attempt = CompleteObservationAttempt & { readonly taskId: string; readonly taskName: string }
const attempt = (id: string, taskId: string, startedAt: number, finishedAt: number): Attempt => ({
  id,
  nodeId: id,
  taskId,
  taskName: taskId,
  startedAt,
  finishedAt,
  status: 'completed',
  retryIndex: 0,
  iteration: 0,
  wgRound: null,
  reviewIteration: 0,
  metrics: { state: 'not-applicable' },
  durationMs: String(finishedAt - startedAt),
  open: false,
})
const attempts = [
  attempt('Agent A', 'first task', 1000, 11000),
  attempt('Agent B', 'first task', 6000, 21000),
  attempt('Agent C', 'distant task', 3601000, 3621000),
]
function fixture(items: Record<string, readonly unknown[]>) {
  const requests: URL[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    const section = url.searchParams.get('section')!
    return Response.json({
      reportId: 'full',
      section,
      parent: url.searchParams.get('parent'),
      items: items[section] ?? [],
      total: String(items[section]?.length ?? 0),
      nextCursor: null,
    })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return {
    requests,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  }
}
test('default task alignment preserves parallel offsets, and keyboard selection restores actual time', async () => {
  const { wrapper, requests } = fixture({ attempts })
  const view = render(<CompleteObservationTimeline report={report} />, { wrapper })
  const a = await screen.findByRole('button', {
    name: i18n.t('runObservability.detail') + ' · Agent A',
  })
  const b = screen.getByRole('button', { name: i18n.t('runObservability.detail') + ' · Agent B' })
  const c = screen.getByRole('button', { name: i18n.t('runObservability.detail') + ' · Agent C' })
  const bar = (row: HTMLElement) => row.querySelector<HTMLElement>('.execution-swimlane__bar')!
  expect(bar(a).style.width).toBe('50%')
  expect(bar(b).style.left).toBe('25%')
  expect(bar(b).style.width).toBe('75%')
  expect(bar(c).style.left).toBe('0%')
  expect(bar(c).style.width).toBe('100%')
  expect(view.container.textContent).toContain(i18n.t('runObservability.timelineAlignedHint'))
  expect(c.textContent).toContain('20,000 ms')
  const aligned = screen.getByRole('radio', { name: i18n.t('runObservability.timelineAlignTasks') })
  aligned.focus()
  fireEvent.keyDown(aligned, { key: 'ArrowRight' })
  const actual = screen.getByRole('radio', { name: i18n.t('runObservability.timelineActualTime') })
  expect(actual.getAttribute('aria-checked')).toBe('true')
  expect(document.activeElement).toBe(actual)
  expect(Number.parseFloat(bar(c).style.left)).toBeGreaterThan(99)
  expect(Number.parseFloat(bar(c).style.width)).toBeLessThan(1)
  expect(c.textContent).toContain(new Date(3601000).toLocaleString(i18n.language))
  fireEvent.keyDown(actual, { key: 'ArrowLeft' })
  expect(bar(c).style.width).toBe('100%')
  expect(requests).toHaveLength(1)
  expect(requests[0]!.searchParams.get('section')).toBe('attempts')
}, 10000)
test('one-task reports retain their original actual time axis without a cross-task picker', async () => {
  const { wrapper } = fixture({ attempts: attempts.slice(0, 2) })
  const view = render(
    <CompleteObservationTimeline
      report={{
        ...report,
        header: { ...report.header, taskId: 'first task' },
        summary: {
          ...report.summary,
          inventory: { ...report.summary.inventory, tasks: '1', attempts: '2' },
        },
        counts: { ...report.counts, attempts: '2' },
      }}
    />,
    { wrapper },
  )
  await screen.findByRole('button', { name: i18n.t('runObservability.detail') + ' · Agent A' })
  expect(screen.queryByRole('radiogroup')).toBeNull()
  expect(view.container.querySelector<HTMLElement>('.execution-swimlane__bar')!.style.width).toBe(
    '50%',
  )
}, 10000)
test('unknown, reversed, zero and open intervals preserve their original boundaries and frozen asOf', () => {
  const rows = Object.freeze([
    Object.freeze({ taskId: 'a', startedAt: 1000, finishedAt: null, open: false }),
    Object.freeze({ taskId: 'a', startedAt: 2000, finishedAt: 2000, open: false }),
    Object.freeze({ taskId: 'a', startedAt: 3000, finishedAt: 2000, open: false }),
    Object.freeze({ taskId: 'b', startedAt: 1000000, finishedAt: null, open: true }),
    Object.freeze({ taskId: 'c', startedAt: null, finishedAt: 500, open: false }),
  ])
  const before = JSON.stringify(rows)
  const projected = projectCompleteAttemptTimeline(rows, 1005000, 'task-relative')
  expect(projected.intervals).toEqual([
    { start: 0, end: null },
    { start: 1000, end: 1000 },
    { start: 2000, end: 1000 },
    { start: 0, end: 5000 },
    { start: null, end: null },
  ])
  expect(projected.from).toBe(0)
  expect(projected.to).toBe(5000)
  expect(projectCompleteAttemptTimeline(rows, 1005000, 'absolute').intervals[4]).toEqual({
    start: null,
    end: 500,
  })
  expect(JSON.stringify(rows)).toBe(before)
})
test('every one of 10001 supplied rows and its final actual interval survives display projection', () => {
  const rows = Object.freeze(
    Array.from({ length: 10001 }, (_, index) =>
      Object.freeze({
        taskId: String(index),
        startedAt: index * 1000,
        finishedAt: index * 1000 + 25,
        open: false,
      }),
    ),
  )
  const projected = projectCompleteAttemptTimeline(rows, 20000000, 'task-relative')
  expect(projected.intervals).toHaveLength(10001)
  expect(projected.intervals.every((value) => value.start === 0 && value.end === 25)).toBe(true)
  expect(projected.to).toBe(25)
  expect(projectCompleteAttemptTimeline(rows, 20000000, 'absolute').intervals[10000]).toEqual({
    start: 10000000,
    end: 10000025,
  })
  expect(rows[10000]!.finishedAt).toBe(10000025)
})
const span: ObservationSpanDetail = {
  fact: {
    schemaVersion: 1,
    invocationId: 'call',
    spanKey: 'span',
    scope: {
      sourceNamespace: 'source',
      rootSessionId: 'root',
      nativeSessionId: 'root',
      parentNativeSessionId: null,
      ancestors: [],
      callId: 'span',
      kind: 'model',
    },
    label: 'cost model',
    parentCallId: null,
    model: null,
    measurementRecordId: null,
    state: { startedAt: 1000, endedAt: 2000, nativeObservedAt: 2000, status: 'success' },
    capturedAt: 2000,
  },
  durationMs: 1000,
  quality: 'partial',
  reasons: ['span-time-unknown'],
  usage: { input: '123', cacheRead: null, cacheWrite: '0', output: null },
  cost: null,
}
for (const [amount, completeness] of [
  ['0.000123', 'partial'],
  ['0', 'partial'],
  ['0.000123', 'complete'],
  [null, 'unpriced'],
] as const)
  test(
    'span detail retains actual CNY ' + String(amount) + ' with ' + completeness + ' evidence',
    async () => {
      const { wrapper } = fixture({
        'span-statuses': [
          {
            taskId: 'first task',
            nodeRunId: 'run',
            state: 'not-ready',
            reasons: ['span-capture-pending'],
            knownRange: { from: 1000, to: 2000 },
          },
        ],
        'span-facts': [{ ...span, cost: { currency: 'CNY', amountDecimal: amount, completeness } }],
      })
      render(<CompleteObservationTrace report={report} nodeRunId="run" />, { wrapper })
      fireEvent.click(await screen.findByRole('button', { name: '模型 · cost model' }))
      const dialog = await screen.findByRole('dialog')
      const cost = [...dialog.querySelectorAll('dt')].find(
        (node) => node.textContent === i18n.t('runObservability.cost'),
      )!.nextElementSibling!
      expect(cost.textContent).toBe(
        (amount === null ? '—' : '¥' + amount) +
          (completeness === 'partial' ? ' · ' + i18n.t('runObservability.partial') : ''),
      )
      expect(
        [...dialog.querySelectorAll('.observation-token-buckets dd')].map(
          (node) => node.textContent,
        ),
      ).toEqual(['123', '—', '0', '—'])
      expect(within(dialog).getByText('1,000 ms')).toBeTruthy()
    },
    10000,
  )
