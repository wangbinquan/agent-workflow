// AW-R06: a missing consumption clock preserves known four-bin values and CNY in the shared Dialog.
import { useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type {
  CompleteObservationMetrics,
  CompleteObservationTimePartition,
} from '@agent-workflow/shared'
import { CompleteObservationTimeDetails } from '../src/components/observability/CompleteObservationTimeDetails'
import type { ReadableObservationReport } from '../src/components/observability/completeReportClient'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
test('unassigned rows retain input/cache/output and yuan, paginate the sealed pool, and expose normal Task navigation', async () => {
  await i18n.changeLanguage('zh')
  setBaseUrl('http://usage-time.test')
  setToken('test')
  const metrics: CompleteObservationMetrics = {
    state: 'ready',
    invocations: '1',
    observedInvocations: '1',
    records: '1',
    tokens: { input: '11', cacheRead: '13', cacheWrite: '17', output: '19', total: '60' },
    cost: { currency: 'CNY', state: 'complete', amount: '0.25' },
  }
  const row: CompleteObservationTimePartition = {
    identity: 'original-time',
    partition: 'unassigned-time',
    kind: 'accepted',
    recordId: 'original-step',
    sourceId: 'original-source',
    invocation: null,
    task: {
      id: 'original-task',
      name: '时间未确认的任务',
      status: 'done',
      parentTaskId: null,
      startedAt: 100,
      finishedAt: 200,
      runningMs: 100,
      runningSince: null,
    },
    occurrence: { occurredAt: null, basis: null, reason: 'time-unobserved' },
    metrics,
  }
  const report: ReadableObservationReport = {
    header: {
      reportId: 'original-window',
      projectionVersion: 2,
      generation: 'original-generation',
      snapshotId: 'original-snapshot',
      asOf: 300,
      sourceRevision: 'original-source',
      actorScope: 'reader',
      authorizationRevision: '1',
      filters: { from: 100, to: 200, timezone: 'UTC', cohort: 'usage' },
      taskId: null,
    },
    summary: {
      metrics: { state: 'not-ready', gaps: ['usage-time-unassigned'] },
      inventory: { tasks: '1', attempts: '1', invocations: '1' },
      statuses: { done: '1' },
      timing: { p50Ms: '100', p95Ms: '100', wallMs: '100', runningMs: '100', unknown: '0' },
      rootTask: null,
    },
    counts: { 'time-unassigned': '1' },
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
    const url = new URL(String(raw))
    expect(url.searchParams.get('section')).toBe('time-unassigned')
    return Response.json({
      reportId: report.header.reportId,
      section: 'time-unassigned',
      parent: null,
      items: [row],
      total: '1',
      nextCursor: null,
    })
  })
  const onTask = vi.fn(),
    onClose = vi.fn()
  function View() {
    const trigger = useRef<HTMLElement | null>(null)
    return (
      <CompleteObservationTimeDetails
        report={report}
        onTask={onTask}
        onClose={onClose}
        triggerRef={trigger}
      />
    )
  }
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <View />
    </QueryClientProvider>,
  )
  const task = await screen.findByRole('button', { name: '时间未确认的任务' })
  const dialog = screen.getByRole('dialog', { name: '时间未分配明细' })
  expect(within(dialog).getByText('原始发生时间未采集')).toBeDefined()
  expect(dialog.querySelectorAll('[data-token-bucket]').length).toBe(4)
  expect(dialog.textContent).toContain('¥0.25')
  fireEvent.click(task)
  expect(onTask).toHaveBeenCalledWith('original-task', task)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalled()
})
