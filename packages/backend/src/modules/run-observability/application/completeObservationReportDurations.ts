import type { CompleteObservationCohortInput } from '../ports/completeObservationReport'
import type {
  CompleteObservationTask,
  CompleteObservationReportSummary,
} from '@agent-workflow/shared'
import { completeOrdinalKey } from '../domain/completeOrdinal'
import { completeExternalSort } from './completeExternalSort'
import { completeWorkingTraversal } from './completeWorkingTraversal'

/** Exact nearest-rank percentiles over every original Task duration. */
export function completeObservationReportDurations(input: CompleteObservationCohortInput) {
  const namespace = input.namespace + '/durations'
  let count = 0n,
    wall = 0n,
    running = 0n,
    unknown = 0n
  return {
    async add(task: CompleteObservationTask) {
      if (task.timing.wallMs === null) unknown++
      else {
        wall += BigInt(task.timing.wallMs)
        await input.rows.insert(namespace, [
          { key: completeOrdinalKey(count++), document: task.timing.wallMs },
        ])
      }
      if (task.timing.runningMs !== null) running += BigInt(task.timing.runningMs)
    },
    async totals(): Promise<CompleteObservationReportSummary['timing']> {
      if (!count)
        return {
          p50Ms: null,
          p95Ms: null,
          wallMs: String(wall),
          runningMs: String(running),
          unknown: String(unknown),
        }
      const sorted = await completeExternalSort({
        workspace: input.rows,
        namespace: namespace + '/sort',
        records: (async function* () {
          for await (const row of completeWorkingTraversal<string>(
            input.rows,
            namespace,
            input.signal,
          ))
            yield row.document
        })(),
        compare: (a, b) => (BigInt(a) === BigInt(b) ? 0 : BigInt(a) < BigInt(b) ? -1 : 1),
        signal: input.signal,
      })
      const ranks = [(count * 50n + 99n) / 100n - 1n, (count * 95n + 99n) / 100n - 1n]
      let n = 0n,
        p50Ms: string | null = null,
        p95Ms: string | null = null
      for await (const duration of sorted.records()) {
        if (n === ranks[0]) p50Ms = duration
        if (n === ranks[1]) p95Ms = duration
        n++
      }
      if (n !== count || p50Ms === null || p95Ms === null)
        throw new Error('Complete original duration population changed')
      return {
        p50Ms,
        p95Ms,
        wallMs: String(wall),
        runningMs: String(running),
        unknown: String(unknown),
      }
    },
  }
}
