// RFC-371 v2 §5 — pure statistical helpers shared by every aggregate query.

const DAY_MS = 86_400_000

/** Nearest-rank percentile of an ascending sample; null when empty. */
export function nearestRank(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)))
  return sorted[rank - 1]!
}

/** Day index of an instant at a fixed UTC offset (minutes east of UTC). */
export function dayIndex(epochMs: number, offsetMinutes: number): number {
  return Math.floor((epochMs + offsetMinutes * 60_000) / DAY_MS)
}

/** `YYYY-MM-DD` of a day index. */
export function dayLabel(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10)
}

/** Every day index touched by [from, to), so a chart axis has no gaps. */
export function dayIndexes(from: number, to: number, offsetMinutes: number): number[] {
  const first = dayIndex(from, offsetMinutes)
  const last = dayIndex(to - 1, offsetMinutes)
  const days: number[] = []
  for (let day = first; day <= last; day++) days.push(day)
  return days
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}
