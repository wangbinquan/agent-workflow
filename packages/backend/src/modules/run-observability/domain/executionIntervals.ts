export interface ExecutionInterval {
  readonly start: number
  readonly end: number | null
}

/** Clip to one immutable query snapshot. Open intervals end at asOf. */
export function intervalDurations(
  intervals: readonly ExecutionInterval[],
  window: { from: number; to: number; asOf: number },
): { cumulativeMs: number; activeUnionMs: number } {
  const { from, to, asOf } = window
  if (![from, to, asOf].every(Number.isSafeInteger) || to < from)
    throw new RangeError('Invalid observation window')
  const clipped: Array<{ start: number; end: number }> = []
  for (const interval of intervals) {
    if (
      !Number.isSafeInteger(interval.start) ||
      (interval.end !== null &&
        (!Number.isSafeInteger(interval.end) || interval.end < interval.start))
    ) {
      throw new RangeError('Invalid execution interval')
    }
    const start = Math.max(from, interval.start),
      end = Math.min(to, asOf, interval.end ?? asOf)
    if (end > start) clipped.push({ start, end })
  }
  clipped.sort((a, b) => a.start - b.start || a.end - b.end)
  let cumulativeMs = 0,
    activeUnionMs = 0,
    previousEnd = -Infinity
  for (const interval of clipped) {
    cumulativeMs += interval.end - interval.start
    activeUnionMs += Math.max(0, interval.end - Math.max(previousEnd, interval.start))
    previousEnd = Math.max(previousEnd, interval.end)
  }
  if (!Number.isSafeInteger(cumulativeMs) || !Number.isSafeInteger(activeUnionMs))
    throw new RangeError('Duration exceeds exact integer range')
  return { cumulativeMs, activeUnionMs }
}
