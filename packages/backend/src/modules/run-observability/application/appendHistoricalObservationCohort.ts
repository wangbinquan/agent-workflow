import type { CompleteObservationAttempt, CompleteObservationTask } from '@agent-workflow/shared'
import type { CompleteObservationCohortInput } from '../ports/completeObservationReport'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import {
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type { HistoricalObservationStage } from './historicalObservationSource'
import type { completeHistoricalObservationAllocation } from './completeHistoricalObservationAllocation'
import type { completeObservationReportRows } from './completeObservationReportRows'
import type { completeObservationReportDimensions } from './completeObservationReportDimensions'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingTraversal } from './completeWorkingTraversal'

/** Historical references and native numbers stay separate; accepted counters/prices are unchanged. */
export async function appendHistoricalObservationCohort(
  input: CompleteObservationCohortInput,
  stage: HistoricalObservationStage,
  history: ReturnType<typeof completeHistoricalObservationAllocation>,
  output: ReturnType<typeof completeObservationReportRows>,
  dimensions: ReturnType<typeof completeObservationReportDimensions>,
  addTrend: (at: number, fold: CompleteObservationFold) => Promise<void>,
) {
  const space = (name: string) => input.namespace + '/' + name
  const tasks = completeWorkingCache<CompleteObservationTask>(
    input.rows,
    space('task-summaries'),
    input.signal,
  )
  const standalone = emptyCompleteObservationFold()
  let nativeRecords = 0n,
    references = 0n
  async function addTask(id: string, next: CompleteObservationFold) {
    let task = await tasks.get(id)
    if (!task) {
      const original = await input.rows.get<CompleteObservationTask>(
        space('task-original-summaries'),
        id,
      )
      if (!original) return false
      task = { ...original, metrics: { state: 'not-applicable' }, attemptCount: '0' }
    }
    const fold = completeMetricsFold(task.metrics)
    mergeCompleteObservationFold(fold, next)
    await tasks.put(id, { ...task, metrics: completeObservationMetrics(fold) })
    await input.rows.put(space('historical-selected-tasks'), { key: id, document: true })
    return true
  }
  for await (const allocation of history.allocations()) {
    const record = allocation.record,
      parent = JSON.stringify([record.nativeSource, record.recordId]),
      key = input.keyOf(parent)
    await output.append('historical-records', 'original-source', key, record)
    if (record.scopeMatch !== 'excluded') {
      await output.append('historical-records', null, key, record)
      if (!record.coveredByAcceptedRecords) nativeRecords++
      if (allocation.task)
        await output.append('historical-records', allocation.task.id, key, record)
      if (input.task)
        await output.append(
          'historical-records',
          JSON.stringify(['task-tree', input.task.id]),
          key,
          record,
        )
    }
    for await (const reference of history.references(record)) {
      await output.append(
        'historical-record-references',
        parent,
        input.keyOf(reference.referenceId),
        reference,
      )
      await output.append(
        'historical-records',
        JSON.stringify(['historical-execution', reference.referenceId]),
        key,
        record,
      )
    }
    for await (const version of history.versions(record))
      await output.append('historical-record-versions', parent, version.versionFingerprint, version)
    const fold = {
      ...allocation.fold,
      historicalReferences: '0',
      observedHistoricalReferences: '0',
    }
    if (record.scopeMatch !== 'excluded') {
      const assigned = allocation.task !== null && (await addTask(allocation.task.id, fold))
      if (!assigned) {
        mergeCompleteObservationFold(standalone, fold)
        if (allocation.cohortAt !== null && record.scopeMatch === 'matched')
          await addTrend(allocation.cohortAt, fold)
      }
      await dimensions.addHistorical(allocation, () => history.references(record))
    }
  }
  for await (const execution of history.executions()) {
    const row = execution.row,
      key = input.keyOf(row.execution.referenceId)
    await output.append('historical-executions', 'original-source', key, row)
    if (row.scopeMatch === 'excluded' || row.referenceRole === 'owner') continue
    await output.append('historical-executions', null, key, row)
    if (execution.task) await output.append('historical-executions', execution.task.id, key, row)
    if (input.task)
      await output.append(
        'historical-executions',
        JSON.stringify(['task-tree', input.task.id]),
        key,
        row,
      )
    const next = emptyCompleteObservationFold()
    const relevant = !row.coveredByAcceptedRecords && row.execution.computeKind !== 'non-agent'
    if (relevant) {
      references++
      next.historicalReferences = '1'
      next.observedHistoricalReferences = execution.fold.observedHistoricalReferences ?? '0'
    }
    for (const gap of execution.fold.gaps) completeObservationGap(next, gap)
    if (relevant) await dimensions.addHistoricalReference(row, next)
    if (!relevant && next.gaps.length === 0) continue
    const assigned = execution.task !== null && (await addTask(execution.task.id, next))
    if (!assigned) {
      mergeCompleteObservationFold(standalone, next)
      if (execution.cohortAt !== null && row.scopeMatch === 'matched')
        await addTrend(execution.cohortAt, next)
    }
    const nodeId = row.execution.nodeRunId
    if (nodeId === null || !assigned) continue
    const original =
      (await input.rows.get<CompleteObservationAttempt & { taskId: string; taskName: string }>(
        space('all-attempts'),
        nodeId,
      )) ??
      (await input.rows.get<CompleteObservationAttempt & { taskId: string; taskName: string }>(
        space('task-original-attempts'),
        nodeId,
      ))
    if (!original) throw new Error('Original historical NodeRun attempt missing')
    const existing = await input.rows.get(space('all-attempts'), nodeId)
    const fold = existing ? completeMetricsFold(original.metrics) : emptyCompleteObservationFold()
    mergeCompleteObservationFold(fold, execution.fold)
    await input.rows.put(space('all-attempts'), {
      key: nodeId,
      document: { ...original, metrics: completeObservationMetrics(fold) },
    })
    if (!existing) {
      const task = await tasks.get(original.taskId)
      if (!task) throw new Error('Original historical Task summary missing')
      await tasks.put(original.taskId, {
        ...task,
        attemptCount: String(BigInt(task.attemptCount) + 1n),
      })
    }
  }
  await tasks.flush()
  for await (const receipt of completeWorkingTraversal(
    input.rows,
    stage.receiptsNamespace,
    input.signal,
  ))
    await input.rows.put(space('receipts'), {
      key: 'historical/' + receipt.key,
      document: receipt.document,
    })
  return { standalone, nativeRecords, references }
}
