import type { ObservationMetrics } from '@agent-workflow/shared'
import { sumCnyAmounts } from './cnyPricing'
import { TOKEN_BUCKETS } from './tokenUsage'

/** Only disjoint task/invocation contributions may be added here. Unknown is never zero. */
export function aggregateObservationMetrics(
  rows: readonly ObservationMetrics[],
  truncated = false,
): ObservationMetrics {
  const amounts = rows.flatMap((row) =>
    row.cost.knownAmount === null ? [] : [row.cost.knownAmount],
  )
  const sum = (get: (row: ObservationMetrics) => number) => rows.reduce((n, row) => n + get(row), 0)
  const known = { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' }
  const unknownBuckets = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const bucket of TOKEN_BUCKETS) {
    known[bucket] = rows.reduce((n, row) => n + BigInt(row.tokens.known[bucket]), 0n).toString()
    unknownBuckets[bucket] = sum((row) => row.tokens.unknownBuckets[bucket])
  }
  truncated ||= rows.some((row) => row.truncated)
  return {
    invocations: sum((row) => row.invocations),
    observedInvocations: sum((row) => row.observedInvocations),
    records: sum((row) => row.records),
    tokens: {
      known,
      totalKnown: TOKEN_BUCKETS.reduce((n, bucket) => n + BigInt(known[bucket]), 0n).toString(),
      hasKnown: rows.some((row) => row.tokens.hasKnown),
      complete: rows.length > 0 && !truncated && rows.every((row) => row.tokens.complete),
      unknownBuckets,
    },
    cost: {
      currency: 'CNY',
      knownAmount: amounts.length ? sumCnyAmounts(amounts) : null,
      complete: rows.length > 0 && !truncated && rows.every((row) => row.cost.complete),
      pricedRecords: sum((row) => row.cost.pricedRecords),
      priceVersionIds: [...new Set(rows.flatMap((row) => row.cost.priceVersionIds))],
      reasons: [
        ...new Set([
          ...rows.flatMap((row) => row.cost.reasons),
          ...(truncated ? ['truncated'] : []),
        ]),
      ],
    },
    authorities: [...new Set(rows.flatMap((row) => row.authorities))],
    truncated,
  }
}
