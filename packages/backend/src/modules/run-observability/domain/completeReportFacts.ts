import { isDeepStrictEqual } from 'node:util'
import {
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  type CompleteObservationMetrics,
  type CompleteObservationFactSummary,
  type CompleteObservationReportSummary,
  type ObservationSpanDetail,
} from '@agent-workflow/shared'
import type { CompleteObservationReportRow } from '../ports/completeObservationReport'
import { completeMetricsFold } from './completeMetricsFold'
import { completeObservationMetrics } from './completeObservationMetrics'

/** Whole-range aggregates remain unknown; each original scope retains its own qualification. */
export function completeReportFactSummary(
  summary: CompleteObservationReportSummary,
): CompleteObservationFactSummary {
  if (summary.metrics.state !== 'not-ready')
    throw new Error('Original fact report requires incomplete numeric evidence')
  const { tasks, attempts, invocations } = summary.inventory
  return {
    ...summary,
    inventory: { tasks, attempts, invocations },
    metrics: summary.metrics,
    rootTask: summary.rootTask ? { ...summary.rootTask, metrics: summary.metrics } : null,
  }
}
export function completeReportFactRow(
  row: CompleteObservationReportRow,
  gaps: readonly string[],
): CompleteObservationReportRow | null {
  if (!COMPLETE_OBSERVATION_FACT_SECTIONS.includes(row.section)) return null
  const document = row.document as Record<string, unknown>
  if (row.section === 'span-facts') {
    const span = row.document as ObservationSpanDetail
    return { ...row, document: { ...span, usage: null, cost: null } }
  }
  if (row.section !== 'quality' && row.section !== 'span-statuses' && !('metrics' in document))
    throw new Error('Original scope metrics are not qualified: missing metrics')
  if ('metrics' in document) {
    const metrics = document.metrics as CompleteObservationMetrics
    let qualified = false
    try {
      const canonicalCount = (value: unknown) =>
        typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      const countsValid =
        metrics.state !== 'ready' ||
        ([metrics.invocations, metrics.observedInvocations, metrics.records].every(
          canonicalCount,
        ) &&
          ['input', 'cacheRead', 'cacheWrite', 'output', 'total'].every((bucket) =>
            canonicalCount(metrics.tokens[bucket as keyof typeof metrics.tokens]),
          ) &&
          metrics.observedInvocations === metrics.invocations)
      const gapsValid =
        metrics.state !== 'not-ready' ||
        (Array.isArray(metrics.gaps) &&
          metrics.gaps.length > 0 &&
          metrics.gaps.every((gap) => typeof gap === 'string' && gap.length > 0))
      qualified =
        countsValid &&
        gapsValid &&
        isDeepStrictEqual(metrics, completeObservationMetrics(completeMetricsFold(metrics)))
    } catch {
      qualified = false
    }
    if (!qualified) throw new Error('Original scope metrics are not qualified: ' + gaps.join(', '))
  }
  return row
}
