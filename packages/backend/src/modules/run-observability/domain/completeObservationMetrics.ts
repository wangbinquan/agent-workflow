import type { CompleteObservationMetrics, ObservationTokenUsage } from '@agent-workflow/shared'
import { TOKEN_BUCKETS, tokenCount } from './tokenUsage'
import { cnyPicos } from './cnyPricing'
export interface CompleteObservationFold {
  tokens: Record<keyof ObservationTokenUsage, string>
  invocations: string
  observedInvocations: string
  records: string
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
  fold.records = String(BigInt(fold.records) + 1n)
  for (const bucket of TOKEN_BUCKETS) {
    const count = tokenCount(contribution[bucket])
    if (count === null) completeObservationGap(fold, 'usage-incomplete')
    else fold.tokens[bucket] = String(BigInt(fold.tokens[bucket]) + BigInt(count))
  }
  fold.visible &&= !cost.hidden
  if (!cost.complete || cost.amount === null) fold.priced = false
  else fold.picos = String(BigInt(fold.picos) + cnyPicos(cost.amount))
}
export function mergeCompleteObservationFold(
  into: CompleteObservationFold,
  next: CompleteObservationFold,
) {
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
  if (fold.gaps.length) return { state: 'not-ready', gaps: [...fold.gaps] }
  if (fold.invocations === '0') return { state: 'not-applicable' }
  const state = !fold.visible ? 'hidden' : fold.priced ? 'complete' : 'unpriced',
    n = BigInt(fold.picos)
  const fraction = (n % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '')
  const amount = `${n / 1_000_000_000_000n}${fraction ? '.' + fraction : ''}`
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
  }
}
