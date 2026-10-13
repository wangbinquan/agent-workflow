/** The picker uses the browser's local zone, while report/URL boundaries stay
 * exact epoch milliseconds. Leaving a boundary untouched preserves its seconds. */
export function observationLocalDateInput(at: number): string {
  const value = new Date(at)
  if (!Number.isFinite(value.getTime())) return ''
  return new Date(at - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export function observationCustomRange(
  draft: { from: string; to: string },
  current: { from: number; to: number },
): { from: number; to: number } | null {
  const boundary = (value: string, previous: number) => {
    if (value === observationLocalDateInput(previous)) return previous
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN
    const at = Date.parse(value)
    // Reject calendar rollover and a nonexistent local DST time.
    return Number.isFinite(at) && observationLocalDateInput(at) === value ? at : NaN
  }
  const from = boundary(draft.from, current.from),
    to = boundary(draft.to, current.to)
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && from < to
    ? { from, to }
    : null
}
