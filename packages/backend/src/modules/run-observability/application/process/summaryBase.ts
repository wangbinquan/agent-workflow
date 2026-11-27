// RFC-616 §8 — the part of a subject summary every subject kind shares.

import type {
  ProcessClarifySummary,
  ProcessCompareMode,
  ProcessDataNote,
  ProcessGateKind,
  ProcessHint,
  ProcessIdentity,
  ProcessSubjectSummary,
  ProcessTimeSplit,
} from '@agent-workflow/shared'
import { comparedMetrics, type MetricValues } from '../../domain/process/compare'
import { gateDurationsOf } from '../../domain/process/gateSummary'
import type { HintFacts } from '../../domain/process/hints'
import { unitEnded, type ProcessUnitFacts } from '../../domain/process/model'
import { statOf, sum } from '../../domain/process/stats'
import type { StageTotals } from '../../domain/process/stageSummary'
import {
  causeSlicesOf,
  commonMetrics,
  interventionsOf,
  stabilityOf,
  timeSplitOf,
  trendOf,
  unitCounts,
  type ProcessUnitNumbers,
} from '../../domain/process/unitSummary'

type SummaryBase = Omit<
  Extract<ProcessSubjectSummary, { kind: 'workflow' }>,
  'kind' | 'origins' | 'stages' | 'definition' | 'review' | 'clarify' | 'mindmap'
>

export interface SummaryFrame {
  readonly asOf: number
  readonly from: number
  readonly to: number
  readonly tzOffset: number
  readonly subjectId: string | null
  readonly subjectName: string | null
  readonly scope: 'all' | 'own'
  readonly partial: boolean
  readonly unitLimit: number
  readonly compare: { readonly mode: ProcessCompareMode; readonly split: number | null }
  readonly identities: readonly ProcessIdentity[]
}

export function dataNoteOf(
  numbers: readonly ProcessUnitNumbers[],
  partial: boolean,
  unitLimit: number,
): ProcessDataNote {
  const ended = numbers.filter((item) => unitEnded(item.facts.unit))
  return {
    units: numbers.length,
    partial,
    unitLimit,
    unitsWithoutUsage: ended.filter((item) => !item.facts.hasUsageRecord).length,
    unitsWithoutRuntime: ended.filter((item) => item.time.autoMs === null).length,
    runsWithoutCause: sum(numbers.map((item) => item.facts.runsWithoutCause)),
    usageLowerBound: numbers.some((item) => item.facts.usageTotals.incompleteCalls > 0),
    unpriced: numbers.some((item) => item.facts.usageTotals.unpricedCalls > 0),
  }
}

/** Revisions seen among the units, newest first. */
export function revisionsOf(
  numbers: readonly ProcessUnitNumbers[],
): { revision: number; units: number }[] {
  const counts = new Map<number, number>()
  for (const item of numbers) {
    const revision = item.facts.unit.subjectRevision
    if (revision !== null) counts.set(revision, (counts.get(revision) ?? 0) + 1)
  }
  return [...counts]
    .map(([revision, units]) => ({ revision, units }))
    .sort((a, b) => b.revision - a.revision)
}

export function baseSummary(
  frame: SummaryFrame,
  current: readonly ProcessUnitNumbers[],
  baseline: readonly ProcessUnitNumbers[] | null,
  extras: {
    /** Metrics only this subject kind has. */
    readonly metrics: MetricValues
    readonly baselineMetrics: MetricValues | null
    readonly hints: readonly ProcessHint[]
    /** Units the revision picker lists; for a revision split these are both groups together. */
    readonly revisionUnits: readonly ProcessUnitNumbers[]
  },
): SummaryBase {
  const metrics: MetricValues = { ...commonMetrics(current), ...extras.metrics }
  const baselineMetrics: MetricValues | null =
    baseline === null ? null : { ...commonMetrics(baseline), ...(extras.baselineMetrics ?? {}) }
  return {
    asOf: frame.asOf,
    from: frame.from,
    to: frame.to,
    subjectId: frame.subjectId,
    subjectName: frame.subjectName,
    scope: frame.scope,
    note: dataNoteOf(current, frame.partial, frame.unitLimit),
    identities: frame.identities,
    compare: {
      mode: frame.compare.mode,
      split: frame.compare.split,
      baselineUnits: baseline?.length ?? 0,
    },
    counts: unitCounts(current),
    metrics: comparedMetrics(metrics, baselineMetrics),
    time: timeSplitOf(current),
    causes: causeSlicesOf(current),
    interventions: interventionsOf(current),
    trend: trendOf(current, frame.from, frame.to, frame.tzOffset),
    stability: stabilityOf(current),
    hints: extras.hints,
    revisions: revisionsOf(extras.revisionUnits),
  }
}

/** Units whose first pass was judged: the denominator of the first-pass rate. */
export function firstPassUnitsOf(numbers: readonly ProcessUnitNumbers[]): number {
  return numbers.filter((item) => item.facts.unit.status === 'succeeded' && item.firstPass !== null)
    .length
}

/** The gate kind a succeeded unit waits on longest, as a share of its lead time. */
export function topWaitOf(time: ProcessTimeSplit): {
  readonly kind: ProcessGateKind | null
  readonly share: number | null
} {
  const top = [...time.waits].sort((a, b) => b.ms - a.ms)[0]
  if (!top || !time.leadMs) return { kind: null, share: null }
  return { kind: top.kind, share: top.ms / time.leadMs }
}

export function gateHintFacts(
  units: readonly ProcessUnitFacts[],
  kinds: readonly ProcessGateKind[],
): HintFacts['gates'] {
  return kinds.flatMap((kind) => {
    const stat = statOf(gateDurationsOf(units, kind))
    return stat.n === 0 ? [] : [{ kind, rounds: stat.n, p50: stat.p50, p90: stat.p90 }]
  })
}

export function clarifyHintFacts(clarify: ProcessClarifySummary | null): HintFacts['clarify'] {
  if (clarify === null) return null
  const { recommended, other, custom, skipped } = clarify.answers
  const answered = recommended + other + custom + skipped
  return {
    answered,
    recommendable: clarify.answersWithRecommendation,
    recommendedRate: clarify.recommendedRate,
    customRate: answered > 0 ? custom / answered : null,
  }
}

/** The stage facts the hint rules read, from raw stage totals. */
export function stageHintFacts(
  totals: ReadonlyMap<string, StageTotals>,
  extra: (key: string) => Partial<HintFacts['stages'][number]> = () => ({}),
): HintFacts['stages'] {
  return [...totals].map(([key, entry]) => {
    const top = [...entry.failureCodes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    const failures = sum([...entry.failureCodes.values()])
    return {
      key,
      units: entry.units,
      runs: entry.runs,
      autoRetryRate: entry.runs > 0 ? entry.autoRetryRuns / entry.runs : null,
      topFailureCode: top?.[0] ?? null,
      topFailureShare: top && failures > 0 ? top[1] / failures : null,
      rejectRate: entry.reviewDecided > 0 ? entry.reviewSentBack / entry.reviewDecided : null,
      reviewRounds: entry.reviewDecided,
      loopRuns: 0,
      loopCapRate: null,
      loopRoundsMean: null,
      roundsPerUnit: null,
      failureRate: entry.endedRuns > 0 ? entry.failedRuns / entry.endedRuns : null,
      ...extra(key),
    }
  })
}

/** Review-rework tokens of the token sample: share of all tokens, and mean per unit. */
export function reworkTokensOf(numbers: readonly ProcessUnitNumbers[]): {
  readonly share: number | null
  readonly tokens: number
  readonly costNano: number
} {
  const sample = numbers.filter((item) => item.tokenSample)
  const rework = sum(sample.map((item) => item.causeTokens.get('review-rework')?.tokens ?? 0))
  const cost = sum(sample.map((item) => item.causeTokens.get('review-rework')?.costNano ?? 0))
  const all = sum(sample.map((item) => item.facts.usageTotals.tokens))
  return {
    share: all > 0 ? rework / all : null,
    tokens: sample.length ? Math.round(rework / sample.length) : 0,
    costNano: sample.length ? Math.round(cost / sample.length) : 0,
  }
}
