import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { legacyLocationToContentRef } from '@/platform/persistence/migration/conversion/content'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { canonicalValue } from '@/platform/persistence/migration/conversion/migrationKey'
import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { JsonValue, SourceRow } from '@/platform/persistence/migration/conversion/types'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { RunDecision } from './checkpoints'
import { text } from './source'

export function emitRunEvidence(
  row: SourceRow,
  task: TaskFacts,
  decisions: readonly RunDecision[],
  detail: JsonValue,
  ctx: RuleContext,
  unusedByExecution = false,
): void {
  const unknown = decisions.filter((decision) => decision.unprovable)
  const missingFields = [...new Set(unknown.flatMap((decision) => decision.missingFields))]
  const copied = new Set([
    'prompt_text',
    'prompt_path',
    'runtime_params_json',
    'inventory_snapshot_json',
    'runtime_inventory_json',
    'injected_memories_json',
    'startup_verification_json',
    'port_validation_failures_json',
    'commit_push_json',
    'wrapper_progress_json',
    'lineage_slot_path_json',
  ])
  if (row.values.prompt_text !== null) copied.delete('prompt_path')
  for (const column of copied) if (row.values[column] === null) copied.delete(column)
  const references = Object.fromEntries(
    [...copied].map((column) => [
      column,
      {
        table: [
          'prompt_text',
          'prompt_path',
          'runtime_params_json',
          'inventory_snapshot_json',
          'runtime_inventory_json',
          'injected_memories_json',
        ].includes(column)
          ? 'node_run_configs'
          : ['startup_verification_json', 'wrapper_progress_json'].includes(column)
            ? 'node_run_runtime_states'
            : column === 'lineage_slot_path_json'
              ? 'node_runs'
              : 'node_run_results',
        runId: text(row, 'id'),
        column: column.startsWith('prompt_') ? 'prompt_ref_json' : column,
      },
    ]),
  )
  const bytes = Buffer.from(
    canonicalSchemaJson({
      format: 'node-run-evidence@2',
      sourceRef: { table: row.table, key: row.encodedKey, phase: row.phase },
      sourceValues: Object.fromEntries(
        Object.entries(row.values)
          .filter(([column]) => !copied.has(column))
          .map(([column, value]) => [column, canonicalValue(value)]),
      ),
      sourceReferences: references,
      codecTakeovers: row.codecTakeovers ?? [],
      detail: { decisions: decisions.map((decision) => ({ ...decision })), facts: detail },
    }),
  )
  const content = encodeContentRefColumns(
    legacyLocationToContentRef({
      kind: 'inline',
      location: { codec: 'execution-legacy-evidence@1', value: row.encodedKey },
      bytes,
      metadata: { mediaType: 'application/json' },
    }),
  )
  ctx.out.row(
    'execution_legacy_evidence',
    {
      task_id: task.taskId,
      record_kind: 'node-run',
      record_id: text(row, 'id'),
      source_contract: ctx.preflight.contract?.digest ?? ctx.preflight.fingerprint.digest,
      provenance_quality: unknown.length ? 'unknown' : 'legacy-derived',
      missing_fields_json: canonicalSchemaJson(missingFields),
      content_ref_json: content.json,
      content_inline_bytes: content.inlineBytes,
    },
    row,
  )
  const codecColumns = row.codecTakeovers?.map((failure) => failure.column) ?? []
  if (!unknown.length && codecColumns.length)
    ctx.out.exception({
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      class: 'converted',
      kind: 'conflict-resolved',
      targets: [{ table: 'node_runs', key: row.encodedKey }],
      archive: null,
      codecColumns,
      decision: {
        code: 'v2-run-codec-takeover',
        detail: {
          decisions: decisions.map((decision) => ({ ...decision })),
          inputs:
            'malformed consumed JSON is unrecorded and fresh; checkpoint empty submodules retains the legacy empty string',
        },
      },
    })
  if (!unknown.length) return
  const unusedNonce =
    unusedByExecution && unknown.every((decision) => decision.code === 'v2-run-null-nonce')
  if (task.execution === 'executable' && !unusedNonce) {
    for (const decision of unknown)
      ctx.out.block(
        rowBlock(
          decision.code,
          row,
          {
            ...(decision.detail &&
            typeof decision.detail === 'object' &&
            !Array.isArray(decision.detail)
              ? decision.detail
              : { facts: decision.detail }),
            executableTask: { taskId: task.taskId, status: task.status },
          },
          decision.missingFields,
        ),
      )
  } else
    ctx.out.exception({
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      class: 'converted',
      kind: 'history-only',
      targets: [{ table: 'node_runs', key: row.encodedKey }],
      archive: null,
      ...(codecColumns.length ? { codecColumns } : {}),
      history: {
        taskId: task.taskId,
        runId: text(row, 'id'),
        ...(task.execution === 'executable'
          ? {
              execution: task.execution,
              executionUse: 'none' as const,
              reason: 'null-envelope-nonce-unselected' as const,
            }
          : { execution: task.execution }),
        missingFields,
      },
      decision: {
        code: 'v2-run-history-only',
        detail: { codes: unknown.map((decision) => decision.code), resumeRetry: 'refused' },
      },
    })
}
