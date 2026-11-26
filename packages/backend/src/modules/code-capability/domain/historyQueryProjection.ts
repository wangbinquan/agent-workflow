import type { CodeHistoryQueryRow } from './codeHistoryPackage'

export const CODE_HISTORY_QUERY_VERSION = 1

/** Fixed-width UTF-16 units retain the historical JavaScript string order on either provider. */
export function historyIdOrderKey(id: string): string {
  let result = ''
  for (let index = 0; index < id.length; index += 1)
    result += id.charCodeAt(index).toString(16).padStart(4, '0')
  return result
}

export const METRIC_COUNTERS = [
  'published',
  'adopted',
  'quietFix',
  'disagreed',
  'outstanding',
  'rounds',
  'runPublished',
  'runFailed',
  'runAwaiting',
  'incomplete',
] as const
export type HistoryMetricCounts = Record<(typeof METRIC_COUNTERS)[number], number>
export const emptyHistoryMetricCounts = (): HistoryMetricCounts => ({
  published: 0,
  adopted: 0,
  quietFix: 0,
  disagreed: 0,
  outstanding: 0,
  rounds: 0,
  runPublished: 0,
  runFailed: 0,
  runAwaiting: 0,
  incomplete: 0,
})

export function historyMetricPrefixes(input: {
  readonly findings: readonly CodeHistoryQueryRow<'code_findings'>[]
  readonly items: readonly CodeHistoryQueryRow<'code_work_items'>[]
  readonly rounds: readonly CodeHistoryQueryRow<'code_work_rounds'>[]
}) {
  const events = new Map<string, Map<number, HistoryMetricCounts>>()
  function at(capability: string, occurredAt: number) {
    let times = events.get(capability)
    if (times === undefined) {
      times = new Map()
      events.set(capability, times)
    }
    let counts = times.get(occurredAt)
    if (counts === undefined) {
      counts = emptyHistoryMetricCounts()
      times.set(occurredAt, counts)
    }
    return counts
  }
  for (const finding of input.findings) {
    if (finding.external_id === null) continue
    const counts = at(finding.capability, finding.created_at)
    counts.published += 1
    if (finding.resolved_at !== null && finding.code_changed_at !== null) counts.adopted += 1
    else if (finding.code_changed_at !== null) counts.quietFix += 1
    else if (finding.resolved_at !== null) counts.disagreed += 1
    else counts.outstanding += 1
  }
  const capabilities = new Map(input.items.map((row) => [row.id, row.capability]))
  for (const round of input.rounds) {
    const capability = capabilities.get(round.work_item_id)
    if (capability === undefined) continue
    const counts = at(capability, round.started_at)
    counts.rounds += 1
    if (round.outcome === 'published') counts.runPublished += 1
    else if (round.outcome === 'failed') counts.runFailed += 1
    else if (round.outcome === 'awaiting') counts.runAwaiting += 1
    else if (round.ended_at !== null) counts.incomplete += 1
  }
  const totals: Array<HistoryMetricCounts & { capability: string }> = []
  const prefixes: Array<HistoryMetricCounts & { capability: string; occurredAt: number }> = []
  for (const [capability, times] of events) {
    const counts = emptyHistoryMetricCounts()
    for (const [occurredAt, delta] of [...times].sort(([left], [right]) => left - right)) {
      for (const key of METRIC_COUNTERS) {
        counts[key] += delta[key]
        if (!Number.isSafeInteger(counts[key])) throw new RangeError('code-history-metric-overflow')
      }
      prefixes.push({ capability, occurredAt, ...counts })
    }
    totals.push({ capability, ...counts })
  }
  return { totals, prefixes }
}
