import type { ObservationMeasurement } from '@agent-workflow/shared'
import type { TokenUsage } from './tokenUsage'
import { summarizeTokenUsage, TOKEN_BUCKETS, type TokenBucket } from './tokenUsage'

export interface UsageContributionEvidence {
  readonly sourceId: string
  readonly measurement: Pick<
    ObservationMeasurement,
    'invocationId' | 'recordId' | 'model' | 'scope' | 'coveredThroughTurn'
  >
  readonly contribution: TokenUsage
  readonly complete: boolean
  readonly coveredThrough?: Readonly<Record<TokenBucket, number | null>>
}
type ScopedRecord<T extends UsageContributionEvidence> = T & {
  measurement: T['measurement'] & {
    scope: NonNullable<ObservationMeasurement['scope']>
  }
}

function validateAncestry(records: readonly ScopedRecord<UsageContributionEvidence>[]) {
  const paths = new Map<string, string>()
  for (const {
    measurement: { scope },
  } of records) {
    const path = [...scope.ancestors, scope.session]
    if (new Set(path).size !== path.length) throw new Error('Cyclic observation session ancestry')
    if (path[0] !== scope.root || (scope.ancestors.at(-1) ?? null) !== scope.parentSession)
      throw new Error('Incomplete observation session ancestry')
    // Ancestors need not have emitted a measurement of their own.
    for (let i = 0; i < path.length; i++) {
      const id = path[i]!,
        expected = JSON.stringify(path.slice(0, i))
      if (paths.has(id) && paths.get(id) !== expected)
        throw new Error('Conflicting observation session ancestry')
      paths.set(id, expected)
    }
  }
}

function end(record: ScopedRecord<UsageContributionEvidence>, bucket: TokenBucket): number {
  return (
    record.coveredThrough?.[bucket] ??
    record.measurement.coveredThroughTurn ??
    record.measurement.scope.turnIndex
  )
}

/** Compare a selected aggregate with another piece of evidence. Partial overlap
 * cannot be subtracted safely without the original per-turn/model breakdown. */
function relation(
  a: ScopedRecord<UsageContributionEvidence>,
  b: ScopedRecord<UsageContributionEvidence>,
  bucket: TokenBucket,
) {
  const x = a.measurement.scope,
    y = b.measurement.scope
  const bInsideA =
    x.session === y.session || (x.level === 'tree-total' && y.ancestors.includes(x.session))
  const aInsideB = y.level === 'tree-total' && x.ancestors.includes(y.session)
  if (!bInsideA && !aInsideB) return 'disjoint'
  const aEnd = end(a, bucket),
    bEnd = end(b, bucket)
  if (aEnd < y.turnIndex || bEnd < x.turnIndex) return 'disjoint'
  const am = a.measurement.model,
    bm = b.measurement.model
  if (
    am &&
    bm &&
    (am.id !== bm.id ||
      (am.provider !== null && bm.provider !== null && am.provider !== bm.provider))
  )
    return 'disjoint'
  const modelCovered =
    am === null || (bm !== null && am.id === bm.id && am.provider === bm.provider)
  return bInsideA && modelCovered && x.turnIndex <= y.turnIndex && aEnd >= bEnd
    ? 'covered'
    : 'partial'
}

function selectTree<T extends UsageContributionEvidence>(records: readonly ScopedRecord<T>[]) {
  validateAncestry(records)
  const rank = { 'tree-total': 0, 'self-total': 1, request: 2 }
  const ordered = [...records].sort((a, b) => {
    const x = a.measurement.scope,
      y = b.measurement.scope
    return (
      rank[x.level] - rank[y.level] ||
      x.ancestors.length - y.ancestors.length ||
      x.turnIndex - y.turnIndex ||
      a.measurement.recordId.localeCompare(b.measurement.recordId)
    )
  })
  const allocated = new Map<ScopedRecord<T>, Record<TokenBucket, string | null>>()
  const unavailable = new Set<ScopedRecord<T>>(),
    ambiguous = new Set<ScopedRecord<T>>()
  for (const bucket of TOKEN_BUCKETS) {
    const aggregates: ScopedRecord<T>[] = []
    for (const record of ordered) {
      const overlaps = aggregates.map((a) => relation(a, record, bucket))
      if (overlaps.includes('covered')) continue
      if (overlaps.includes('partial')) {
        ambiguous.add(record)
        continue
      }
      const value = record.contribution[bucket]
      const isSummary = record.measurement.scope.level !== 'request'
      if (value === null && isSummary) {
        unavailable.add(record)
      }
      const row = allocated.get(record) ?? {
        input: '0',
        cacheRead: '0',
        cacheWrite: '0',
        output: '0',
      }
      row[bucket] = value
      allocated.set(record, row)
      if (value !== null && isSummary) aggregates.push(record)
    }
  }
  // These are query allocations, never persisted ledger revisions. A zero in an
  // excluded bucket means "allocated elsewhere", not measured zero usage.
  return {
    selected: [...allocated].map(([record, contribution]) => ({ ...record, contribution })),
    unavailableSummaries: unavailable.size,
    ambiguousOverlaps: ambiguous.size,
  }
}

/** Select disjoint evidence per model and bucket using native turn coverage.
 * Delivery order alone never proves that a cumulative report covers a child. */
export function selectUsageContributions<T extends UsageContributionEvidence>(
  records: readonly T[],
) {
  const groups = new Map<string, ScopedRecord<T>[]>()
  const selected: T[] = []
  let unavailableSummaries = 0,
    ambiguousOverlaps = 0
  for (const record of records) {
    const m = record.measurement
    if (!m.scope) {
      selected.push(record)
      continue
    }
    const key = JSON.stringify([record.sourceId, m.invocationId, m.scope.root])
    const group = groups.get(key) ?? []
    group.push(record as ScopedRecord<T>)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const result = selectTree(group)
    selected.push(...result.selected)
    unavailableSummaries += result.unavailableSummaries
    ambiguousOverlaps += result.ambiguousOverlaps
  }
  return {
    records: selected,
    excluded: records.length - selected.length,
    summary: summarizeTokenUsage(selected.map((r) => r.contribution)),
    unavailableSummaries,
    ambiguousOverlaps,
    allSelectedComplete:
      selected.length > 0 &&
      unavailableSummaries === 0 &&
      ambiguousOverlaps === 0 &&
      selected.every((r) => r.complete),
  }
}
