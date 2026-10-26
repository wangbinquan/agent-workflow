import { nodeRunRowPresence } from '../../../domain/nodeRunRowPresence'
import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import type { RunFrame } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { LegacyNodeRunIdentity } from '../../../domain/runSelection/legacyFacts'
import { encodeCanonicalRunSlot } from '../../../domain/runSelection/slotKey'
import { encodeSyntheticOwner } from '../../../domain/runSelection/syntheticOwner'
import { columns, integer, text } from './source'

const mainColumns = [
  'id',
  'task_id',
  'node_id',
  'iteration',
  'shard_key',
  'wg_round',
  'review_iteration',
  'status',
  'started_at',
  'finished_at',
  'exit_code',
  'error_message',
  'failure_code',
  'envelope_nonce',
  'force_activated',
  'rerun_cause',
  'child_task_id',
  'continuation_slot_key',
  'lineage_slot_path_json',
  'operation_generation',
] as const
const configColumns = [
  'runtime',
  'runtime_binary',
  'runtime_params_json',
  'inventory_snapshot_json',
  'runtime_inventory_json',
  'injected_memories_json',
  'agent_override_name',
  'agent_override_id',
  'shard_value_hash',
] as const
const runtimeColumns = [
  'pid',
  'spawn_binary_path',
  'spawn_launch_nonce',
  'startup_verification_json',
  'wrapper_progress_json',
  'merge_state',
] as const
const resultColumns = [
  'tok_input',
  'tok_output',
  'tok_cache_create',
  'tok_cache_read',
  'tok_total',
  'port_validation_failures_json',
  'commit_push_json',
  'superseded_by_review',
  'rolled_back',
] as const

export function splitNodeRun(input: {
  readonly row: SourceRow
  readonly identity: LegacyNodeRunIdentity
  readonly frame: RunFrame
  readonly seq: number
  readonly inputsRecorded: boolean
  readonly historyOnly: boolean
  readonly containerValid: boolean
  readonly prompt: { readonly json: string | null; readonly inlineBytes: Uint8Array | null }
}): {
  nodeRun: TargetRow
  config: TargetRow | null
  runtimeState: TargetRow | null
  result: TargetRow | null
} {
  const { row, identity, frame, prompt } = input
  const id = text(row, 'id')
  const slot = identity.slot
  const owner =
    slot?.kind === 'synthetic'
      ? slot.owner
      : slot?.kind === 'workgroup-host'
        ? { kind: 'task' as const, id: text(row, 'task_id') }
        : null
  const facts = (names: readonly string[]) =>
    Object.fromEntries(
      names.map((column) => [
        column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        row.values[column],
      ]),
    )
  const presence = nodeRunRowPresence({
    role: identity.role,
    recordMode: input.historyOnly ? 'history-only' : 'executable',
    config: {
      ...facts(configColumns),
      // An unreadable external prompt still proves that a config row existed.
      promptRefJson: prompt.json ?? row.values.prompt_text ?? row.values.prompt_path,
      promptInlineBytes: prompt.inlineBytes,
    },
    runtime: {
      ...facts(runtimeColumns),
      sessionId: row.values.opencode_session_id,
      isolationRootRef: row.values.iso_worktree_path,
    },
    result: facts(resultColumns),
  })
  return {
    nodeRun: {
      ...columns(row, mainColumns),
      historical_parent_id: row.values.parent_node_run_id!,
      container_run_id: input.containerValid ? frame.containerRunId : null,
      scope_path: frame.quality === 'unresolved' ? row.values.scope_path! : frame.scopePath,
      seq: input.seq,
      role: identity.role,
      synthetic_owner: owner === null ? null : encodeSyntheticOwner(owner),
      slot_key: slot === null ? null : encodeCanonicalRunSlot(slot),
      generation_seq: 0,
      attempt_index: integer(row, 'retry_index'),
      inputs_recorded: input.inputsRecorded,
      record_mode: input.historyOnly ? 'history-only' : 'executable',
      provenance_quality: input.historyOnly ? 'unknown' : 'legacy-derived',
    },
    config: presence.config
      ? {
          node_run_id: id,
          ...columns(row, configColumns),
          prompt_ref_json: prompt.json,
          prompt_inline_bytes: prompt.inlineBytes,
        }
      : null,
    runtimeState: presence.runtimeState
      ? {
          node_run_id: id,
          ...columns(row, runtimeColumns),
          session_id: row.values.opencode_session_id!,
          isolation_root_ref: row.values.iso_worktree_path!,
        }
      : null,
    result: presence.result ? { node_run_id: id, ...columns(row, resultColumns) } : null,
  }
}
