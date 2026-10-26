// RFC-395 II-b R1: mint and V2 share the same versioned, unambiguous no-shard encoding.
export const NO_PRODUCER_SHARD_SLOT = 'shard-v1:none' as const
/** Concrete shard identities use a separate prefix, including an actual empty-string shard. */
export function producerShardSlot(shardKey: string | null): string {
  return shardKey === null ? NO_PRODUCER_SHARD_SLOT : `shard-v1:key:${JSON.stringify(shardKey)}`
}
