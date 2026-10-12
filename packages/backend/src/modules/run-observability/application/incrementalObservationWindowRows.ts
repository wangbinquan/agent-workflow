import type {
  CompleteHistoricalObservationExecution,
  CompleteObservationAllocation,
  CompleteObservationAttempt,
  CompleteObservationSection,
  CompleteObservationTask,
} from '@agent-workflow/shared'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import {
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
} from '../domain/completeObservationMetrics'
import { completeObservationAttemptTiming } from '../domain/completeObservationTiming'
import type { incrementalObservationWindow } from './incrementalObservationWindow'

/** Every drill-down uses the same retained window membership as its header. */
export function incrementalObservationWindowRows(
  rows: readonly unknown[],
  section: CompleteObservationSection,
  parent: string | null,
  window: ReturnType<typeof incrementalObservationWindow>,
  originalTasks: readonly CompleteObservationTask[],
  asOf: number,
): unknown[] {
  const calls = new Map(window.invocations.map((row) => [row.invocationId, row])),
    refs = new Map(window.historical.map((row) => [row.execution.referenceId, row]))
  const tasks = new Map(originalTasks.map((row) => [row.task.id, row.task]))
  if (section === 'invocations')
    return rows.flatMap((row) => {
      const call = calls.get((row as { invocationId: string }).invocationId)
      return call ? [call] : []
    })
  if (section === 'native-captures' || section === 'platform-captures')
    return rows.filter((row) => calls.has((row as { invocationId: string }).invocationId))
  if (section === 'allocations') {
    const selected = new Set(
      window.timeRows
        .filter((row) => row.partition === 'in-window' && row.invocation !== null)
        .map((row) => JSON.stringify([row.sourceId, row.recordId, row.invocation!.invocationId])),
    )
    return rows.filter((raw) => {
      const row = raw as CompleteObservationAllocation
      return selected.has(JSON.stringify([row.sourceId, row.recordId, row.invocation.invocationId]))
    })
  }
  if (section === 'attempts') {
    const folds = new Map<string, ReturnType<typeof emptyCompleteObservationFold>>()
    const add = (id: string, metrics: Parameters<typeof completeMetricsFold>[0]) => {
      const fold = folds.get(id) ?? emptyCompleteObservationFold()
      mergeCompleteObservationFold(fold, completeMetricsFold(metrics))
      folds.set(id, fold)
    }
    for (const call of window.invocations) if (call.nodeRunId) add(call.nodeRunId, call.metrics)
    for (const row of window.historical)
      if (row.execution.nodeRunId && !row.coveredByAcceptedRecords && row.referenceRole !== 'owner')
        add(row.execution.nodeRunId, row.metrics)
    const selectedTasks = new Set(window.tasks.map((row) => row.task.id))
    return rows.flatMap((raw) => {
      const row = raw as CompleteObservationAttempt & { taskId: string },
        task = tasks.get(row.taskId)
      if (!selectedTasks.has(row.taskId) || !task) return []
      const timing = completeObservationAttemptTiming(task, row, asOf)
      return [
        {
          ...row,
          metrics: completeObservationMetrics(folds.get(row.id) ?? emptyCompleteObservationFold()),
          durationMs: timing.durationMs,
          open: timing.open,
        },
      ]
    })
  }
  if (section === 'historical-executions' && parent !== 'original-source')
    return rows.flatMap((raw) => {
      const row = refs.get((raw as CompleteHistoricalObservationExecution).execution.referenceId)
      return row ? [row] : []
    })
  if (section === 'historical-records' && parent !== 'original-source') {
    const selected = new Set(
      window.timeRows
        .filter((row) => row.invocation === null && row.partition !== 'outside-window')
        .map((row) => JSON.stringify([row.sourceId, row.recordId])),
    )
    return rows.filter((row) => {
      const record = row as { nativeSource: string; recordId: string }
      return selected.has(JSON.stringify([record.nativeSource, record.recordId]))
    })
  }
  if (section === 'historical-record-references')
    return rows.filter((row) => refs.has((row as { referenceId: string }).referenceId))
  if (section === 'span-facts' || section === 'span-captures' || section === 'span-statuses')
    return []
  return [...rows]
}
