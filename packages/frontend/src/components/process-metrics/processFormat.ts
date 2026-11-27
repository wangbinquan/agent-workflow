// RFC-616 §11 — pure display rules of process metrics. `null` always means
// "no sample" and is shown as a dash, never as zero.
import {
  PROCESS_GATE_KINDS,
  PROCESS_METRIC_BETTER,
  formatObservationCny,
  type ProcessCompareMode,
  type ProcessCompared,
  type ProcessGateKind,
  type ProcessMetricId,
  type ProcessStat,
} from '@agent-workflow/shared'
import type { MetricDelta } from '@/components/MetricTile'
import type { SegmentedBarPart, VizFill } from '@/components/SegmentedBar'
import { durationLabel } from '@/components/observability/observationFormat'

export type Translate = (key: string, options?: Record<string, unknown>) => string

export const DASH = '—'

/** A plain name, or both languages for names that come from an employee type. */
export type ProcessLabel = string | { readonly 'zh-CN': string; readonly 'en-US': string }

export function labelText(label: ProcessLabel, language: string): string {
  if (typeof label === 'string') return label
  return language.startsWith('en') ? label['en-US'] : label['zh-CN']
}

export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? DASH : `${Math.round(value * 100)}%`
}

/** A small decimal such as "rounds per task": one fraction digit, no trailing zero. */
export function decimal(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return DASH
  const factor = 10 ** digits
  return String(Math.round(value * factor) / factor)
}

export function count(value: number | null | undefined, language: string): string {
  return value === null || value === undefined
    ? DASH
    : new Intl.NumberFormat(language).format(value)
}

/** Tokens in a compact form: 950, 12.4K, 2.9M. Exact values are in the unit rows. */
export function tokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH
  const trim = (text: string) => text.replace(/\.0+$|(\.\d*?)0+$/, '$1')
  if (value >= 1e6) return `${trim((value / 1e6).toFixed(value >= 1e7 ? 1 : 2))}M`
  if (value >= 1e3) return `${trim((value / 1e3).toFixed(value >= 1e5 ? 0 : 1))}K`
  return String(Math.round(value))
}

export function cost(nano: number | null | undefined): string {
  return nano === null || nano === undefined ? DASH : formatObservationCny(nano)
}

/**
 * A cost that may rest on calls without a price, by run observation's own rule (`usageCost`):
 * unpriced tokens never read as free. Nothing priced reads "unpriced"; a part priced reads as a
 * lower bound ("from ¥x").
 */
export function pricedCost(
  nano: number | null | undefined,
  unpriced: boolean,
  t: Translate,
): string {
  if (nano === null || nano === undefined) return DASH
  if (!unpriced) return formatObservationCny(nano)
  return nano === 0
    ? t('runObservability.unpriced')
    : t('runObservability.partialCost', { cost: formatObservationCny(nano) })
}

export function duration(ms: number | null | undefined, t: Translate): string {
  return ms === null || ms === undefined ? DASH : durationLabel(Math.round(ms), t)
}

/** "median / P90" of a duration distribution. */
export function durationSpread(stat: ProcessStat, t: Translate): string {
  if (stat.p50 === null) return DASH
  return stat.p90 === null || stat.n < 2
    ? duration(stat.p50, t)
    : `${duration(stat.p50, t)} / ${duration(stat.p90, t)}`
}

/**
 * The change line of a headline metric against its baseline. Nothing is shown
 * without a baseline; a number that did not move is not a change.
 */
export function metricDelta(
  id: ProcessMetricId,
  compared: ProcessCompared | undefined,
  mode: ProcessCompareMode,
  t: Translate,
): MetricDelta | null {
  if (mode === 'off' || compared === undefined) return null
  const { value, baseline } = compared
  if (value === null || baseline === null || value === baseline) return null
  const direction = value > baseline ? 'up' : 'down'
  // More or fewer units is a fact about demand, not about how well the work went.
  const tone = id === 'units' ? 'neutral' : PROCESS_METRIC_BETTER[id] === direction ? 'good' : 'bad'
  const basis = t(`processMetrics.delta.${mode === 'period' ? 'period' : 'version'}`)
  const amount =
    baseline === 0
      ? t('processMetrics.delta.fromZero')
      : `${t(`processMetrics.delta.${direction}`)} ${Math.round((Math.abs(value - baseline) / Math.abs(baseline)) * 100)}%`
  const judgement = tone === 'neutral' ? '' : t(`processMetrics.delta.${tone}`)
  return { direction, tone, text: `${amount} · ${basis}${judgement}` }
}

/**
 * The fill of each kind of waiting. Colour follows the kind of wait, never its
 * rank in one subject, so the same wait is the same colour on every page. Kinds
 * that share a fill rarely occur together; when they do, the later one joins the
 * muted part, whose label then says that it holds waiting too (`coloredWaits`).
 */
const WAIT_FILL: Readonly<Record<ProcessGateKind, VizFill>> = {
  review: 'cat-2',
  delivery: 'cat-2',
  clarify: 'cat-3',
  blocked: 'cat-3',
  completion: 'cat-4',
  'plan-confirm': 'cat-4',
  approval: 'cat-4',
}

export interface TimeSplitLike {
  readonly autoMs: number | null
  readonly waits: readonly { readonly kind: ProcessGateKind; readonly ms: number }[]
  readonly otherMs: number | null
}

/**
 * Which kinds of waiting get a colour of their own among these splits. Decided once for
 * everything that shares a legend — every row of a table — so one colour never means two
 * kinds of waiting in the same view.
 */
export function coloredWaits(splits: readonly TimeSplitLike[]): {
  readonly colored: ReadonlySet<ProcessGateKind>
  /** Some kind of waiting found no colour and sits in the muted part. */
  readonly folds: boolean
} {
  const present = new Set(splits.flatMap((split) => split.waits.map((wait) => wait.kind)))
  const taken = new Set<VizFill>(['cat-1'])
  const colored = new Set<ProcessGateKind>()
  let folds = false
  for (const kind of PROCESS_GATE_KINDS) {
    if (!present.has(kind)) continue
    const fill = WAIT_FILL[kind]
    if (taken.has(fill)) folds = true
    else {
      taken.add(fill)
      colored.add(kind)
    }
  }
  return { colored, folds }
}

/**
 * Where a unit's time went, as the parts of one bar: running, each kind of waiting, the rest.
 * `scheme` is the colour assignment shared with the other bars under the same legend; a bar
 * on its own decides for itself.
 */
export function timeParts(
  split: TimeSplitLike,
  t: Translate,
  scheme: ReturnType<typeof coloredWaits> = coloredWaits([split]),
): SegmentedBarPart[] {
  const parts: SegmentedBarPart[] = []
  let folded = 0
  if (split.autoMs !== null) {
    parts.push({
      key: 'auto',
      label: t('processMetrics.time.auto'),
      amount: split.autoMs,
      valueText: duration(split.autoMs, t),
      fill: 'cat-1',
    })
  }
  for (const wait of split.waits) {
    if (!scheme.colored.has(wait.kind)) {
      folded += wait.ms
      continue
    }
    parts.push({
      key: wait.kind,
      label: t(`processMetrics.wait.${wait.kind}`),
      amount: wait.ms,
      valueText: duration(wait.ms, t),
      fill: WAIT_FILL[wait.kind],
    })
  }
  const other = (split.otherMs ?? 0) + folded
  if (other > 0 || parts.length === 0) {
    parts.push({
      key: 'other',
      // Waiting that found no colour is in here: the part must not be called queueing alone.
      label: t(scheme.folds ? 'processMetrics.time.otherAndWaits' : 'processMetrics.time.other'),
      amount: other,
      valueText: duration(other, t),
      fill: 'other',
    })
  }
  return parts
}

/** The legend of several bars drawn with one scheme: every part any of them shows, once, in bar order. */
export function timeLegend(
  splits: readonly TimeSplitLike[],
  t: Translate,
  scheme: ReturnType<typeof coloredWaits> = coloredWaits(splits),
): SegmentedBarPart[] {
  const byKey = new Map<string, SegmentedBarPart>()
  for (const split of splits)
    for (const part of timeParts(split, t, scheme))
      if (!byKey.has(part.key)) byKey.set(part.key, part)
  const rank = (key: string) =>
    key === 'auto'
      ? -1
      : key === 'other'
        ? PROCESS_GATE_KINDS.length
        : PROCESS_GATE_KINDS.indexOf(key as ProcessGateKind)
  return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key))
}
