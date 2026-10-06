import type { UsageContributionEvidence } from './usageSelection'
import type { TokenBucket } from './tokenUsage'

// Original selection key bytes, shared with read-only TEMP prefetch.
export const groupOf = (record: UsageContributionEvidence) =>
  JSON.stringify([
    record.sourceId,
    record.measurement.invocationId,
    record.measurement.scope?.root ?? null,
  ])
export const modelPartition = (id: string, provider: string | null) =>
  JSON.stringify(['model', id, provider])
export const modelAnyProvider = (id: string) => JSON.stringify(['model', id])
export const treeKey = (
  group: string,
  bucket: TokenBucket,
  session: string,
  treeOnly: boolean,
  model: string,
) => JSON.stringify([group, bucket, session, treeOnly, model])
