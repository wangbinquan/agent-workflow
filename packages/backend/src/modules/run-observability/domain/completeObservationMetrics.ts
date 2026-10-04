import type { CompleteObservationMetrics, ObservationTokenUsage } from '@agent-workflow/shared'
import { TOKEN_BUCKETS, tokenCount } from './tokenUsage'
import { cnyPicos } from './cnyPricing'
export interface CompleteObservationFold {
  tokens: Record<keyof ObservationTokenUsage, string>
  invocations: string
  observedInvocations: string
  records: string
  costRecords?: string
  pricedRecords?: string
  picos: string
  visible: boolean
  priced: boolean
  gaps: string[]
}
export function emptyCompleteObservationFold(invocations = '0'): CompleteObservationFold {
  return {
    tokens: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
    invocations,
    observedInvocations: '0',
    records: '0',
    costRecords: '0',
    pricedRecords: '0',
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
) {
  fold.costRecords = String(BigInt(fold.costRecords ?? fold.records) + 1n)
  fold.pricedRecords ??= fold.priced ? fold.records : '0'
  fold.records = String(BigInt(fold.records) + 1n)
  for (const bucket of TOKEN_BUCKETS) {
    const count = tokenCount(contribution[bucket])
    if (count === null) completeObservationGap(fold, 'usage-incomplete')
    else fold.tokens[bucket] = String(BigInt(fold.tokens[bucket]) + BigInt(count))
  }
  fold.visible &&= !cost.hidden
  if (!cost.complete || cost.amount === null) fold.priced = false
  else {
    fold.picos = String(BigInt(fold.picos) + cnyPicos(cost.amount))
    if (!cost.hidden) fold.pricedRecords = String(BigInt(fold.pricedRecords) + 1n)
  }
}
export function mergeCompleteObservationFold(
  into: CompleteObservationFold,
  next: CompleteObservationFold,
) {
  into.costRecords = String(
    BigInt(into.costRecords ?? into.records) + BigInt(next.costRecords ?? next.records),
  )
  into.pricedRecords = String(
    BigInt(into.pricedRecords ?? (into.priced ? into.records : '0')) +
      BigInt(next.pricedRecords ?? (next.priced ? next.records : '0')),
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
  const recordedCost =
    fold.visible && BigInt(pricedRecords) > 0n
      ? { currency: 'CNY' as const, amount, records, pricedRecords }
      : undefined
  if (fold.gaps.length)
    return {
      state: 'not-ready',
      gaps: [...fold.gaps],
      ...(records !== '0' || !fold.visible
        ? {
            costCoverage: {
              records,
              pricedRecords,
              visibility: fold.visible ? ('visible' as const) : ('hidden' as const),
            },
          }
        : {}),
      ...(recordedCost ? { recordedCost } : {}),
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
