import { originalObservationTimePartition } from '../domain/observationWindowCell'
import type { QualifiedObservationDimensionContribution } from '../ports/incrementalObservationQualified'
import type {
  CompleteHistoricalObservationExecution,
  CompleteObservationInvocation,
  CompleteObservationReportSummary,
  CompleteObservationTask,
  CompleteObservationTimePartition,
  CompleteObservationTrend,
  ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import {
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type { QualifiedObservationContribution } from '../ports/incrementalObservationQualified'

type Partition = CompleteObservationTimePartition['partition']
export type ProjectionOccurrence = CompleteObservationTimePartition & {
  /** Private aggregate cell; it is never returned as an original record. */
  readonly projectionCell?: { readonly from: number; readonly to: number }
  readonly referenceIds: readonly string[]
  readonly candidateCount?: string
  readonly model: { readonly provider: string | null; readonly id: string } | null
  readonly dimensions?: readonly QualifiedObservationDimensionContribution[]
  readonly unknownDimensions?: readonly QualifiedObservationDimensionContribution[]
}
const clearMemberships = (fold: CompleteObservationFold): CompleteObservationFold => ({
  ...fold,
  invocations: '0',
  observedInvocations: '0',
  historicalReferences: '0',
  observedHistoricalReferences: '0',
})
/** The numerical selection/prices are already materialized. Range boundaries
 * only choose qualified atoms and DISTINCT memberships; daily call counts are
 * never added together across overlapping windows. */
export function incrementalObservationWindow(input: {
  readonly query: ObservationOverviewQuery
  readonly tasks: readonly CompleteObservationTask[]
  readonly occurrences: readonly QualifiedObservationContribution[]
  readonly invocations: readonly CompleteObservationInvocation[]
  readonly historical: readonly CompleteHistoricalObservationExecution[]
  readonly mode?: 'cohort' | 'usage'
}) {
  const partitions: Record<Partition, CompleteObservationFold> = {
    'in-window': emptyCompleteObservationFold(),
    'outside-window': emptyCompleteObservationFold(),
    'unassigned-time': emptyCompleteObservationFold(),
  }
  const partitionCalls: Record<Partition, Set<string>> = {
      'in-window': new Set(),
      'outside-window': new Set(),
      'unassigned-time': new Set(),
    },
    partitionRefs: Record<Partition, Set<string>> = {
      'in-window': new Set(),
      'outside-window': new Set(),
      'unassigned-time': new Set(),
    }
  const calls = new Map<
      string,
      { fold: CompleteObservationFold; inWindow: bigint; unknown: bigint }
    >(),
    taskFolds = new Map<string, CompleteObservationFold>(),
    historicalFolds = new Map<string, CompleteObservationFold>()
  const timeRows: CompleteObservationTimePartition[] = [],
    selectedHistory = new Set<string>(),
    selectedTaskIds = new Set<string>()
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.query.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const trends = new Map<
    string,
    {
      from: number
      to: number
      tasks: Set<string>
      calls: Set<string>
      references: Set<string>
      fold: CompleteObservationFold
    }
  >()
  const standalone = emptyCompleteObservationFold()
  const candidateTaskIds = new Set(input.tasks.map((row) => row.task.id))
  function task(id: string) {
    let fold = taskFolds.get(id)
    if (!fold) {
      fold = emptyCompleteObservationFold()
      taskFolds.set(id, fold)
    }
    return fold
  }
  for (const contribution of input.occurrences) {
    // The original usage window admits only historical records included in
    // totals. An unresolved/covered record is not a received numeric record.
    if (contribution.detail.nativeRecord && contribution.fold.records === '0') continue
    const original = contribution.detail.document as ProjectionOccurrence,
      at = original.occurrence.occurredAt
    const partition: Partition =
      input.mode === 'cohort'
        ? 'in-window'
        : at === null
          ? 'unassigned-time'
          : at >= input.query.from && at < input.query.to
            ? 'in-window'
            : 'outside-window'
    const row = { ...original, partition },
      next = clearMemberships(contribution.fold)
    if (!row.projectionCell) timeRows.push(originalObservationTimePartition(row))
    mergeCompleteObservationFold(partitions[partition], next)
    if (row.invocation) {
      const id = row.invocation.invocationId,
        call = calls.get(id) ?? { fold: emptyCompleteObservationFold(), inWindow: 0n, unknown: 0n }
      partitionCalls[partition].add(id)
      if (partition === 'in-window') {
        mergeCompleteObservationFold(call.fold, next)
        call.inWindow++
      } else if (partition === 'unassigned-time') {
        call.unknown++
        if (
          next.records !== '0' &&
          (Object.values(next.tokens).some((value) => value !== '0') ||
            Object.values(next.bucketRecords ?? {}).some((value) => value !== next.records) ||
            next.picos !== '0' ||
            !next.priced ||
            !next.visible)
        )
          completeObservationGap(call.fold, 'usage-time-unassigned')
      }
      calls.set(id, call)
    }
    for (const id of row.referenceIds) {
      partitionRefs[partition].add(id)
      if (partition !== 'outside-window') selectedHistory.add(id)
      if (
        partition === 'in-window' &&
        (row.candidateCount ?? String(row.referenceIds.length)) === '1'
      ) {
        const fold = historicalFolds.get(id) ?? emptyCompleteObservationFold()
        mergeCompleteObservationFold(fold, next)
        historicalFolds.set(id, fold)
      } else if (partition === 'unassigned-time') {
        const fold = historicalFolds.get(id) ?? emptyCompleteObservationFold()
        completeObservationGap(fold, 'usage-time-unassigned')
        historicalFolds.set(id, fold)
      }
    }
    if (partition !== 'in-window') continue
    if (row.invocation === null) {
      if (row.task) mergeCompleteObservationFold(task(row.task.id), next)
      else mergeCompleteObservationFold(standalone, next)
    }
    if (row.task) selectedTaskIds.add(row.task.id)
    const trendAt = input.mode === 'cohort' ? (row.task?.startedAt ?? at) : at
    if (trendAt === null) continue
    const key = date.format(trendAt),
      day = trends.get(key) ?? {
        from: trendAt,
        to: trendAt + 1,
        tasks: new Set<string>(),
        calls: new Set<string>(),
        references: new Set<string>(),
        fold: emptyCompleteObservationFold(),
      }
    day.from = Math.min(day.from, trendAt)
    day.to = Math.max(day.to, trendAt + 1)
    mergeCompleteObservationFold(day.fold, next)
    if (row.task) day.tasks.add(row.task.id)
    if (row.invocation) day.calls.add(row.invocation.invocationId)
    for (const id of row.referenceIds) day.references.add(id)
    trends.set(key, day)
  }
  const selectedInvocations: CompleteObservationInvocation[] = []
  for (const invocation of input.invocations) {
    const original = completeMetricsFold(invocation.metrics),
      call = calls.get(invocation.invocationId) ?? {
        fold: emptyCompleteObservationFold(),
        inWindow: 0n,
        unknown: 0n,
      }
    for (const gap of original.gaps) completeObservationGap(call.fold, gap)
    if (call.inWindow === 0n && call.unknown === 0n && call.fold.gaps.length === 0) continue
    call.fold.invocations = '1'
    call.fold.observedInvocations = original.observedInvocations
    mergeCompleteObservationFold(task(invocation.taskId), call.fold)
    selectedTaskIds.add(invocation.taskId)
    selectedInvocations.push({ ...invocation, metrics: completeObservationMetrics(call.fold) })
  }
  const historical: CompleteHistoricalObservationExecution[] = []
  for (const row of input.historical) {
    const e = row.execution,
      missing =
        row.metrics.state === 'not-ready' &&
        row.metrics.gaps.some(
          (gap) => gap !== 'historical-invocation-unobserved' && gap !== 'usage-incomplete',
        )
    const relevant = selectedHistory.has(e.referenceId)
    if (!relevant && !missing) continue
    const next = emptyCompleteObservationFold()
    if (
      row.referenceRole !== 'owner' &&
      !row.coveredByAcceptedRecords &&
      e.computeKind !== 'non-agent'
    ) {
      next.historicalReferences = '1'
      next.observedHistoricalReferences = relevant ? '1' : '0'
    }
    if (row.metrics.state === 'not-ready')
      for (const gap of row.metrics.gaps) completeObservationGap(next, gap)
    if (e.parentTaskId !== null && candidateTaskIds.has(e.parentTaskId)) {
      mergeCompleteObservationFold(task(e.parentTaskId), next)
      selectedTaskIds.add(e.parentTaskId)
    } else mergeCompleteObservationFold(standalone, next)
    const fold = historicalFolds.get(e.referenceId) ?? emptyCompleteObservationFold()
    mergeCompleteObservationFold(fold, next)
    historical.push({ ...row, metrics: completeObservationMetrics(fold) })
  }
  const tasks: CompleteObservationTask[] = []
  for (const original of input.tasks) {
    const fold = task(original.task.id)
    // Original source-population gaps remain visible even when no accepted
    // numeric record has a usable clock in this selected window.
    if (
      original.metrics.state === 'not-ready' &&
      (!input.query.selection || selectedTaskIds.has(original.task.id))
    )
      for (const gap of original.metrics.gaps) {
        completeObservationGap(fold, gap)
        selectedTaskIds.add(original.task.id)
      }
    if (selectedTaskIds.has(original.task.id))
      tasks.push({ ...original, metrics: completeObservationMetrics(fold) })
  }
  const fold = standalone
  for (const value of tasks) mergeCompleteObservationFold(fold, completeMetricsFold(value.metrics))
  for (const partition of Object.keys(partitions) as Partition[]) {
    partitions[partition].invocations = String(partitionCalls[partition].size)
    partitions[partition].observedInvocations = String(partitionCalls[partition].size)
    partitions[partition].historicalReferences = String(partitionRefs[partition].size)
    partitions[partition].observedHistoricalReferences = String(partitionRefs[partition].size)
  }
  const unassigned = partitions['unassigned-time']
  if (
    unassigned.records !== '0' &&
    (Object.values(unassigned.tokens).some((count) => count !== '0') ||
      Object.values(unassigned.bucketRecords ?? {}).some((count) => count !== unassigned.records) ||
      unassigned.picos !== '0' ||
      !unassigned.priced ||
      !unassigned.visible)
  )
    completeObservationGap(fold, 'usage-time-unassigned')
  const trendRows: CompleteObservationTrend[] = [...trends]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, day]) => {
      day.fold.invocations = String(day.calls.size)
      day.fold.observedInvocations = String(day.calls.size)
      day.fold.historicalReferences = String(day.references.size)
      day.fold.observedHistoricalReferences = String(day.references.size)
      return {
        key,
        from: day.from,
        to: day.to,
        tasks: String(day.tasks.size),
        metrics: completeObservationMetrics(day.fold),
      }
    })
  const usageWindow: NonNullable<CompleteObservationReportSummary['usageWindow']> = {
    candidateTasks: String(input.tasks.length),
    timingBasis: 'task-lifecycle',
    partitions: Object.fromEntries(
      (Object.keys(partitions) as Partition[]).map((key) => [
        key,
        { records: partitions[key].records, metrics: completeObservationMetrics(partitions[key]) },
      ]),
    ) as NonNullable<CompleteObservationReportSummary['usageWindow']>['partitions'],
  }
  return {
    query: input.query,
    mode: input.mode ?? 'usage',
    fold,
    tasks,
    invocations: selectedInvocations,
    historical,
    trends: trendRows,
    timeRows,
    usageWindow,
  }
}
