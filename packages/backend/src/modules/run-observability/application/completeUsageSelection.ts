import type { UsageContributionEvidence } from '../domain/usageSelection'
import { TOKEN_BUCKETS, tokenCount, type TokenBucket, type TokenUsage } from '../domain/tokenUsage'
import { coveragePrefixMaximum, insertCoverageInterval } from '../domain/coverageIntervalIndex'
import type { CompleteUsageWorkspace } from '../ports/completeUsageWorkspace'
import { isNativeUsageScope } from '../domain/nativeUsageScope'

function depthOf(record: UsageContributionEvidence): bigint {
  const scope = record.measurement.scope
  if (!scope) return 0n
  if (!isNativeUsageScope(scope)) return BigInt(scope.ancestors.length)
  if (!record.nativeScopeFacts) throw new Error('Original native scope depth is unverified')
  return BigInt(record.nativeScopeFacts.depth)
}
async function* sessionsOf<T extends UsageContributionEvidence>(
  workspace: CompleteUsageWorkspace<T>,
  record: T,
) {
  const scope = record.measurement.scope!
  if (!isNativeUsageScope(scope)) {
    yield { id: scope.session, treeOnly: false }
    for (const id of scope.ancestors) yield { id, treeOnly: true }
    return
  }
  if (!workspace.nativePath) throw new Error('Original native ancestry source is not installed')
  let first = true
  for await (const link of workspace.nativePath(record)) {
    yield { id: link.session, treeOnly: !first }
    first = false
  }
}

const rank = { 'tree-total': 0, 'self-total': 1, request: 2 }
const groupOf = (record: UsageContributionEvidence) =>
  JSON.stringify([
    record.sourceId,
    record.measurement.invocationId,
    record.measurement.scope?.root ?? null,
  ])
const modelPartition = (id: string, provider: string | null) =>
  JSON.stringify(['model', id, provider])
const modelAnyProvider = (id: string) => JSON.stringify(['model', id])
const treeKey = (
  group: string,
  bucket: TokenBucket,
  session: string,
  treeOnly: boolean,
  model: string,
) => JSON.stringify([group, bucket, session, treeOnly, model])
const endOf = (record: UsageContributionEvidence, bucket: TokenBucket) =>
  record.coveredThrough?.[bucket] ??
  record.measurement.coveredThroughTurn ??
  record.measurement.scope!.turnIndex

/** Used by the external sort and checked again while consuming its final merge. */
export function compareCompleteUsage(a: UsageContributionEvidence, b: UsageContributionEvidence) {
  const grouped = groupOf(a).localeCompare(groupOf(b))
  if (grouped) return grouped
  const x = a.measurement.scope,
    y = b.measurement.scope
  if (!x || !y)
    return (
      Number(Boolean(x)) - Number(Boolean(y)) ||
      a.measurement.recordId.localeCompare(b.measurement.recordId)
    )
  return (
    rank[x.level] - rank[y.level] ||
    (depthOf(a) < depthOf(b) ? -1 : depthOf(a) > depthOf(b) ? 1 : 0) ||
    x.turnIndex - y.turnIndex ||
    a.measurement.recordId.localeCompare(b.measurement.recordId)
  )
}

/** Exact four-bucket selection using persistent prefix maxima; never an all-summary scan. */
export async function selectCompleteUsage<T extends UsageContributionEvidence>(
  workspace: CompleteUsageWorkspace<T>,
  signal?: AbortSignal,
  issue?: (
    record: T,
    quality: {
      readonly ambiguous: boolean
      readonly unavailable: boolean
      readonly allocated: boolean
    },
  ) => Promise<void>,
) {
  for await (const record of workspace.records()) {
    signal?.throwIfAborted()
    const scope = record.measurement.scope
    if (!scope) continue
    if (scope.level !== 'request') await workspace.markSummary?.(groupOf(record))
    if (isNativeUsageScope(scope)) {
      if (!workspace.nativePath || !workspace.bindNativeAncestry)
        throw new Error('Original native ancestry source is not installed')
      let seen = 0n
      for await (const link of workspace.nativePath(record)) {
        await workspace.bindNativeAncestry(groupOf(record), link)
        seen++
      }
      if (seen !== depthOf(record) + 1n)
        throw new Error('Original native ancestry did not reach root EOF')
      continue
    }
    const path = [...scope.ancestors, scope.session]
    if (new Set(path).size !== path.length) throw new Error('Cyclic observation session ancestry')
    if (path[0] !== scope.root || (scope.ancestors.at(-1) ?? null) !== scope.parentSession)
      throw new Error('Incomplete observation session ancestry')
    for (let i = 0; i < path.length; i++)
      await workspace.bindAncestry(groupOf(record), path[i]!, path.slice(0, i))
  }
  const totals = { input: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n }
  const unknown = { input: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n }
  let selected = 0n,
    excluded = 0n,
    ambiguousOverlaps = 0n,
    unavailableSummaries = 0n
  let allSelectedComplete = true
  let previous: T | undefined
  for await (const record of workspace.orderedRecords()) {
    signal?.throwIfAborted()
    if (previous && compareCompleteUsage(previous, record) > 0)
      throw new Error('Complete usage merge order invalid')
    previous = record
    const scope = record.measurement.scope,
      group = groupOf(record),
      model = record.measurement.model
    const allocation: Record<TokenBucket, string | null> = {
      input: '0',
      cacheRead: '0',
      cacheWrite: '0',
      output: '0',
    }
    let allocated = false,
      ambiguous = false,
      unavailable = false
    const summaries = scope && workspace.hasSummaries ? await workspace.hasSummaries(group) : true
    for (const bucket of TOKEN_BUCKETS) {
      const value = record.contribution[bucket]
      if (scope && summaries) {
        const coverModels = [
          'null',
          ...(model === null ? [] : [modelPartition(model.id, model.provider)]),
        ]
        const overlapModels =
          model === null
            ? ['all']
            : [
                'null',
                model.provider === null
                  ? modelAnyProvider(model.id)
                  : modelPartition(model.id, model.provider),
                ...(model.provider === null ? [] : [modelPartition(model.id, null)]),
              ]
        const end = endOf(record, bucket)
        let covered = false,
          overlapping = false
        for await (const session of sessionsOf(workspace, record)) {
          for (const partition of coverModels) {
            const maximum = await coveragePrefixMaximum(
              workspace.coverage,
              treeKey(group, bucket, session.id, session.treeOnly, partition),
              Math.min(scope.turnIndex, end),
            )
            if (maximum !== null && maximum >= Math.max(scope.turnIndex, end)) covered = true
          }
          if (!covered)
            for (const partition of overlapModels) {
              const maximum = await coveragePrefixMaximum(
                workspace.coverage,
                treeKey(group, bucket, session.id, session.treeOnly, partition),
                end,
              )
              if (maximum !== null && maximum >= scope.turnIndex) overlapping = true
            }
        }
        if (covered) continue
        if (overlapping) {
          ambiguous = true
          continue
        }
        const summary = scope.level !== 'request'
        if (value === null && summary) unavailable = true
        if (value !== null && summary) {
          const partitions =
            model === null
              ? ['all', 'null']
              : ['all', modelAnyProvider(model.id), modelPartition(model.id, model.provider)]
          for (const treeOnly of scope.level === 'tree-total' ? [false, true] : [false])
            for (const partition of partitions)
              await insertCoverageInterval(
                workspace.coverage,
                treeKey(group, bucket, scope.session, treeOnly, partition),
                { start: scope.turnIndex, end },
              )
        }
      }
      const count = tokenCount(value)
      allocation[bucket] = count
      allocated = true
      if (count === null) unknown[bucket]++
      else totals[bucket] += BigInt(count)
    }
    if (ambiguous) ambiguousOverlaps++
    if (unavailable) unavailableSummaries++
    if (ambiguous || unavailable) await issue?.(record, { ambiguous, unavailable, allocated })
    if (allocated) {
      selected++
      allSelectedComplete &&= record.complete
      await workspace.allocate(record, allocation satisfies TokenUsage, { ambiguous, unavailable })
    } else excluded++
  }
  return {
    selected: selected.toString(),
    excluded: excluded.toString(),
    ambiguousOverlaps: ambiguousOverlaps.toString(),
    unavailableSummaries: unavailableSummaries.toString(),
    tokens: Object.fromEntries(TOKEN_BUCKETS.map((bucket) => [bucket, totals[bucket].toString()])),
    unknownBuckets: Object.fromEntries(
      TOKEN_BUCKETS.map((bucket) => [bucket, unknown[bucket].toString()]),
    ),
    allSelectedComplete:
      selected > 0n &&
      allSelectedComplete &&
      ambiguousOverlaps === 0n &&
      unavailableSummaries === 0n &&
      TOKEN_BUCKETS.every((bucket) => unknown[bucket] === 0n),
  }
}
