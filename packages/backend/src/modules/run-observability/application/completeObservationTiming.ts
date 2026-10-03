import type {
  ObservationTaskFacts,
  ObservationAttemptFacts,
  CompleteObservationMetrics,
  CompleteObservationTiming,
} from '@agent-workflow/shared'
import type { CompleteWorkingRows } from '../ports/completeWorkingRows'
import {
  completeObservationAttemptTiming,
  completeObservationIntervalTotals,
  type CompleteObservationInterval,
} from '../domain/completeObservationTiming'
import { completeWorkingPages, completeWorkingTraversal } from './completeWorkingTraversal'
import { completeExternalSort } from './completeExternalSort'

/** Timing retains every original child and merges intervals outside JS memory. */
export async function buildCompleteObservationTiming(input: {
  readonly task: ObservationTaskFacts
  readonly asOf: number
  readonly rows: CompleteWorkingRows
  readonly attemptsNamespace: string
  readonly namespace: string
  readonly signal?: AbortSignal
}): Promise<CompleteObservationTiming> {
  let unknown = 0n,
    start: number | undefined,
    end: number | undefined
  const intervalSpace = input.namespace + '/input'
  for await (const page of completeWorkingPages<
    ObservationAttemptFacts & { metrics: CompleteObservationMetrics }
  >(input.rows, input.attemptsNamespace, input.signal)) {
    const intervals: Array<{ key: string; document: CompleteObservationInterval }> = []
    const attempts = page.map((row) => {
      const timing = completeObservationAttemptTiming(input.task, row.document, input.asOf)
      if (timing.interval) {
        intervals.push({ key: row.key, document: timing.interval })
        start = Math.min(start ?? timing.interval.start, timing.interval.start)
        end = Math.max(end ?? timing.interval.end, timing.interval.end)
      } else unknown++
      return {
        key: row.key,
        document: { ...row.document, durationMs: timing.durationMs, open: timing.open },
      }
    })
    await input.rows.upsert(input.attemptsNamespace, attempts)
    await input.rows.insert(intervalSpace, intervals)
  }
  const taskEnd = input.task.finishedAt ?? input.asOf,
    valid =
      Number.isSafeInteger(input.task.startedAt) &&
      Number.isSafeInteger(taskEnd) &&
      input.task.startedAt <= taskEnd &&
      taskEnd <= input.asOf
  const wallMs = valid ? String(taskEnd - input.task.startedAt) : null
  const active =
    input.task.runningSince === null ? 0 : Math.max(0, taskEnd - input.task.runningSince)
  const runningMs =
    valid &&
    Number.isSafeInteger(input.task.runningMs) &&
    input.task.runningMs >= 0 &&
    Number.isSafeInteger(active)
      ? String(BigInt(input.task.runningMs) + BigInt(active))
      : null
  const range = start === undefined || end === undefined ? null : { from: start, to: end }
  if (unknown)
    return { wallMs, runningMs, range, intervals: { state: 'not-ready', unknown: String(unknown) } }
  const sorted = await completeExternalSort({
    workspace: input.rows,
    namespace: input.namespace + '/merge',
    records: (async function* () {
      for await (const row of completeWorkingTraversal<CompleteObservationInterval>(
        input.rows,
        intervalSpace,
        input.signal,
      ))
        yield row.document
    })(),
    compare: (a, b) => a.start - b.start || a.end - b.end,
    signal: input.signal,
  })
  return {
    wallMs,
    runningMs,
    range,
    intervals: {
      state: 'complete',
      unknown: '0',
      ...(await completeObservationIntervalTotals(sorted.records())),
    },
  }
}
