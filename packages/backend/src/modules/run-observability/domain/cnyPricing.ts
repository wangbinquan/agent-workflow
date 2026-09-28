import { TOKEN_BUCKETS, tokenCount, type TokenBucket, type TokenUsage } from './tokenUsage'

/** Yuan per million tokens, up to six decimal places; null means unpriced. */
export type CnyRates = Readonly<Record<TokenBucket, string | null>>
const PICO_YUAN = 1_000_000_000_000n

export function rateMicros(value: string | null): bigint | null {
  if (value === null) return null
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value)) {
    throw new RangeError('CNY rate must be a nonnegative decimal with at most six places')
  }
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}

function decimalAtScale(value: bigint, places: number): string {
  const scale = 10n ** BigInt(places)
  const fraction = (value % scale).toString().padStart(places, '0').replace(/0+$/, '')
  return `${value / scale}${fraction ? `.${fraction}` : ''}`
}

export interface CnyValuation {
  readonly currency: 'CNY'
  /** Exact subtotal in yuan. Not rounded until presentation. */
  readonly knownAmount: string
  readonly completeness: 'complete' | 'partial' | 'unpriced'
  readonly missing: readonly TokenBucket[]
}

export function valueTokenUsage(usage: TokenUsage, rates: CnyRates): CnyValuation {
  let amount = 0n,
    priced = 0
  const missing: TokenBucket[] = []
  for (const bucket of TOKEN_BUCKETS) {
    const count = tokenCount(usage[bucket]),
      rate = rateMicros(rates[bucket])
    if (count === null || (rate === null && count !== '0')) missing.push(bucket)
    else {
      amount += BigInt(count) * (rate ?? 0n)
      priced++
    }
  }
  return {
    currency: 'CNY',
    knownAmount: decimalAtScale(amount, 12),
    completeness: missing.length === 0 ? 'complete' : priced === 0 ? 'unpriced' : 'partial',
    missing,
  }
}

export function cnyPicos(amount: string): bigint {
  if (!/^(0|[1-9]\d{0,79})(\.\d{1,12})?$/.test(amount))
    throw new RangeError('Invalid exact CNY amount')
  const [whole = '0', fraction = ''] = amount.split('.')
  return BigInt(whole) * PICO_YUAN + BigInt(fraction.padEnd(12, '0'))
}

export function sumCnyAmounts(amounts: readonly string[]): string {
  return decimalAtScale(
    amounts.reduce((total, amount) => total + cnyPicos(amount), 0n),
    12,
  )
}

export function formatCnyAmount(amount: string): string {
  const picos = cnyPicos(amount)
  if (picos > 0n && picos < 1_000_000n) return '<¥0.000001'
  return `¥${decimalAtScale((picos + 500_000n) / 1_000_000n, 6)}`
}
