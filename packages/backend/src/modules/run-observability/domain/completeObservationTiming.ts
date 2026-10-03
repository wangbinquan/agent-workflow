import type { ObservationTaskFacts, ObservationAttemptFacts } from '@agent-workflow/shared'
export interface CompleteObservationInterval {
  readonly start: number
  readonly end: number
}
export function completeObservationAttemptTiming(
  task: ObservationTaskFacts,
  attempt: ObservationAttemptFacts,
  asOf: number,
) {
  if (!Number.isSafeInteger(asOf)) throw new RangeError('Original timing snapshot invalid')
  const start = attempt.startedAt,
    open = attempt.finishedAt === null && attempt.status === 'running' && task.finishedAt === null
  const end = attempt.finishedAt ?? (open ? asOf : null)
  const valid =
    start !== null &&
    end !== null &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start <= end &&
    end <= asOf
  return {
    durationMs: valid ? String(end - start) : null,
    open: open && valid,
    interval: valid ? { start, end } : null,
  }
}
export async function completeObservationIntervalTotals(
  records: AsyncIterable<CompleteObservationInterval>,
) {
  let cumulative = 0n,
    union = 0n,
    previousEnd: number | undefined,
    previous: CompleteObservationInterval | undefined
  for await (const row of records) {
    if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.start > row.end)
      throw new RangeError('Original execution interval invalid')
    if (
      previous &&
      (row.start < previous.start || (row.start === previous.start && row.end < previous.end))
    )
      throw new Error('Original interval merge unordered')
    cumulative += BigInt(row.end - row.start)
    union += BigInt(Math.max(0, row.end - Math.max(previousEnd ?? row.start, row.start)))
    previousEnd = Math.max(previousEnd ?? row.end, row.end)
    previous = row
  }
  return { cumulativeMs: String(cumulative), activeUnionMs: String(union) }
}
