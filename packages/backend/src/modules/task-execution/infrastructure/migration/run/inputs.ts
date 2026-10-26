import { scanJsonObjectEntries } from '@/platform/persistence/migration/conversion/orderedJson'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type {
  SourceRow,
  TargetRow,
  JsonValue,
} from '@/platform/persistence/migration/conversion/types'
import { producerShardSlot } from '../../../domain/runInputShard'
import { nullableText, text } from './source'

export interface InputDecision {
  readonly code: string
  readonly detail: JsonValue
}
export function convertConsumedInputs(
  row: SourceRow,
  runsInTask: ReadonlyMap<string, SourceRow>,
): {
  readonly inputs: readonly TargetRow[]
  readonly recorded: boolean
  readonly decisions: readonly InputDecision[]
} {
  if (
    row.codecTakeovers?.some((failure) => failure.column === 'consumed_upstream_runs_json') &&
    typeof row.values.consumed_upstream_runs_json !== 'string'
  )
    return {
      inputs: [],
      recorded: false,
      decisions: [
        {
          code: 'v2-run-inputs-malformed',
          detail: { retainedIn: 'execution_legacy_evidence', treatment: 'unrecorded-fresh' },
        },
      ],
    }
  const raw = nullableText(row, 'consumed_upstream_runs_json')
  if (raw === null) return { inputs: [], recorded: false, decisions: [] }
  let entries: ReturnType<typeof scanJsonObjectEntries>
  try {
    entries = scanJsonObjectEntries(raw)
  } catch {
    return {
      inputs: [],
      recorded: false,
      decisions: [{ code: 'v2-run-inputs-malformed', detail: { raw } }],
    }
  }
  const last = new Map(entries.map((entry) => [entry.key, entry.ordinal]))
  const decisions: InputDecision[] = []
  if (last.size !== entries.length)
    decisions.push({
      code: 'v2-run-inputs-duplicate-key',
      detail: { raw, resolution: 'JSON last occurrence wins' },
    })
  const inputs: TargetRow[] = []
  for (const entry of entries) {
    if (last.get(entry.key) !== entry.ordinal) continue
    if (typeof entry.value !== 'string') {
      decisions.push({
        code: 'v2-run-inputs-non-string',
        detail: { nodeId: entry.key, value: entry.value },
      })
      continue
    }
    const producer = runsInTask.get(entry.value)
    const exists = producer !== undefined && producer.values.task_id === row.values.task_id
    const evidence = exists
      ? null
      : canonicalSchemaJson({
          code: 'v2-run-input-producer-missing',
          producerRunId: entry.value,
          producerNodeId: entry.key,
        })
    if (evidence !== null)
      decisions.push({
        code: 'v2-run-input-producer-missing',
        detail: { producerRunId: entry.value, producerNodeId: entry.key },
      })
    inputs.push({
      task_id: text(row, 'task_id'),
      consumer_run_id: text(row, 'id'),
      ordinal: entry.ordinal,
      producer_run_id: entry.value,
      producer_run_ref: exists ? entry.value : null,
      provenance_quality: 'legacy-derived',
      evidence_ref_json: evidence,
      input_kind: 'frame-input',
      producer_node_id: entry.key,
      producer_shard_slot: producerShardSlot(exists ? nullableText(producer, 'shard_key') : null),
    })
  }
  return { inputs, recorded: true, decisions }
}
