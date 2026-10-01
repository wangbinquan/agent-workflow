import type { ObservationMetrics } from '@agent-workflow/shared'

export const OBSERVATION_TOKEN_BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const

/** Per-bucket evidence proves known zero; query completeness controls the lower-bound prefix. */
export function formatObservationBucket(
  metrics: ObservationMetrics,
  bucket: (typeof OBSERVATION_TOKEN_BUCKETS)[number],
  locale?: string,
): string | null {
  const value = metrics.tokens.known[bucket]
  const hasKnown =
    metrics.tokens.hasKnown &&
    (metrics.tokens.hasKnownBuckets?.[bucket] ?? (metrics.tokens.complete || BigInt(value) > 0n))
  if (!hasKnown) return null
  return `${metrics.tokens.complete ? '' : '≥ '}${BigInt(value).toLocaleString(locale)}`
}

/** Format exact CNY decimals without a floating-point conversion, including tiny nonzero values. */
export function formatObservationCny(amount: string | null, exact = false): string {
  if (amount === null) return '—'
  if (exact) return `¥${amount}`
  const [whole = '0', fraction = ''] = amount.split('.')
  const picos = BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'))
  if (picos > 0n && picos < 1_000_000n) return '<¥0.000001'
  const micros = (picos + 500_000n) / 1_000_000n
  const decimal = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `¥${micros / 1_000_000n}${decimal ? '.' + decimal : ''}`
}
