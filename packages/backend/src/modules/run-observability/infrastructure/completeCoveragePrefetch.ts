import type { UsageContributionEvidence } from '../domain/usageSelection'
import type { CompleteUsageWorkspace } from '../ports/completeUsageWorkspace'
import { TOKEN_BUCKETS } from '../domain/tokenUsage'
import { isNativeUsageScope } from '../domain/nativeUsageScope'
import { groupOf, modelPartition, modelAnyProvider, treeKey } from '../domain/completeCoverageKeys'

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

/** Enumerate original root reads through the full native path, without a depth or record cutoff. */
export async function* completeCoveragePrefetchTrees<T extends UsageContributionEvidence>(
  records: readonly T[],
  workspace: CompleteUsageWorkspace<T>,
) {
  for (const record of records) {
    const scope = record.measurement.scope
    if (!scope) continue
    const group = groupOf(record),
      model = record.measurement.model
    if (workspace.hasSummaries && !(await workspace.hasSummaries(group))) continue
    const cover = ['null', ...(model === null ? [] : [modelPartition(model.id, model.provider)])]
    const overlap =
      model === null
        ? ['all']
        : [
            'null',
            model.provider === null
              ? modelAnyProvider(model.id)
              : modelPartition(model.id, model.provider),
            ...(model.provider === null ? [] : [modelPartition(model.id, null)]),
          ]
    for (const bucket of TOKEN_BUCKETS) {
      for await (const session of sessionsOf(workspace, record)) {
        for (const partition of cover)
          yield treeKey(group, bucket, session.id, session.treeOnly, partition)
        for (const partition of overlap)
          yield treeKey(group, bucket, session.id, session.treeOnly, partition)
      }
      if (scope.level !== 'request' && record.contribution[bucket] !== null) {
        const partitions =
          model === null
            ? ['all', 'null']
            : ['all', modelAnyProvider(model.id), modelPartition(model.id, model.provider)]
        for (const treeOnly of scope.level === 'tree-total' ? [false, true] : [false])
          for (const partition of partitions)
            yield treeKey(group, bucket, scope.session, treeOnly, partition)
      }
    }
  }
}
