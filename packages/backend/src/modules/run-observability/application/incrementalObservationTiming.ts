import type {
  CompleteObservationTiming,
  ObservationAttemptFacts,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
import {
  completeObservationAttemptTiming,
  completeObservationIntervalTotals,
  type CompleteObservationInterval,
} from '../domain/completeObservationTiming'

/** Lifecycle clocks are frozen to the report version. Descendant intervals are
 * merged together so a root's parallel agents are not counted as wall time. */
export async function incrementalObservationTiming(
  task: ObservationTaskFacts,
  attempts: readonly {
    readonly task: ObservationTaskFacts
    readonly attempt: ObservationAttemptFacts
  }[],
  asOf: number,
): Promise<CompleteObservationTiming> {
  const intervals: CompleteObservationInterval[] = []
  let unknown = 0n
  for (const row of attempts) {
    const timing = completeObservationAttemptTiming(row.task, row.attempt, asOf)
    if (timing.interval) intervals.push(timing.interval)
    else unknown++
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end)
  const end = task.finishedAt ?? asOf,
    valid =
      Number.isSafeInteger(task.startedAt) &&
      Number.isSafeInteger(end) &&
      task.startedAt <= end &&
      end <= asOf
  const active = task.runningSince === null ? 0 : Math.max(0, end - task.runningSince)
  return {
    wallMs: valid ? String(end - task.startedAt) : null,
    runningMs:
      valid &&
      task.runningMs !== null &&
      Number.isSafeInteger(task.runningMs) &&
      task.runningMs >= 0 &&
      Number.isSafeInteger(active)
        ? String(BigInt(task.runningMs) + BigInt(active))
        : null,
    range: intervals.length
      ? {
          from: intervals[0]!.start,
          to: intervals.reduce((end, row) => Math.max(end, row.end), intervals[0]!.end),
        }
      : null,
    intervals: unknown
      ? { state: 'not-ready', unknown: String(unknown) }
      : {
          state: 'complete',
          unknown: '0',
          ...(await completeObservationIntervalTotals(
            (async function* () {
              yield* intervals
            })(),
          )),
        },
  }
}
