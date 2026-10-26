import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import {
  TASK_FACTS,
  TASK_MOUNTS,
  RUN_FRAMES,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type { JsonValue } from '@/platform/persistence/migration/conversion/types'
import { RUN_DEFINITIONS, RUN_SEQUENCES, WRITER_EVIDENCE } from './lookups'
import { extractWriterFacts } from './writers'
import { deriveRunIdentities } from './identity'
import { computeLegacySelections } from './selection'
import { convertConsumedInputs } from './inputs'
import { convertCheckpoints, type RunDecision } from './checkpoints'
import { convertPrompt } from './prompts'
import { splitNodeRun } from './split'
import { legacyGeneration } from './generations'
import { allocationBase, emitRunAllocation } from './allocations'
import { emitRunEvidence } from './evidence'
import { oracleRow, text } from './source'

export const runRule: ConversionRule = {
  ref: { id: 'task-execution/run/epoch1', version: 2 },
  owner: 'task-execution',
  claims: ['node_runs'],
  codecTakeovers: [
    {
      table: 'node_runs',
      columns: [
        'consumed_upstream_runs_json',
        'pre_snapshot_repos_json',
        'iso_base_snapshot_repos_json',
        'iso_node_tree_repos_json',
        'iso_submodules_json',
        'iso_submodules_repos_json',
      ],
    },
  ],
  produces: [
    ...[
      'node_runs',
      'task_execution_generations',
      'node_run_selections',
      'node_run_inputs',
      'node_run_configs',
      'node_run_runtime_states',
      'node_run_results',
      'node_run_repo_checkpoints',
      'node_run_seq_allocations',
    ].map((table) => ({ table })),
    { table: 'execution_legacy_evidence', partition: 'node-run' },
  ],
  lookups: [TASK_FACTS, TASK_MOUNTS, RUN_FRAMES, RUN_DEFINITIONS, RUN_SEQUENCES, WRITER_EVIDENCE],
  unit: {
    kind: 'group',
    driver: TASK_FACTS,
    groupColumn: 'task_id',
    members: [{ table: 'node_runs', column: 'task_id' }],
  },
  async convert(unit, ctx) {
    for (const taskId of unit.groupKeys ?? []) {
      const task = ctx.lookup(TASK_FACTS).require(taskId)
      ctx.out.row('task_execution_generations', legacyGeneration(task), null)
      const rows = (unit.rows.get('node_runs') ?? []).filter((row) => row.values.task_id === taskId)
      const sequence = ctx.lookup(RUN_SEQUENCES).require(taskId)
      let base: number
      try {
        if (sequence.error) throw new Error(sequence.error)
        base = allocationBase(sequence, ctx)
      } catch (error) {
        for (const row of rows)
          ctx.out.block(rowBlock('v2-run-sequence', row, { error: String(error) }, ['seq']))
        if (!rows.length)
          ctx.out.block({
            code: 'v2-run-sequence',
            scope: 'global',
            sourceTable: null,
            sourceKey: null,
            taskId,
            runId: null,
            missingFields: ['seq'],
            detail: { error: String(error) },
          })
        continue
      }
      const byId = new Map(rows.map((row) => [text(row, 'id'), row]))
      const sequenced = new Map(
        sequence.runs.map((run) => [
          run.id,
          {
            ...run,
            seq: run.allocationOrdinal === null ? run.seq : base + run.allocationOrdinal,
          },
        ]),
      )
      const frames = ctx.lookup(RUN_FRAMES)
      const definition = ctx.lookup(RUN_DEFINITIONS).get(taskId) ?? {
        nodes: [],
        parentOf: [],
        fanouts: [],
        readable: false,
        missingFacts: ['tasks.workflow_snapshot'],
      }
      const mounts = ctx.lookup(TASK_MOUNTS).require(taskId)
      const writers = extractWriterFacts(
        task,
        definition,
        rows,
        ctx.lookup(WRITER_EVIDENCE).require(taskId),
      )
      const oracleRows = rows.map((row) =>
        oracleRow(row, sequenced.get(text(row, 'id'))!.seq, frames.require(text(row, 'id'))),
      )
      const identities = new Map(deriveRunIdentities(oracleRows, task, definition, writers))
      const prepared = new Map<
        string,
        {
          decisions: RunDecision[]
          inputs: ReturnType<typeof convertConsumedInputs>
          checkpoints: ReturnType<typeof convertCheckpoints>
          prompt: Awaited<ReturnType<typeof convertPrompt>>
          containerValid: boolean
        }
      >()
      for (const row of rows) {
        const id = text(row, 'id')
        const frame = frames.require(id)
        let identity = identities.get(id)!
        const decisions: RunDecision[] = []
        const uncertain = (code: string, missingFields: readonly string[], detail: JsonValue) =>
          decisions.push({ code, missingFields, detail, unprovable: true })
        if (frame.quality === 'unresolved') {
          uncertain(
            'v2-run-frame-unresolved',
            [
              'container_run_id',
              'scope_path',
              ...(!definition.readable ? ['tasks.workflow_snapshot'] : []),
            ],
            { runId: id, frame: { ...frame } },
          )
          identity = {
            ...identity,
            role: null,
            slot: null,
            family: null,
            syntheticKind: null,
            recordMode: 'history-only',
            provenanceQuality: 'unknown',
          }
          identities.set(id, identity)
        }
        if (identity.recordMode === 'history-only')
          uncertain(
            'v2-run-identity-unprovable',
            [...new Set([...identity.evidence.missingFacts, ...identity.evidence.conflicts])],
            JSON.parse(canonicalSchemaJson(identity.evidence)) as JsonValue,
          )
        const containerValid =
          frame.containerRunId === null ||
          (frame.containerRunId !== id &&
            byId.has(frame.containerRunId) &&
            frame.quality !== 'unresolved')
        if (!containerValid)
          uncertain('v2-run-container-unprovable', ['container_run_id'], {
            containerRunId: frame.containerRunId,
          })
        if (row.values.envelope_nonce === null)
          uncertain('v2-run-null-nonce', ['envelope_nonce'], { runId: id })
        if (writers.conflicts.has(id)) {
          const fact = writers.conflicts.get(id)!
          uncertain('v2-run-writer-user-node-conflict', ['writer.user-node'], {
            nodeId: text(row, 'node_id'),
            writer: fact.writer,
            evidence: fact.evidence,
          })
          ctx.out.record(
            {
              kind: 'decision',
              code: 'v2-run-writer-user-node-conflict',
              payload: {
                taskId,
                runId: id,
                nodeId: text(row, 'node_id'),
                execution: task.execution,
                writer: fact.writer,
                evidence: fact.evidence,
              },
            },
            row,
          )
        }
        for (const failure of row.codecTakeovers ?? [])
          if (
            failure.column !== 'consumed_upstream_runs_json' &&
            typeof row.values[failure.column] !== 'string'
          )
            uncertain('v2-run-checkpoint-malformed', [failure.column], {
              retainedIn: 'execution_legacy_evidence',
              storageClass: failure.raw.storageClass,
            })
        const inputs = convertConsumedInputs(row, byId)
        for (const decision of inputs.decisions)
          decisions.push({
            ...decision,
            missingFields: ['consumed_upstream_runs_json'],
            unprovable: decision.code === 'v2-run-input-producer-missing',
          })
        const checkpoints = convertCheckpoints(row, mounts, task.execution)
        decisions.push(...checkpoints.decisions)
        const prompt = await convertPrompt(row, ctx)
        decisions.push(...prompt.decisions)
        prepared.set(id, { decisions, inputs, checkpoints, prompt, containerValid })
      }
      const selection = await computeLegacySelections({
        task,
        rows: oracleRows,
        identities,
        historyOnly: new Set(
          [...prepared]
            .filter(([, value]) => value.decisions.some((decision) => decision.unprovable))
            .map(([id]) => id),
        ),
      })
      for (const mismatch of selection.mismatches)
        prepared.get(mismatch.runId)?.decisions.push({
          code: mismatch.code,
          missingFields: ['slot_key', 'selected_run_id'],
          detail: { ...mismatch },
          unprovable: true,
        })
      for (const row of rows) {
        const id = text(row, 'id')
        const value = prepared.get(id)!
        const identity = identities.get(id)!
        const run = sequenced.get(id)!
        const frame = frames.require(id)
        const split = splitNodeRun({
          row,
          identity,
          frame,
          seq: run.seq,
          inputsRecorded: value.inputs.recorded,
          historyOnly: value.decisions.some((decision) => decision.unprovable),
          containerValid: value.containerValid,
          prompt: value.prompt,
        })
        ctx.out.row('node_runs', split.nodeRun, row)
        if (split.config) ctx.out.row('node_run_configs', split.config, row)
        if (split.runtimeState) ctx.out.row('node_run_runtime_states', split.runtimeState, row)
        if (split.result) ctx.out.row('node_run_results', split.result, row)
        for (const input of value.inputs.inputs) ctx.out.row('node_run_inputs', input, row)
        for (const checkpoint of value.checkpoints.rows)
          ctx.out.row('node_run_repo_checkpoints', checkpoint, row)
        if (value.checkpoints.rows.length)
          ctx.out.exception({
            sourceTable: row.table,
            sourceKey: row.encodedKey,
            class: 'converted',
            kind: 'merged',
            targets: value.checkpoints.rows.map((checkpoint) => ({
              table: 'node_run_repo_checkpoints',
              key: ctx.target.key('node_run_repo_checkpoints', checkpoint),
            })),
            archive: null,
            decision: {
              code: 'v2-run-checkpoint-mount-mapping',
              detail: {
                runId: id,
                lookup: ctx.lookup(TASK_MOUNTS).version.id,
                repoKeys: value.checkpoints.rows.map((checkpoint) => String(checkpoint.repo_key)),
              },
            },
          })
        if (run.allocationOrdinal !== null)
          emitRunAllocation(row, run.seq, base, task.startedAt, ctx)
        emitRunEvidence(
          row,
          task,
          value.decisions,
          JSON.parse(
            canonicalSchemaJson({
              identity: { ...identity.evidence, source: { runId: id, sourceKey: row.encodedKey } },
              writer: writers.writers.get(id) ?? writers.conflicts.get(id) ?? null,
              frame,
              sequence: { original: row.values.seq, assigned: run.seq, derived: run.derived },
              generation: 'legacy-epoch1',
              definitionMissingFacts: definition.missingFacts,
            }),
          ) as JsonValue,
          ctx,
          !selection.executionUsed.has(id),
        )
      }
      for (const row of selection.selections)
        ctx.out.row('node_run_selections', row, byId.get(String(row.selected_run_id))!)
    }
  },
}
