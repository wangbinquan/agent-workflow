import type { CompleteObservationTask, ObservationOverviewQuery } from '@agent-workflow/shared'
import type { QualifiedObservationContribution } from '../ports/incrementalObservationQualified'
import { historicalObservationMembership } from './historicalObservationSource'
import {
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
} from '../domain/completeObservationMetrics'

/** Reuse the original membership rules on retained execution identities. A
 * historical execution whose parent is outside a Task cohort uses its actual
 * owner clock; mixed root membership remains unresolved without copying usage. */
export function incrementalObservationHistoricalScope(
  row: QualifiedObservationContribution,
  input: {
    readonly query: ObservationOverviewQuery
    readonly ids: ReadonlySet<string>
    readonly originals: ReadonlyMap<string, QualifiedObservationContribution>
    readonly taskId?: string
  },
): QualifiedObservationContribution | null {
  if (!row.detail.scopes?.length) return row
  const task = input.taskId
    ? (input.originals.get(input.taskId)?.detail.document as CompleteObservationTask | undefined)
        ?.task
    : undefined
  const scopes = row.detail.scopes.map((execution) => {
    const parent = execution.parentTaskId
      ? ((
          input.originals.get(execution.parentTaskId)?.detail.document as
            | CompleteObservationTask
            | undefined
        )?.task ?? null)
      : null
    return historicalObservationMembership(
      { query: input.query, ...(task ? { task } : {}) },
      execution,
      parent,
      parent !== null && input.ids.has(parent.id),
    )
  })
  if (scopes.every((scope) => scope.scopeMatch === 'excluded')) return null
  const matched = scopes.every((scope) => scope.scopeMatch === 'matched')
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.query.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const clocks = new Set(
    scopes.map((scope) => (scope.cohortAt === null ? null : date.format(scope.cohortAt))),
  )
  const cohortAt = clocks.size === 1 ? scopes[0]!.cohortAt : null
  let fold = row.fold
  if (!matched && (row.detail.nativeRecord || row.detail.key.startsWith('record/'))) {
    fold = emptyCompleteObservationFold()
    completeObservationGap(fold, 'historical-scope-unresolved')
    for (const gap of row.fold.gaps)
      if (gap !== 'historical-invocation-unobserved') completeObservationGap(fold, gap)
  } else if (!matched) {
    fold = { ...fold, gaps: [...fold.gaps] }
    completeObservationGap(fold, 'historical-scope-unresolved')
  }
  let document = row.detail.document
  if (
    row.detail.nativeRecord &&
    row.detail.section === 'time-partitions' &&
    document &&
    typeof document === 'object'
  )
    document = { ...document, metrics: completeObservationMetrics(fold) }
  if (document && typeof document === 'object' && 'scopeMatch' in document)
    document = {
      ...document,
      scopeMatch: matched ? 'matched' : 'unresolved',
      ...(row.detail.section === 'historical-executions'
        ? { cohortAt, timeBasis: scopes[0]!.timeBasis }
        : {}),
      ...(!matched && row.detail.nativeRecord && row.detail.section === 'historical-records'
        ? { includedInTotals: false, metrics: completeObservationMetrics(fold) }
        : {}),
    }
  return {
    ...row,
    fold,
    detail: {
      ...row.detail,
      document,
      cohortAt,
      taskId:
        row.detail.taskId !== null && input.ids.has(row.detail.taskId) ? row.detail.taskId : null,
    },
  }
}
