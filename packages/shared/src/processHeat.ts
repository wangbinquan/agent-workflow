// RFC-616 §7 / §10 — five heat bins by rank, shared by every heat map (canvas
// nodes, the responsibility map, the member table) so they bin the same way.

/** The darkest bin. */
export const PROCESS_HEAT_BINS = 5

/**
 * A value's bin depends on its position among the distinct values, so one
 * extreme value cannot push everything else into the lightest bin.
 * 0 = not applicable (null); a single distinct value sits in the middle bin.
 */
export function processRankBins(values: readonly (number | null)[]): number[] {
  const distinct = [...new Set(values.filter((value): value is number => value !== null))].sort(
    (a, b) => a - b,
  )
  const position = new Map(distinct.map((value, index) => [value, index]))
  return values.map((value) => {
    if (value === null) return 0
    if (distinct.length < 2) return 3
    return 1 + Math.round(((PROCESS_HEAT_BINS - 1) * position.get(value)!) / (distinct.length - 1))
  })
}
