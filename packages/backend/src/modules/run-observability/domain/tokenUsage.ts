/** RFC-371: four disjoint buckets. Decimal strings preserve large aggregates. */
export const TOKEN_BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const
export type TokenBucket = (typeof TOKEN_BUCKETS)[number]
export type TokenUsage = Readonly<Record<TokenBucket, string | null>>

export function tokenCount(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  if (typeof value === 'string' && /^(0|[1-9]\d{0,59})$/.test(value)) return value
  throw new RangeError('Token count must be a nonnegative exact integer or null')
}

export function normalizeTokenUsage(value: Readonly<Record<TokenBucket, unknown>>): TokenUsage {
  return {
    input: tokenCount(value.input),
    cacheRead: tokenCount(value.cacheRead),
    cacheWrite: tokenCount(value.cacheWrite),
    output: tokenCount(value.output),
  }
}

export interface TokenSummary {
  readonly known: Readonly<Record<TokenBucket, string>>
  readonly totalKnown: string
  readonly measured: number
  readonly complete: number
  readonly unknownBuckets: Readonly<Record<TokenBucket, number>>
}

/** Only mutually exclusive ledger contributions belong here, never parent + child. */
export function summarizeTokenUsage(rows: readonly TokenUsage[]): TokenSummary {
  const known = { input: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n }
  const unknownBuckets = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  let complete = 0
  for (const row of rows) {
    let missing = false
    for (const bucket of TOKEN_BUCKETS) {
      const count = tokenCount(row[bucket])
      if (count === null) {
        unknownBuckets[bucket]++
        missing = true
      } else known[bucket] += BigInt(count)
    }
    if (!missing) complete++
  }
  return {
    known: {
      input: String(known.input),
      cacheRead: String(known.cacheRead),
      cacheWrite: String(known.cacheWrite),
      output: String(known.output),
    },
    totalKnown: String(known.input + known.cacheRead + known.cacheWrite + known.output),
    measured: rows.length,
    complete,
    unknownBuckets,
  }
}

/** A resume baseline must come from the same native lineage, not another invocation. */
export function subtractTokenBaseline(current: TokenUsage, baseline: TokenUsage): TokenUsage {
  const subtract = (bucket: TokenBucket): string | null => {
    const next = tokenCount(current[bucket]),
      before = tokenCount(baseline[bucket])
    if (next === null || before === null) return null
    const delta = BigInt(next) - BigInt(before)
    if (delta < 0n) throw new RangeError('Cumulative usage decreased without a correction or reset')
    return String(delta)
  }
  return {
    input: subtract('input'),
    cacheRead: subtract('cacheRead'),
    cacheWrite: subtract('cacheWrite'),
    output: subtract('output'),
  }
}
