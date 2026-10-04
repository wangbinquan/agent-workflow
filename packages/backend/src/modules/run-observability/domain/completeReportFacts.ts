import { isDeepStrictEqual } from 'node:util'
import {
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  type CompleteObservationMetrics,
  type CompleteObservationFactSummary,
  type CompleteObservationReportSummary,
  type CompleteObservationTrend,
  type ObservationSpanDetail,
} from '@agent-workflow/shared'
import type { CompleteObservationReportRow } from '../ports/completeObservationReport'
import { completeMetricsFold } from './completeMetricsFold'
import { completeObservationMetrics } from './completeObservationMetrics'

export function qualifiedCostEvidence(metrics: CompleteObservationMetrics): boolean {
  try {
    const canonicalCount = (count: unknown) =>
      typeof count === 'string' && /^(0|[1-9]\d*)$/.test(count)
    if (metrics.state === 'not-applicable')
      return !('recordedCost' in metrics) && !('costCoverage' in metrics)
    if ('costCoverage' in metrics) {
      if (metrics.state !== 'not-ready') return false
      const coverage = metrics.costCoverage
      if (
        !coverage ||
        ![coverage.records, coverage.pricedRecords].every(canonicalCount) ||
        BigInt(coverage.pricedRecords) > BigInt(coverage.records) ||
        !['visible', 'hidden'].includes(coverage.visibility) ||
        !isDeepStrictEqual(coverage, {
          records: coverage.records,
          pricedRecords: coverage.pricedRecords,
          visibility: coverage.visibility,
        })
      )
        return false
    }
    if ('recordedCost' in metrics) {
      const recorded = metrics.recordedCost
      if (
        !recorded ||
        recorded.currency !== 'CNY' ||
        typeof recorded.amount !== 'string' ||
        !/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(recorded.amount) ||
        ![recorded.records, recorded.pricedRecords].every(canonicalCount) ||
        BigInt(recorded.pricedRecords) <= 0n ||
        BigInt(recorded.pricedRecords) > BigInt(recorded.records) ||
        !isDeepStrictEqual(recorded, {
          currency: 'CNY',
          amount: recorded.amount,
          records: recorded.records,
          pricedRecords: recorded.pricedRecords,
        }) ||
        (metrics.state === 'not-ready'
          ? metrics.costCoverage?.visibility !== 'visible' ||
            metrics.costCoverage.records !== recorded.records ||
            metrics.costCoverage.pricedRecords !== recorded.pricedRecords
          : metrics.cost.state !== 'unpriced' || metrics.records !== recorded.records)
      )
        return false
    }
    return isDeepStrictEqual(metrics, completeObservationMetrics(completeMetricsFold(metrics)))
  } catch {
    return false
  }
}
function qualifiedRecordedUsage(value: unknown, metrics: CompleteObservationMetrics): boolean {
  try {
    const recorded = value as NonNullable<CompleteObservationTrend['recordedUsage']>
    const canonicalCount = (count: unknown) =>
      typeof count === 'string' && /^(0|[1-9]\d*)$/.test(count)
    return (
      metrics.state === 'not-ready' &&
      !metrics.gaps.includes('usage-incomplete') &&
      [recorded.invocations, recorded.observedInvocations, recorded.records].every(
        canonicalCount,
      ) &&
      ['input', 'cacheRead', 'cacheWrite', 'output', 'total'].every((bucket) =>
        canonicalCount(recorded.tokens[bucket as keyof typeof recorded.tokens]),
      ) &&
      BigInt(recorded.records) > 0n &&
      BigInt(recorded.observedInvocations) > 0n &&
      BigInt(recorded.observedInvocations) <= BigInt(recorded.invocations) &&
      isDeepStrictEqual(recorded, {
        invocations: recorded.invocations,
        observedInvocations: recorded.observedInvocations,
        records: recorded.records,
        tokens: {
          input: recorded.tokens.input,
          cacheRead: recorded.tokens.cacheRead,
          cacheWrite: recorded.tokens.cacheWrite,
          output: recorded.tokens.output,
          total: String(
            BigInt(recorded.tokens.input) +
              BigInt(recorded.tokens.cacheRead) +
              BigInt(recorded.tokens.cacheWrite) +
              BigInt(recorded.tokens.output),
          ),
        },
      })
    )
  } catch {
    return false
  }
}
/** Whole-range aggregates remain unknown; each original scope retains its own qualification. */
export function completeReportFactSummary(
  summary: CompleteObservationReportSummary | CompleteObservationFactSummary,
): CompleteObservationFactSummary {
  if (summary.metrics.state !== 'not-ready')
    throw new Error('Original fact report requires incomplete numeric evidence')
  const { tasks, attempts, invocations } = summary.inventory
  if (
    ('recordedCost' in summary.metrics || 'costCoverage' in summary.metrics) &&
    (!qualifiedCostEvidence(summary.metrics) ||
      ('numericRecords' in summary.inventory &&
        summary.metrics.costCoverage?.records !== summary.inventory.numericRecords))
  )
    throw new Error('Original recorded summary cost is not qualified')
  if (
    'recordedUsage' in summary &&
    (!qualifiedRecordedUsage(summary.recordedUsage, summary.metrics) ||
      summary.recordedUsage?.invocations !== invocations ||
      (summary.metrics.costCoverage &&
        summary.recordedUsage?.records !== summary.metrics.costCoverage.records) ||
      ('numericRecords' in summary.inventory &&
        summary.recordedUsage?.records !== summary.inventory.numericRecords))
  )
    throw new Error('Original recorded summary usage is not qualified')
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
  if ('recordedUsage' in document && row.section !== 'trends')
    throw new Error('Original recorded trend usage is not qualified')
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
        qualifiedCostEvidence(metrics) &&
        isDeepStrictEqual(metrics, completeObservationMetrics(completeMetricsFold(metrics)))
    } catch {
      qualified = false
    }
    if (!qualified) throw new Error('Original scope metrics are not qualified: ' + gaps.join(', '))
  }
  if ('recordedUsage' in document) {
    if (
      row.section !== 'trends' ||
      !qualifiedRecordedUsage(
        document.recordedUsage,
        document.metrics as CompleteObservationMetrics,
      )
    )
      throw new Error('Original recorded trend usage is not qualified')
  }
  return row
}
