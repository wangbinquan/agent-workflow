/** Format exact CNY decimals without a floating-point conversion, including tiny nonzero values. */
export function formatObservationCny(amount: string | null): string {
  if (amount === null) return '—'
  const [whole = '0', fraction = ''] = amount.split('.')
  const picos = BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'))
  if (picos > 0n && picos < 1_000_000n) return '<¥0.000001'
  const micros = (picos + 500_000n) / 1_000_000n
  const decimal = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `¥${micros / 1_000_000n}${decimal ? '.' + decimal : ''}`
}
