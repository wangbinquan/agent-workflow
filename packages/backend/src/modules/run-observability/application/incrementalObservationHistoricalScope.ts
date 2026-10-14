import type { CompleteObservationTask, ObservationOverviewQuery } from '@agent-workflow/shared'
import type {
  QualifiedObservationContribution,
  HistoricalRecordScopeGroup,
} from '../ports/incrementalObservationQualified'
import { historicalObservationMembership } from './historicalObservationSource'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import {
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import { parseObservationSelection } from '../domain/analysisDimensions'
import { historicalObservationDimensionMatch } from '../domain/historicalObservationSelection'
import { originalHistoricalDiagnostic } from '../domain/originalHistoricalDiagnostic'

interface HistoricalScopeGroupMatch {
  readonly observed: boolean
  readonly numeric: CompleteObservationFold
  readonly match: 'matched' | 'excluded' | 'unresolved'
  readonly members: readonly ReturnType<typeof historicalObservationMembership>[]
  readonly cohortAt: number | null
}

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
    readonly scopeGroups?: ReadonlyMap<string, HistoricalRecordScopeGroup>
    readonly scopeMatches?: Map<string, HistoricalScopeGroupMatch>
  },
): QualifiedObservationContribution | null {
  const diagnostic = originalHistoricalDiagnostic(row.detail.section, row.detail.parent)
  if (diagnostic && row.detail.document === null) return row
  const reference =
    row.detail.section === 'historical-record-references'
      ? (row.detail.document as {
          readonly execution: NonNullable<
            QualifiedObservationContribution['detail']['scopes']
          >[number]
        } | null)
      : null
  const physicalGroup = row.detail.historicalRecordScopes?.[0]
    ? input.scopeGroups?.get(row.detail.historicalRecordScopes[0])
    : undefined
  const originalScopes =
    row.detail.scopes ?? (reference?.execution ? [reference.execution] : physicalGroup?.scopes)
  if (!originalScopes?.length)
    // Ordinary Task rows are not standalone historical facts. An admin read
    // must still retain the requested workflow/status/text/repository cohort.
    return row.detail.taskId !== null && !input.ids.has(row.detail.taskId) ? null : row
  const task = input.taskId
    ? (input.originals.get(input.taskId)?.detail.document as CompleteObservationTask | undefined)
        ?.task
    : undefined
  const selection = parseObservationSelection(input.query.selection)
  const membership = (
    execution: NonNullable<QualifiedObservationContribution['detail']['scopes']>[number],
    model: HistoricalRecordScopeGroup['model'] = null,
  ) => {
    const parent = execution.parentTaskId
      ? ((
          input.originals.get(execution.parentTaskId)?.detail.document as
            | CompleteObservationTask
            | undefined
        )?.task ?? null)
      : null
    const original = historicalObservationMembership(
      { query: input.query, ...(task ? { task } : {}) },
      execution,
      parent,
      parent !== null && input.ids.has(parent.id),
    )
    const dimensions = historicalObservationDimensionMatch(selection, execution, model)
    return {
      ...original,
      scopeMatch:
        original.scopeMatch === 'excluded' || dimensions === 'excluded'
          ? ('excluded' as const)
          : original.scopeMatch === 'unresolved' || dimensions === 'unresolved'
            ? ('unresolved' as const)
            : ('matched' as const),
    }
  }
  const documentModel = row.detail.document as {
    model?: HistoricalRecordScopeGroup['model']
  } | null
  // Individual candidate diagnostics use their own original predicate result,
  // while the physical record/execution summary still uses the whole group.
  if (reference?.execution) {
    const own = membership(reference.execution, physicalGroup?.model ?? documentModel?.model)
    return {
      ...row,
      detail: {
        ...row.detail,
        taskId:
          row.detail.taskId !== null && input.ids.has(row.detail.taskId) ? row.detail.taskId : null,
        cohortAt: own.cohortAt,
        document: {
          ...reference,
          scopeMatch: own.scopeMatch,
          timeBasis: own.timeBasis,
          cohortAt: own.cohortAt,
        },
      },
    }
  }
  const groups = row.detail.historicalRecordScopes?.map((key) => {
    const cached = input.scopeMatches?.get(key)
    if (cached) return cached
    const group = input.scopeGroups?.get(key)
    if (!group) throw new Error('Original historical candidate-set proof is missing')
    const members = group.scopes.map((execution) => membership(execution, group.model))
    const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: input.query.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
      clocks = new Set(
        members.map((scope) => (scope.cohortAt === null ? null : date.format(scope.cohortAt))),
      )
    const result: HistoricalScopeGroupMatch = {
      observed: group.observed,
      numeric: group.numeric,
      members,
      cohortAt: clocks.size === 1 ? members[0]!.cohortAt : null,
      match: members.every((scope) => scope.scopeMatch === 'matched')
        ? 'matched'
        : members.every((scope) => scope.scopeMatch === 'excluded')
          ? 'excluded'
          : 'unresolved',
    }
    input.scopeMatches?.set(key, result)
    return result
  })
  const scopes =
    row.detail.scopes || !physicalGroup
      ? originalScopes.map((execution) => membership(execution, documentModel?.model))
      : groups![0]!.members
  const excluded = groups?.length
    ? groups.every((group) => group.match === 'excluded')
    : scopes.every((scope) => scope.scopeMatch === 'excluded')
  if (excluded && !diagnostic) return null
  const matched = groups?.length
    ? groups.some((group) => group.match === 'matched')
    : scopes.every((scope) => scope.scopeMatch === 'matched')
  let cohortAt: number | null
  if (!row.detail.scopes && physicalGroup) cohortAt = groups![0]!.cohortAt
  else {
    const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: input.query.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
      clocks = new Set(
        scopes.map((scope) => (scope.cohortAt === null ? null : date.format(scope.cohortAt))),
      )
    cohortAt = clocks.size === 1 ? scopes[0]!.cohortAt : null
  }
  const referenceFold = (
    value: CompleteObservationFold,
    executionDocument = false,
  ): CompleteObservationFold => {
    if (excluded) return emptyCompleteObservationFold()
    const selectedNumeric = emptyCompleteObservationFold()
    if (executionDocument)
      for (const group of groups!)
        if (group.match === 'matched') mergeCompleteObservationFold(selectedNumeric, group.numeric)
    const next: CompleteObservationFold = executionDocument
      ? { ...selectedNumeric, gaps: [...value.gaps] }
      : matched
        ? { ...value, gaps: [...value.gaps] }
        : {
            ...emptyCompleteObservationFold(),
            ...(value.historicalReferences === undefined
              ? {}
              : { historicalReferences: value.historicalReferences }),
            gaps: [...value.gaps],
          }
    if (value.historicalReferences !== undefined) {
      next.historicalReferences = value.historicalReferences
      next.observedHistoricalReferences = groups!.some(
        (group) => group.match === 'matched' && group.observed,
      )
        ? value.historicalReferences
        : '0'
      if (!matched && BigInt(value.historicalReferences) > 0n)
        completeObservationGap(next, 'historical-attribution-unresolved')
      if (executionDocument && next.records === '0' && BigInt(value.historicalReferences) > 0n)
        completeObservationGap(next, 'historical-attribution-unresolved')
    }
    if (groups!.some((group) => group.match === 'unresolved'))
      completeObservationGap(next, 'historical-scope-unresolved')
    return next
  }
  let fold = row.fold
  if (excluded) fold = emptyCompleteObservationFold()
  else if (groups?.length) fold = referenceFold(fold)
  else if (!matched && (row.detail.nativeRecord || row.detail.key.startsWith('record/'))) {
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
    groups?.length &&
    row.detail.section === 'historical-executions' &&
    document &&
    typeof document === 'object' &&
    'metrics' in document
  ) {
    const original = completeMetricsFold(
      document.metrics as Parameters<typeof completeMetricsFold>[0],
    )
    // Metrics canonicalize gaps as a set; execution issues retain the original
    // source order, including the order of native diagnostics.
    if ('issues' in document && Array.isArray(document.issues))
      original.gaps = document.issues.filter((issue): issue is string => typeof issue === 'string')
    const next = referenceFold(original, true)
    // The original allocator adds an unresolved execution scope immediately
    // after the invocation gap. A matched execution's unresolved record issue
    // instead stays after its original native issues.
    const invocationGap = next.gaps.indexOf('historical-invocation-unobserved'),
      scopeGap = next.gaps.indexOf('historical-scope-unresolved')
    if (!matched && !excluded && invocationGap >= 0 && scopeGap >= 0) {
      next.gaps.splice(scopeGap, 1)
      next.gaps.splice(
        next.gaps.indexOf('historical-invocation-unobserved') + 1,
        0,
        'historical-scope-unresolved',
      )
    }
    document = { ...document, metrics: completeObservationMetrics(next), issues: next.gaps }
  }
  if (excluded && document && typeof document === 'object' && 'metrics' in document)
    document = {
      ...document,
      metrics: completeObservationMetrics(emptyCompleteObservationFold()),
      ...(row.detail.section === 'historical-executions' ? { issues: [] } : {}),
    }
  if (
    !matched &&
    !excluded &&
    row.detail.nativeRecord &&
    document &&
    typeof document === 'object' &&
    'originalUsage' in document
  ) {
    const metrics = emptyCompleteObservationFold()
    completeObservationGap(metrics, 'historical-scope-unresolved')
    if ('issues' in document && Array.isArray(document.issues))
      for (const issue of document.issues)
        if (typeof issue === 'string') completeObservationGap(metrics, issue)
    document = { ...document, metrics: completeObservationMetrics(metrics) }
  }
  if (
    !matched &&
    row.detail.nativeRecord &&
    row.detail.section === 'time-partitions' &&
    document &&
    typeof document === 'object'
  )
    document = { ...document, metrics: completeObservationMetrics(fold) }
  if (document && typeof document === 'object' && 'scopeMatch' in document)
    document = {
      ...document,
      scopeMatch: excluded ? 'excluded' : matched ? 'matched' : 'unresolved',
      ...(row.detail.section === 'historical-executions'
        ? { cohortAt, timeBasis: scopes[0]!.timeBasis }
        : {}),
      ...(!matched && row.detail.nativeRecord && row.detail.section === 'historical-records'
        ? { includedInTotals: false }
        : {}),
    }
  return {
    ...row,
    fold,
    detail: {
      ...row.detail,
      document,
      cohortAt: row.detail.section === 'time-partitions' ? row.detail.cohortAt : cohortAt,
      taskId:
        row.detail.taskId !== null && input.ids.has(row.detail.taskId) ? row.detail.taskId : null,
    },
  }
}
