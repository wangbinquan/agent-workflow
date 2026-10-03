/** Decimal length followed by decimal digits preserves arbitrary exact ordinal order as text. */
export function completeOrdinalKey(value: bigint): string {
  if (value < 0n) throw new RangeError('Negative complete report ordinal')
  const digits = value.toString()
  // A JS string's length is a safe integer; this prefix bounds neither rows nor ordinal magnitude.
  return `${String(digits.length).padStart(16, '0')}:${digits}`
}
