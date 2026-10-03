import {
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  type CompleteObservationFactSummary,
  type CompleteObservationReportSummary,
  type ObservationSpanDetail,
} from '@agent-workflow/shared'
import type { CompleteObservationReportRow } from '../ports/completeObservationReport'

/** Redact every numeric layer, including an otherwise complete child of an incomplete cohort. */
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
  if ('metrics' in document)
    return { ...row, document: { ...document, metrics: { state: 'not-ready', gaps } } }
  return row
}
