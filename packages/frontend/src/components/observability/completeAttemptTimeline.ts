import type { CompleteObservationAttempt } from '@agent-workflow/shared'

export type CompleteTimelineAlignment = 'task-relative' | 'absolute'
type TimedAttempt = Pick<CompleteObservationAttempt, 'startedAt' | 'finishedAt' | 'open'> & {
  readonly taskId: string
}
/** Display coordinates only. Original timestamps, metrics and the complete report stay unchanged. */
export function projectCompleteAttemptTimeline(
  rows: readonly TimedAttempt[],
  asOf: number,
  alignment: CompleteTimelineAlignment,
) {
  const origins = new Map<string, number>()
  if (alignment === 'task-relative')
    for (const row of rows) {
      const end = row.finishedAt ?? (row.open ? asOf : null)
      if (row.startedAt === null || (end !== null && end < row.startedAt)) continue
      const previous = origins.get(row.taskId)
      if (previous === undefined || row.startedAt < previous) origins.set(row.taskId, row.startedAt)
    }
  const intervals = rows.map((row) => {
    const origin = alignment === 'absolute' ? 0 : origins.get(row.taskId)
    const end = row.finishedAt ?? (row.open ? asOf : null)
    return {
      start: origin === undefined || row.startedAt === null ? null : row.startedAt - origin,
      end: origin === undefined || end === null ? null : end - origin,
    }
  })
  let from: number | null = alignment === 'task-relative' ? 0 : null
  if (alignment === 'absolute')
    for (const interval of intervals)
      if (interval.start !== null && (from === null || interval.start < from)) from = interval.start
  from ??= asOf
  let to = from + 1
  for (let index = 0; index < intervals.length; index++) {
    const interval = intervals[index]!
    if (interval.start === null) continue
    if (interval.end !== null && interval.end >= interval.start) to = Math.max(to, interval.end)
    else if (rows[index]!.open) to = Math.max(to, interval.start)
  }
  return { from, to, intervals }
}
