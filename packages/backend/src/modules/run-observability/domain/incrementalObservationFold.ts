import type { ObservationTokenUsage } from '@agent-workflow/shared'
import { TOKEN_BUCKETS } from './tokenUsage'
import {
  emptyCompleteObservationFold,
  type CompleteObservationFold,
} from './completeObservationMetrics'

const COUNTERS = [
  'invocations',
  'observedInvocations',
  'knownZeroInvocations',
  'knownZeroCostInvocations',
  'historicalReferences',
  'observedHistoricalReferences',
  'records',
  'costRecords',
  'pricedRecords',
  'partiallyPricedRecords',
  'picos',
  'tasks',
  'attempts',
  'numericRecords',
  'nativeCaptures',
] as const
type Counter = (typeof COUNTERS)[number]

export interface IncrementalObservationContributionFold extends CompleteObservationFold {
  readonly inventory?: Readonly<{
    tasks: string
    attempts: string
    numericRecords: string
    nativeCaptures: string
  }>
}

/** Persist counts of incomplete contributors, rather than sticky booleans. A
 * repaired last contributor must be able to restore complete coverage. */
export interface IncrementalObservationFold {
  readonly tokens: Readonly<Record<keyof ObservationTokenUsage, string>>
  readonly bucketRecords: Readonly<Record<keyof ObservationTokenUsage, string>>
  readonly counters: Readonly<Record<Counter, string>>
  readonly unknownCoverage: string
  readonly hidden: string
  readonly unpriced: string
  readonly gaps: Readonly<Record<string, string>>
}

function integer(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error('Incremental observation requires canonical nonnegative integers')
  return BigInt(value)
}
function vector<K extends string>(keys: readonly K[]): Record<K, string> {
  return Object.fromEntries(keys.map((key) => [key, '0'])) as Record<K, string>
}
export function emptyIncrementalObservationFold(): IncrementalObservationFold {
  return {
    tokens: vector(TOKEN_BUCKETS),
    bucketRecords: vector(TOKEN_BUCKETS),
    counters: vector(COUNTERS),
    unknownCoverage: '0',
    hidden: '0',
    unpriced: '0',
    gaps: {},
  }
}

function contribution(fold: IncrementalObservationContributionFold): IncrementalObservationFold {
  const counters = {
    invocations: fold.invocations,
    observedInvocations: fold.observedInvocations,
    knownZeroInvocations: fold.knownZeroInvocations ?? '0',
    knownZeroCostInvocations: fold.knownZeroCostInvocations ?? '0',
    historicalReferences: fold.historicalReferences ?? '0',
    observedHistoricalReferences: fold.observedHistoricalReferences ?? '0',
    records: fold.records,
    costRecords: fold.costRecords ?? fold.records,
    pricedRecords: fold.pricedRecords ?? (fold.priced ? fold.records : '0'),
    partiallyPricedRecords: fold.partiallyPricedRecords ?? '0',
    picos: fold.picos,
    tasks: fold.inventory?.tasks ?? '0',
    attempts: fold.inventory?.attempts ?? '0',
    numericRecords: fold.inventory?.numericRecords ?? '0',
    nativeCaptures: fold.inventory?.nativeCaptures ?? '0',
  }
  const tokens = { ...fold.tokens },
    bucketRecords = { ...fold.bucketRecords } as Record<keyof ObservationTokenUsage, string>
  for (const bucket of TOKEN_BUCKETS) bucketRecords[bucket] ??= fold.records
  for (const value of [
    ...Object.values(counters),
    ...TOKEN_BUCKETS.map((bucket) => tokens[bucket]),
    ...TOKEN_BUCKETS.map((bucket) => bucketRecords[bucket]),
  ])
    integer(value)
  const gaps = [...new Set(fold.gaps)].sort()
  if (gaps.some((reason) => !reason)) throw new Error('Incremental observation gap is empty')
  return {
    tokens,
    bucketRecords,
    counters,
    unknownCoverage: fold.tokenCoverageKnown === false ? '1' : '0',
    hidden: fold.visible ? '0' : '1',
    unpriced: fold.priced ? '0' : '1',
    gaps: Object.fromEntries(gaps.map((reason) => [reason, '1'])),
  }
}

/** The caller supplies the previously committed contribution, never an upstream
 * cumulative meter. Revision convergence and native overlap allocation precede
 * this operation. Commit the returned fold and replacement together. */
export function replaceIncrementalObservationContribution(
  current: IncrementalObservationFold,
  previous: IncrementalObservationContributionFold | null,
  next: IncrementalObservationContributionFold | null,
): IncrementalObservationFold {
  const before = previous ? contribution(previous) : emptyIncrementalObservationFold(),
    after = next ? contribution(next) : emptyIncrementalObservationFold()
  if (JSON.stringify(before) === JSON.stringify(after)) return current
  function replace(value: string, oldValue: string, newValue: string) {
    const result = integer(value) - integer(oldValue) + integer(newValue)
    if (result < 0n) throw new Error('Incremental observation contribution underflow')
    return String(result)
  }
  const tokens = vector(TOKEN_BUCKETS),
    bucketRecords = vector(TOKEN_BUCKETS),
    counters = vector(COUNTERS)
  for (const bucket of TOKEN_BUCKETS) {
    tokens[bucket] = replace(current.tokens[bucket], before.tokens[bucket], after.tokens[bucket])
    bucketRecords[bucket] = replace(
      current.bucketRecords[bucket],
      before.bucketRecords[bucket],
      after.bucketRecords[bucket],
    )
  }
  for (const field of COUNTERS)
    counters[field] = replace(
      current.counters[field],
      before.counters[field],
      after.counters[field],
    )
  const gaps: Record<string, string> = {}
  for (const reason of new Set([
    ...Object.keys(current.gaps),
    ...Object.keys(before.gaps),
    ...Object.keys(after.gaps),
  ])) {
    const count = replace(
      current.gaps[reason] ?? '0',
      before.gaps[reason] ?? '0',
      after.gaps[reason] ?? '0',
    )
    if (count !== '0') gaps[reason] = count
  }
  return {
    tokens,
    bucketRecords,
    counters,
    gaps,
    unknownCoverage: replace(
      current.unknownCoverage,
      before.unknownCoverage,
      after.unknownCoverage,
    ),
    hidden: replace(current.hidden, before.hidden, after.hidden),
    unpriced: replace(current.unpriced, before.unpriced, after.unpriced),
  }
}

/** Preserve the existing four-bucket, known/unknown and exact CNY renderer. */
export function completeIncrementalObservationFold(
  current: IncrementalObservationFold,
): CompleteObservationFold {
  return {
    ...emptyCompleteObservationFold(),
    ...current.counters,
    tokens: { ...current.tokens },
    bucketRecords: { ...current.bucketRecords },
    tokenCoverageKnown: current.unknownCoverage === '0',
    visible: current.hidden === '0',
    priced: current.unpriced === '0',
    gaps: Object.keys(current.gaps).sort(),
  }
}
