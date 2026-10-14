import type {
  CompleteHistoricalObservationExecution,
  CompleteObservationInvocation,
  ObservationDimensionSelection,
} from '@agent-workflow/shared'
import { invocationDimensionMatch, modelDimensionMatch } from '../domain/analysisDimensions'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import {
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type { QualifiedObservationContribution } from '../ports/incrementalObservationQualified'
import type { ProjectionOccurrence } from './incrementalObservationWindow'

const compare = (expected: unknown, actual: unknown): 'matched' | 'unresolved' | 'excluded' => {
  if (expected === undefined) return 'matched'
  if (actual === null || actual === undefined) return expected === null ? 'matched' : 'unresolved'
  if (expected === null) return 'excluded'
  if (typeof expected === 'object' && typeof actual === 'object') {
    const values = Object.entries(expected as Record<string, unknown>).map(([key, value]) =>
      compare(value, (actual as Record<string, unknown>)[key]),
    )
    return values.includes('excluded')
      ? 'excluded'
      : values.includes('unresolved')
        ? 'unresolved'
        : 'matched'
  }
  return expected === actual ? 'matched' : 'excluded'
}
/** Reuses qualified atom values and accepted identities. Combined selections
 * intersect the same atoms; Task-level totals from different dimensions are
 * never intersected or multiplied to guess a numerical contribution. */
export function incrementalObservationSelection(input: {
  readonly selection: ObservationDimensionSelection
  readonly calls: readonly CompleteObservationInvocation[]
  readonly atoms: readonly QualifiedObservationContribution[]
  readonly historical: readonly CompleteHistoricalObservationExecution[]
  /** Original physical candidate sets already applied all requested predicates. */
  readonly historicalScopeQualified?: boolean
}) {
  const selected = { ...input.selection, model: undefined },
    callById = new Map(input.calls.map((call) => [call.invocationId, call]))
  const matches = new Map(
    input.calls.map((call) => [call.invocationId, invocationDimensionMatch(selected, call)]),
  )
  const historyMatches = new Map(
    input.historical.map((row) => {
      const e = row.execution
      return [
        e.referenceId,
        input.historicalScopeQualified
          ? row.scopeMatch
          : compare(selected, {
              agent: { id: e.agentId, revision: e.agentRevision },
              purpose: e.purpose,
              source: { authority: 'local', sourceId: null },
              runtime: {
                authority: 'local',
                sourceId: null,
                registrationId: e.runtime?.registrationId ?? null,
                configurationRevision: e.runtime?.configurationRevision ?? null,
                protocol: e.runtime?.protocol ?? null,
              },
            }),
      ] as const
    }),
  )
  const atoms: QualifiedObservationContribution[] = [],
    folds = new Map<string, ReturnType<typeof emptyCompleteObservationFold>>()
  for (const atom of input.atoms) {
    const row = atom.detail.document as ProjectionOccurrence,
      invocation = row.invocation === null ? null : callById.get(row.invocation.invocationId)
    const identities = invocation
      ? [matches.get(invocation.invocationId)!]
      : row.referenceIds.map((id) => historyMatches.get(id) ?? 'unresolved')
    if (identities.length && identities.every((match) => match === 'excluded')) continue
    const authority = invocation?.authority
    const model = modelDimensionMatch(input.selection, {
      authority: authority?.kind ?? 'local',
      sourceId: authority?.kind === 'crewstation' ? authority.sourceId : null,
      provider: row.model?.provider ?? null,
      model: row.model?.id ?? null,
    })
    if (model === 'excluded') continue
    const unresolved =
      identities.includes('unresolved') ||
      (identities.includes('matched') && identities.includes('excluded')) ||
      model === 'unresolved'
    const fold = { ...atom.fold, gaps: [...atom.fold.gaps] }
    if (unresolved && !(input.historicalScopeQualified && atom.detail.nativeRecord))
      completeObservationGap(fold, 'dimension-unresolved')
    atoms.push({
      ...atom,
      fold,
      detail: {
        ...atom.detail,
        document: {
          ...row,
          referenceIds: row.referenceIds.filter((id) => historyMatches.get(id) !== 'excluded'),
        },
      },
    })
    if (invocation) {
      const next = folds.get(invocation.invocationId) ?? emptyCompleteObservationFold()
      mergeCompleteObservationFold(next, { ...fold, invocations: '0', observedInvocations: '0' })
      folds.set(invocation.invocationId, next)
    }
  }
  const calls: CompleteObservationInvocation[] = []
  for (const call of input.calls) {
    const match = matches.get(call.invocationId)!
    if (match === 'excluded') continue
    const original = completeMetricsFold(call.metrics),
      fold = input.selection.model
        ? (folds.get(call.invocationId) ?? emptyCompleteObservationFold())
        : original
    if (
      input.selection.model &&
      fold.records === '0' &&
      original.gaps.length === 0 &&
      match !== 'unresolved'
    )
      continue
    fold.invocations = '1'
    fold.observedInvocations = original.observedInvocations
    for (const gap of original.gaps) completeObservationGap(fold, gap)
    if (match === 'unresolved') completeObservationGap(fold, 'dimension-unresolved')
    calls.push({ ...call, metrics: completeObservationMetrics(fold) })
  }
  const referenced = new Set(
    atoms.flatMap((atom) => (atom.detail.document as ProjectionOccurrence).referenceIds),
  )
  const historical = input.historical
    .filter(
      (row) =>
        historyMatches.get(row.execution.referenceId) !== 'excluded' &&
        (!input.selection.model ||
          referenced.has(row.execution.referenceId) ||
          row.metrics.state === 'not-ready'),
    )
    .map((row) => {
      if (input.historicalScopeQualified) return row
      if (historyMatches.get(row.execution.referenceId) !== 'unresolved') return row
      const fold = completeMetricsFold(row.metrics)
      completeObservationGap(fold, 'dimension-unresolved')
      return { ...row, metrics: completeObservationMetrics(fold) }
    })
  return { atoms, calls, historical }
}
