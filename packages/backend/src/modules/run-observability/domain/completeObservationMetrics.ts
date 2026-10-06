import type { CompleteObservationMetrics, ObservationTokenUsage } from '@agent-workflow/shared'
import { TOKEN_BUCKETS, tokenCount } from './tokenUsage'
import { cnyPicos } from './cnyPricing'
export interface CompleteObservationFold {
  tokens: Record<keyof ObservationTokenUsage, string>
  bucketRecords?: Record<keyof ObservationTokenUsage, string>
  /** Old immutable incomplete metrics do not prove a new Token population. */
  tokenCoverageKnown?: boolean
  invocations: string
  observedInvocations: string
  records: string
  costRecords?: string
  pricedRecords?: string
  partiallyPricedRecords?: string
  picos: string
  visible: boolean
  priced: boolean
  gaps: string[]
}
export function emptyCompleteObservationFold(invocations = '0'): CompleteObservationFold {
  return {
    tokens: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
    bucketRecords: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
    tokenCoverageKnown: true,
    invocations,
    observedInvocations: '0',
    records: '0',
    costRecords: '0',
    pricedRecords: '0',
    partiallyPricedRecords: '0',
    picos: '0',
    visible: true,
    priced: true,
    gaps: [],
  }
}
export function completeObservationGap(fold: CompleteObservationFold, reason: string) {
  if (!fold.gaps.includes(reason)) fold.gaps.push(reason)
}
export function addCompleteObservationAllocation(
  fold: CompleteObservationFold,
  contribution: ObservationTokenUsage,
  cost: { readonly amount: string | null; readonly complete: boolean; readonly hidden: boolean },
  qualified = true,
) {
  fold.bucketRecords ??= Object.fromEntries(
    TOKEN_BUCKETS.map((bucket) => [bucket, fold.records]),
  ) as Record<keyof ObservationTokenUsage, string>
  fold.costRecords = String(BigInt(fold.costRecords ?? fold.records) + 1n)
  fold.pricedRecords ??= fold.priced ? fold.records : '0'
  fold.records = String(BigInt(fold.records) + 1n)
  fold.visible &&= !cost.hidden
  if (!qualified) {
    completeObservationGap(fold, 'coverage-incomplete')
    fold.priced = false
    return
  }
  for (const bucket of TOKEN_BUCKETS) {
    const count = tokenCount(contribution[bucket])
    if (count === null) completeObservationGap(fold, 'usage-incomplete')
    else {
      fold.tokens[bucket] = String(BigInt(fold.tokens[bucket]) + BigInt(count))
      fold.bucketRecords[bucket] = String(BigInt(fold.bucketRecords[bucket]) + 1n)
    }
  }
  const completeCost =
    cost.complete &&
    cost.amount !== null &&
    TOKEN_BUCKETS.every((bucket) => contribution[bucket] !== null)
  if (!completeCost) fold.priced = false
  if (completeCost) {
    fold.picos = String(BigInt(fold.picos) + cnyPicos(cost.amount!))
    if (!cost.hidden) fold.pricedRecords = String(BigInt(fold.pricedRecords) + 1n)
  } else if (
    !cost.hidden &&
    !cost.complete &&
    cost.amount !== null &&
    TOKEN_BUCKETS.some((bucket) => contribution[bucket] !== null)
  ) {
    fold.picos = String(BigInt(fold.picos) + cnyPicos(cost.amount))
    fold.partiallyPricedRecords = String(BigInt(fold.partiallyPricedRecords ?? '0') + 1n)
  }
}
export function mergeCompleteObservationFold(
  into: CompleteObservationFold,
  next: CompleteObservationFold,
) {
  into.bucketRecords = Object.fromEntries(
    TOKEN_BUCKETS.map((bucket) => [
      bucket,
      String(
        BigInt(into.bucketRecords?.[bucket] ?? into.records) +
          BigInt(next.bucketRecords?.[bucket] ?? next.records),
      ),
    ]),
  ) as Record<keyof ObservationTokenUsage, string>
  into.tokenCoverageKnown = into.tokenCoverageKnown !== false && next.tokenCoverageKnown !== false
  into.costRecords = String(
    BigInt(into.costRecords ?? into.records) + BigInt(next.costRecords ?? next.records),
  )
  into.pricedRecords = String(
    BigInt(into.pricedRecords ?? (into.priced ? into.records : '0')) +
      BigInt(next.pricedRecords ?? (next.priced ? next.records : '0')),
  )
  into.partiallyPricedRecords = String(
    BigInt(into.partiallyPricedRecords ?? '0') + BigInt(next.partiallyPricedRecords ?? '0'),
  )
  for (const bucket of TOKEN_BUCKETS)
    into.tokens[bucket] = String(BigInt(into.tokens[bucket]) + BigInt(next.tokens[bucket]))
  for (const field of ['invocations', 'observedInvocations', 'records', 'picos'] as const)
    into[field] = String(BigInt(into[field]) + BigInt(next[field]))
  into.visible &&= next.visible
  into.priced &&= next.priced
  for (const reason of next.gaps) completeObservationGap(into, reason)
}
export function completeObservationMetrics(
  fold: CompleteObservationFold,
): CompleteObservationMetrics {
  const n = BigInt(fold.picos)
  const fraction = (n % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '')
  const amount = `${n / 1_000_000_000_000n}${fraction ? '.' + fraction : ''}`
  const records = fold.costRecords ?? fold.records,
    pricedRecords = fold.pricedRecords ?? (fold.priced ? fold.records : '0')
  const partiallyPricedRecords = fold.partiallyPricedRecords ?? '0'
  const partialCoverage = BigInt(partiallyPricedRecords) > 0n ? { partiallyPricedRecords } : {}
  const recordedCost =
    fold.visible && BigInt(pricedRecords) + BigInt(partiallyPricedRecords) > 0n
      ? { currency: 'CNY' as const, amount, records, pricedRecords, ...partialCoverage }
      : undefined
  if (fold.gaps.length) {
    const tokenCoverage = {
      invocations: fold.invocations,
      observedInvocations: fold.observedInvocations,
      records: fold.records,
      bucketRecords: {
        ...(fold.bucketRecords ?? {
          input: fold.records,
          cacheRead: fold.records,
          cacheWrite: fold.records,
          output: fold.records,
        }),
      },
    }
    const recordedUsage =
      fold.tokenCoverageKnown !== false &&
      TOKEN_BUCKETS.some((bucket) => tokenCoverage.bucketRecords[bucket] !== '0')
        ? {
            ...tokenCoverage,
            tokens: {
              ...(Object.fromEntries(
                TOKEN_BUCKETS.map((bucket) => [
                  bucket,
                  tokenCoverage.bucketRecords[bucket] === '0' ? null : fold.tokens[bucket],
                ]),
              ) as Record<keyof ObservationTokenUsage, string | null>),
              total: String(
                TOKEN_BUCKETS.reduce((sum, bucket) => sum + BigInt(fold.tokens[bucket]), 0n),
              ),
            },
          }
        : undefined
    return {
      state: 'not-ready',
      gaps: [...fold.gaps],
      ...(fold.tokenCoverageKnown !== false ? { tokenCoverage } : {}),
      ...(recordedUsage ? { recordedUsage } : {}),
      ...(records !== '0' || !fold.visible
        ? {
            costCoverage: {
              records,
              pricedRecords,
              ...partialCoverage,
              visibility: fold.visible ? ('visible' as const) : ('hidden' as const),
            },
          }
        : {}),
      ...(recordedCost ? { recordedCost } : {}),
    }
  }
  if (fold.invocations === '0') return { state: 'not-applicable' }
  const state = !fold.visible ? 'hidden' : fold.priced ? 'complete' : 'unpriced'
  return {
    state: 'ready',
    invocations: fold.invocations,
    observedInvocations: fold.observedInvocations,
    records: fold.records,
    tokens: {
      ...fold.tokens,
      total: String(TOKEN_BUCKETS.reduce((sum, bucket) => sum + BigInt(fold.tokens[bucket]), 0n)),
    },
    cost: { currency: 'CNY', state, amount: state === 'complete' ? amount : null },
    ...(state === 'unpriced' && recordedCost ? { recordedCost } : {}),
  }
}
