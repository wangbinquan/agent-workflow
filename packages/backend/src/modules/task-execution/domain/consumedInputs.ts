// RFC-395 II-a A3：epoch-1 的 source-node 粒度消费字节；读取与写入共用。
export interface ConsumedEdge {
  readonly producerNodeId: string
  readonly producerRunId: string
}

/**
 * Parse `node_runs.consumed_upstream_runs_json` into a `{ upstreamNodeId:
 * nodeRunId }` map. Degrades to `{}` (an empty map ⇒ always fresh) on null,
 * empty string, malformed JSON, non-object shapes, and non-string values —
 * mirroring the migration's hard-cut "null consumed = fresh" rule (design
 * §9.1 / D4) so a legacy or corrupt row never spuriously demotes.
 */
export function parseConsumedJson(json: string | null | undefined): Record<string, string> {
  if (json === null || json === undefined || json === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export function decodeConsumedEdges(json: string | null | undefined): readonly ConsumedEdge[] {
  return Object.entries(parseConsumedJson(json)).map(([producerNodeId, producerRunId]) => ({
    producerNodeId,
    producerRunId,
  }))
}

export function encodeConsumedEdges(edges: readonly ConsumedEdge[]): string {
  const record: Record<string, string> = Object.create(null)
  for (const edge of edges) {
    if (Object.hasOwn(record, edge.producerNodeId))
      throw new Error(
        'Epoch-1 consumed inputs cannot represent two runs for the same producer node',
      )
    record[edge.producerNodeId] = edge.producerRunId
  }
  return JSON.stringify(record)
}

export function consumedEdgesFromRecord(
  record: Readonly<Record<string, string>>,
): readonly ConsumedEdge[] {
  return Object.entries(record).map(([producerNodeId, producerRunId]) => ({
    producerNodeId,
    producerRunId,
  }))
}

/** Typed producer facts; multiple shards of one producer remain distinct. */
export interface RecordedNodeRunInput extends ConsumedEdge {
  readonly inputKind:
    | 'frame-input'
    | 'wrapper-parameter'
    | 'aggregator-shard'
    | 'review-source'
    | 'gate-open'
  readonly producerShardKey?: string | null
}
