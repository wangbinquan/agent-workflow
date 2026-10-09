// State clocks, wall time and owner intervals stay separate on both readable report states.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type {
  CompleteObservationReportContent,
  CompleteObservationTask,
} from '@agent-workflow/shared'
import { CompleteObservationTiming } from '../src/components/observability/CompleteObservationDetails'
import i18n from '../src/i18n'

const NOW = Date.parse('2026-10-09T00:00:00Z')
const metrics = { state: 'not-ready' as const, gaps: ['native-capture-unobserved'] }
function timeReport(root: boolean, recorded?: string): CompleteObservationReportContent {
  const task: CompleteObservationTask = {
    task: {
      id: 'system:memory-distill:original-job',
      name: 'Original memory',
      status: 'done',
      parentTaskId: null,
      startedAt: NOW - 8291976,
      finishedAt: NOW,
      runningMs: null,
      runningSince: null,
    },
    metrics,
    attemptCount: '4',
    timing: {
      wallMs: '8291976',
      runningMs: null,
      range: { from: NOW - 8291976, to: NOW },
      intervals: { state: 'complete', cumulativeMs: '82901', activeUnionMs: '82901', unknown: '0' },
    },
  }
  return {
    header: {
      reportId: 'original-time-report',
      projectionVersion: 2,
      generation: 'original-generation',
      snapshotId: 'original-snapshot',
      asOf: NOW,
      sourceRevision: 'original-revision',
      actorScope: 'original-reader',
      authorizationRevision: '0',
      filters: { from: NOW - 8291976, to: NOW + 1, timezone: 'UTC' },
      taskId: root ? task.task.id : null,
    },
    summary: {
      metrics,
      inventory: { tasks: recorded === undefined ? '1' : '2', attempts: '4', invocations: '4' },
      statuses: { done: recorded === undefined ? '1' : '2' },
      timing: {
        wallMs: '8291976',
        runningMs: null,
        runningCoverage: {
          tasks: recorded === undefined ? '1' : '2',
          observedTasks: recorded === undefined ? '0' : '1',
        },
        ...(recorded === undefined ? {} : { recordedRunningMs: recorded }),
        p50Ms: '8291976',
        p95Ms: '8291976',
        unknown: '0',
      },
      rootTask: root ? task : null,
    },
    counts: {},
  }
}
beforeEach(async () => {
  await i18n.changeLanguage('zh')
})
afterEach(() => cleanup())

for (const language of ['zh', 'en']) {
  test(
    language + ' System detail keeps wall/cumulative/union and omits inapplicable Task state time',
    async () => {
      await i18n.changeLanguage(language)
      render(<CompleteObservationTiming report={timeReport(true)} />)
      expect(screen.queryByText(i18n.t('runObservability.running'))).toBeNull()
      expect(screen.queryByText(i18n.t('runObservability.recordedRunning'))).toBeNull()
      expect(
        screen.getByText(i18n.t('runObservability.wall')).nextElementSibling?.textContent,
      ).toBe(BigInt(8291976).toLocaleString(language) + ' ms')
      for (const key of ['cumulative', 'union']) {
        expect(
          screen.getByText(i18n.t('runObservability.' + key)).nextElementSibling?.textContent,
        ).toBe(BigInt(82901).toLocaleString(language) + ' ms')
      }
    },
  )

  for (const recorded of ['9007199254740993', '0']) {
    test(
      language + ' mixed coverage retains exact observed running subtotal ' + recorded,
      async () => {
        await i18n.changeLanguage(language)
        render(<CompleteObservationTiming report={timeReport(false, recorded)} />)
        const value = screen.getByText(
          i18n.t('runObservability.recordedRunning'),
        ).nextElementSibling
        expect(value?.textContent).toContain(BigInt(recorded).toLocaleString(language) + ' ms')
        expect(value?.textContent).toContain(
          i18n.t('runObservability.runningCoverage', { observed: '1', tasks: '2' }),
        )
        expect(screen.queryByText(i18n.t('runObservability.running'))).toBeNull()
      },
    )
  }

  test(language + ' all-unobserved running time stays a dash with exact coverage', async () => {
    await i18n.changeLanguage(language)
    render(<CompleteObservationTiming report={timeReport(false)} />)
    const value = screen.getByText(i18n.t('runObservability.running')).nextElementSibling
    expect(value?.textContent).toContain('—')
    expect(value?.textContent).toContain(
      i18n.t('runObservability.runningCoverage', { observed: '0', tasks: '1' }),
    )
    expect(screen.queryByText(i18n.t('runObservability.recordedRunning'))).toBeNull()
  })
}

test('ordinary Task running-state history remains distinct from Agent activity', () => {
  const report = timeReport(true)
  if (!report.summary.rootTask) throw new Error('Original root fixture missing')
  const original = report.summary.rootTask
  const ordinary: CompleteObservationReportContent = {
    ...report,
    summary: {
      ...report.summary,
      rootTask: {
        ...original,
        task: { ...original.task, id: 'original-ordinary-task', runningMs: 123456 },
        timing: { ...original.timing, runningMs: '123456' },
      },
    },
  }
  render(<CompleteObservationTiming report={ordinary} />)
  expect(screen.getByText(i18n.t('runObservability.running')).nextElementSibling?.textContent).toBe(
    BigInt(123456).toLocaleString(i18n.language) + ' ms',
  )
  expect(screen.getByText(i18n.t('runObservability.union')).nextElementSibling?.textContent).toBe(
    BigInt(82901).toLocaleString(i18n.language) + ' ms',
  )
  expect(screen.queryByText(i18n.t('runObservability.recordedRunning'))).toBeNull()
})
