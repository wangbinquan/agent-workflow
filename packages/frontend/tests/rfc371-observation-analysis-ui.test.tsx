// RFC-371: analysis actions keep their frozen scope and open in the shared dialog,
// including the last row of a long page and nested maintenance confirmation.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import type {
  ObservationAnomaly,
  ObservationMaintenanceOperation,
  ObservationPhase,
} from '@agent-workflow/shared'
import { ObservationAnomalies } from '../src/components/observability/ObservationAnomalies'
import { ObservationMaintenance } from '../src/components/observability/ObservationMaintenance'
import { ObservationExecutionAnalysis } from '../src/components/observability/ObservationExecutionAnalysis'
import type { ReadableObservationReport } from '../src/components/observability/completeReportClient'
import i18n from '../src/i18n'

const calls = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), allowed: true }))
vi.mock('../src/api/client', () => ({ api: { get: calls.get, post: calls.post } }))
vi.mock('../src/hooks/useActor', () => ({ usePermission: () => calls.allowed }))
const NOW = Date.parse('2026-10-13T00:00:00Z')
const metrics = {
  state: 'ready' as const,
  invocations: '1',
  observedInvocations: '1',
  records: '1',
  tokens: { input: '9', cacheRead: '8', cacheWrite: '7', output: '6', total: '30' },
  cost: { currency: 'CNY' as const, state: 'complete' as const, amount: '0.000017' },
}
const task = (id: string) => ({
  task: {
    id,
    name: '原始任务 ' + id,
    status: 'done',
    parentTaskId: null,
    startedAt: NOW - 1000,
    finishedAt: NOW,
  },
  metrics,
  attemptCount: '1',
  timing: {
    wallMs: '1000',
    runningMs: '600',
    range: { from: NOW - 1000, to: NOW },
    intervals: { state: 'complete', cumulativeMs: '600', activeUnionMs: '600', unknown: '0' },
  },
})
const phase: ObservationPhase = {
  id: 'actual-review',
  taskId: 'left',
  nodeRunId: null,
  kind: 'human-wait',
  basis: 'review-round',
  startedAt: NOW - 500,
  endedAt: NOW - 100,
  status: 'closed',
  evidenceId: 'review-original-evidence',
  label: 'review',
}
vi.mock('../src/components/observability/completeReportClient', () => ({
  useCompleteObservationPage: (_report: unknown, section: string) => ({
    data: {
      items: section === 'tasks' ? [task('left'), task('right')] : [phase],
      total: section === 'tasks' ? '2' : '1',
      nextCursor: null,
    },
    error: null,
    isPending: false,
    isFetching: false,
    page: 1,
    first: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
    refetch: vi.fn(),
  }),
}))
const report = {
  header: { reportId: 'original-frozen-report', asOf: NOW, taskId: null },
  summary: {},
  counts: {},
} as unknown as ReadableObservationReport
const anomaly = (index: number): ObservationAnomaly => ({
  id: 'anomaly-' + index,
  key: 'tool/' + index,
  taskId: 'task-' + index,
  taskName: '原始任务 ' + index,
  rule: 'tool-timeout',
  state: 'firing',
  sourceState: 'available',
  samples: '1',
  minimumSamples: '1',
  windowMs: 60000,
  durationMs: 300000,
  firstObservedAt: NOW - 300000,
  lastObservedAt: NOW,
  firedAt: NOW,
  resolvedAt: null,
  evidence: ['original-tool-' + index],
  revision: '17',
})
const operation: ObservationMaintenanceOperation = {
  id: 'original-operation',
  request: {
    requestKey: 'original-request-key',
    reportId: report.header.reportId,
    mode: 'backfill',
  },
  filters: { from: 0, to: NOW, timezone: 'UTC' },
  state: 'preview',
  sourceRevision: '17',
  scopeDigest: 'a'.repeat(64),
  createdAt: NOW,
  confirmedAt: null,
  confirmationOrder: null,
  tasks: '211',
  invocations: '211',
  records: '10001',
  processed: '0',
  unpricedRecords: '1',
  knownOriginalCny: '0.000017',
  knownProposedCny: null,
  knownPairedDeltaCny: null,
  gaps: ['unpriced'],
}
let client: QueryClient
function show(children: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
}
beforeEach(async () => {
  calls.get.mockReset()
  calls.post.mockReset()
  calls.allowed = true
  await i18n.changeLanguage('zh-CN')
})
afterEach(() => {
  cleanup()
  client?.clear()
})

test.each([
  ['zh-CN', '开始时间', '结束时间'],
  ['en', 'Started at', 'Ended at'],
])('anomaly time headers render translated labels in %s', async (language, start, end) => {
  await i18n.changeLanguage(language)
  calls.get.mockResolvedValue({ items: [anomaly(0)], total: '1', nextCursor: null, asOf: NOW })
  show(<ObservationAnomalies from={0} to={NOW} />)
  expect(await screen.findByRole('columnheader', { name: start })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: end })).toBeTruthy()
  expect(screen.queryByText('runObservability.start')).toBeNull()
  expect(screen.queryByText('runObservability.end')).toBeNull()
})

test('the last anomaly opens above a long table and closes with focus and page intact', async () => {
  calls.get.mockResolvedValue({
    items: Array.from({ length: 211 }, (_, index) => anomaly(index)),
    total: '10001',
    nextCursor: 'next-original',
    asOf: NOW,
  })
  show(<ObservationAnomalies from={0} to={NOW} />)
  const buttons = await screen.findAllByRole('button', { name: '工具执行超时' })
  expect(buttons).toHaveLength(211)
  const last = buttons[210]!
  last.focus()
  fireEvent.click(last)
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('original-tool-210')).toBeTruthy()
  expect(dialog.closest('.dialog__overlay')).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(last)
  expect(screen.getByText('原始任务 210')).toBeTruthy()
})

test('a changed anomaly period starts at its own first page', async () => {
  calls.get.mockImplementation(async (url: string) => ({
    items: [anomaly(1)],
    total: '211',
    nextCursor: url.includes('after=') ? null : 'original-page-2',
    asOf: NOW,
  }))
  const view = show(<ObservationAnomalies from={0} to={NOW} />)
  fireEvent.click(await screen.findByRole('button', { name: '下一页' }))
  await waitFor(() =>
    expect(
      calls.get.mock.calls.some(([url]) => String(url).includes('after=original-page-2')),
    ).toBe(true),
  )
  view.rerender(
    <QueryClientProvider client={client}>
      <ObservationAnomalies from={1000} to={NOW} />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(calls.get.mock.calls.at(-1)?.[0]).toContain('from=1000'))
  expect(calls.get.mock.calls.at(-1)?.[0]).not.toContain('after=')
})

test('preview retries keep one request key and applying sends the frozen digest and typed confirmation', async () => {
  calls.get.mockResolvedValue(operation)
  calls.post
    .mockRejectedValueOnce(new Error('preview transport failed'))
    .mockResolvedValue(operation)
  show(<ObservationMaintenance report={report} />)
  fireEvent.click(screen.getByRole('button', { name: '预览影响' }))
  const outer = screen.getByRole('dialog')
  fireEvent.click(within(outer).getByRole('button', { name: '预览影响' }))
  await screen.findByText('preview transport failed')
  fireEvent.click(within(outer).getByRole('button', { name: '预览影响' }))
  await waitFor(() => expect(within(outer).getByText('¥0.000017')).toBeTruthy())
  expect(calls.post.mock.calls[0]?.[1].requestKey).toBe(calls.post.mock.calls[1]?.[1].requestKey)
  expect(calls.post.mock.calls[1]?.[1].reportId).toBe('original-frozen-report')
  fireEvent.click(within(outer).getByRole('button', { name: '确认应用' }))
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
  fireEvent.click(within(outer).getByRole('button', { name: '确认应用' }))
  const confirmation = screen.getAllByRole('dialog').at(-1)!
  const apply = within(confirmation).getByRole('button', { name: '确认应用' }) as HTMLButtonElement
  expect(apply.disabled).toBe(true)
  fireEvent.change(within(confirmation).getByTestId('confirm-input'), {
    target: { value: ' APPLY ' },
  })
  fireEvent.click(apply)
  await waitFor(() =>
    expect(calls.post).toHaveBeenCalledWith(
      '/api/observability/maintenance/original-operation/confirm',
      { expectedDigest: operation.scopeDigest, confirmation: 'APPLY' },
    ),
  )
})

test('execution comparison uses the frozen report and an original wait opens in the shared dialog', async () => {
  calls.get.mockResolvedValue({
    revision: '17',
    asOf: NOW,
    basis: 'task-subtree-lifecycle',
    left: task('left'),
    right: task('right'),
    criticalPath: { state: 'not-ready', reasons: ['causal-dependencies-unobserved'] },
  })
  show(<ObservationExecutionAnalysis report={report} />)
  const leftSelect = screen.getByRole('combobox', { name: '左侧任务' })
  fireEvent.click(leftSelect)
  const leftOptions = document.getElementById(leftSelect.getAttribute('aria-controls')!)!
  fireEvent.mouseDown(within(leftOptions).getByRole('option', { name: '原始任务 left' }))
  expect(leftSelect.textContent).toContain('原始任务 left')
  const rightSelect = screen.getByRole('combobox', { name: '右侧任务' })
  fireEvent.click(rightSelect)
  const rightOptions = document.getElementById(rightSelect.getAttribute('aria-controls')!)!
  fireEvent.mouseDown(within(rightOptions).getByRole('option', { name: '原始任务 right' }))
  expect(rightSelect.textContent).toContain('原始任务 right')
  await waitFor(() =>
    expect(calls.get).toHaveBeenCalledWith(
      '/api/observability/reports/original-frozen-report/comparison?left=left&right=right',
    ),
  )
  await waitFor(() => expect(document.querySelectorAll('[data-token-buckets]')).toHaveLength(2))
  calls.get.mockRejectedValue(new Error('comparison read failed'))
  await client.invalidateQueries({ queryKey: ['observation-comparison'] })
  await screen.findByText('comparison read failed')
  expect(document.querySelectorAll('[data-token-buckets]')).toHaveLength(0)
  const waitRow = screen.getByRole('rowheader', { name: '等待审核' }).closest('tr')!
  const wait = within(waitRow).getByRole('button', { name: i18n.t('runObservability.detail') })
  expect(wait.getAttribute('data-execution-id')).toBe('actual-review')
  fireEvent.click(wait)
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('review-round · review-original-evidence')).toBeTruthy()
  expect(dialog.closest('.dialog__overlay')).toBeTruthy()
})

test('maintenance controls require the existing settings permission', () => {
  calls.allowed = false
  show(<ObservationMaintenance report={report} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(calls.get).not.toHaveBeenCalled()
})
