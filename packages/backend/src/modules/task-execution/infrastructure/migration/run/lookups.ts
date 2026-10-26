import { lookupKey, type LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import {
  TASK_FACTS,
  RUN_FRAMES,
  type RunFrame,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import { frozenRunDefinition, type FrozenRunDefinition } from './definitions'
import { planRunSequences, type RunSequencePlan } from './sequence'
import { backfillLegacyFrames } from './frames'
import type { WriterEvidenceIndex } from './writers'
import { integer, nullableText, text } from './source'

export const RUN_DEFINITIONS = lookupKey<FrozenRunDefinition>('task-execution/run-definitions', 2)
export const WRITER_EVIDENCE = lookupKey<WriterEvidenceIndex>(
  'task-execution/run-writer-evidence',
  2,
)
export const RUN_SEQUENCES = lookupKey<RunSequencePlan>('task-execution/run-sequences', 2)

export const runDefinitions: LookupBuilder<FrozenRunDefinition> = {
  key: RUN_DEFINITIONS,
  sources: ['tasks', 'node_runs'],
  dependsOn: [TASK_FACTS],
  build(staged, put, lookups) {
    for (const row of staged.rows('tasks'))
      put(
        text(row, 'id'),
        frozenRunDefinition(
          typeof row.values.workflow_snapshot === 'string' ? row.values.workflow_snapshot : null,
          staged.group('node_runs', 'task_id', text(row, 'id')).filter((run) => !run.codecFailure),
          lookups(TASK_FACTS).get(text(row, 'id')),
        ),
      )
  },
}
export const runSequences: LookupBuilder<RunSequencePlan> = {
  key: RUN_SEQUENCES,
  sources: ['node_runs', 'node_run_seq_allocations'],
  dependsOn: [TASK_FACTS],
  build(staged, put, lookups) {
    const plans = planRunSequences(
      staged.rows('node_runs'),
      staged.rows('node_run_seq_allocations'),
    )
    let highWater = 0
    for (const row of staged.rows('node_run_seq_allocations'))
      if (!row.codecFailure) highWater = Math.max(highWater, integer(row, 'seq'))
    for (const plan of plans.values()) highWater = Math.max(highWater, plan.observedHighWater)
    const count = plans.values().next().value?.allocationCount ?? 0
    for (const [taskId] of lookups(TASK_FACTS).entries())
      put(
        taskId,
        plans.get(taskId) ?? {
          runs: [],
          observedHighWater: highWater,
          allocationCount: count,
          error: null,
        },
      )
  },
}
export const writerEvidence: LookupBuilder<WriterEvidenceIndex> = {
  key: WRITER_EVIDENCE,
  sources: ['workgroup_assignments', 'task_workspace_preparations', 'workgroup_task_state'],
  dependsOn: [TASK_FACTS],
  build(staged, put, lookups) {
    for (const [taskId] of lookups(TASK_FACTS).entries()) {
      const state = staged
        .group('workgroup_task_state', 'task_id', taskId)
        .find((row) => !row.codecFailure)
      put(taskId, {
        assignments: staged
          .group('workgroup_assignments', 'task_id', taskId)
          .filter((row) => !row.codecFailure)
          .map((row) => ({
            id: text(row, 'id'),
            nodeRunId: nullableText(row, 'node_run_id'),
            createdByRunId: nullableText(row, 'created_by_run_id'),
          })),
        preparations: staged
          .group('task_workspace_preparations', 'admitted_task_id', taskId)
          .filter((row) => !row.codecFailure && row.values.lane === 'repository-preparation')
          .map(
            (row) =>
              `task_workspace_preparations:${text(row, 'id')}:admitted_task_id=${taskId}:state=${text(row, 'state')}`,
          ),
        gateStatus: state ? text(state, 'gate_status') : null,
        dwStateJson: state ? nullableText(state, 'dw_state_json') : null,
      })
    }
  },
}
export const runFrames: LookupBuilder<RunFrame> = {
  key: RUN_FRAMES,
  sources: ['node_runs'],
  dependsOn: [RUN_DEFINITIONS, RUN_SEQUENCES],
  build(staged, put, lookups) {
    for (const taskId of staged.groupKeys('node_runs', 'task_id')) {
      const rows = staged.group('node_runs', 'task_id', taskId).filter((row) => !row.codecFailure)
      const definition = lookups(RUN_DEFINITIONS).get(taskId)
      const sequences = lookups(RUN_SEQUENCES).get(taskId)
      const seqById = new Map(sequences?.runs.map((row) => [row.id, row.seq]))
      const plan =
        definition?.readable && sequences?.error === null
          ? backfillLegacyFrames({
              parentOf: new Map(definition.parentOf),
              rows: rows.map((row) => ({
                id: text(row, 'id'),
                nodeId: text(row, 'node_id'),
                seq: seqById.get(text(row, 'id')) ?? null,
                iteration: integer(row, 'iteration'),
                parentNodeRunId: nullableText(row, 'parent_node_run_id'),
                containerRunId: nullableText(row, 'container_run_id'),
                scopePath: text(row, 'scope_path'),
              })),
            })
          : {
              updates: [],
              unresolved: rows
                .filter((row) => row.values.container_run_id === null)
                .map((row) => text(row, 'id')),
            }
      const updates = new Map(plan.updates.map((update) => [update.id, update]))
      const unresolved = new Set(plan.unresolved)
      const frames = new Map<string, RunFrame>()
      for (const row of rows) {
        const id = text(row, 'id')
        const update = updates.get(id)
        frames.set(id, {
          runId: id,
          taskId,
          containerRunId: update?.containerRunId ?? nullableText(row, 'container_run_id'),
          scopePath: update?.scopePath ?? text(row, 'scope_path'),
          iteration: integer(row, 'iteration'),
          quality: unresolved.has(id) ? 'unresolved' : update ? 'legacy-derived' : 'recorded',
        })
      }
      for (const [id, frame] of frames) {
        const seen = new Set([id])
        let current = frame
        while (current.containerRunId !== null) {
          const parent = frames.get(current.containerRunId)
          if (
            !parent ||
            seen.has(parent.runId) ||
            (frame.quality !== 'recorded' && parent.quality === 'unresolved')
          ) {
            unresolved.add(id)
            break
          }
          seen.add(parent.runId)
          current = parent
        }
        put(id, { ...frame, quality: unresolved.has(id) ? 'unresolved' : frame.quality })
      }
    }
  },
}

export const RUN_ALLOCATION_SUMMARY = lookupKey<
  Pick<RunSequencePlan, 'observedHighWater' | 'allocationCount'>
>('task-execution/run-allocation-summary', 1)
export const runAllocationSummary: LookupBuilder<
  Pick<RunSequencePlan, 'observedHighWater' | 'allocationCount'>
> = {
  key: RUN_ALLOCATION_SUMMARY,
  sources: ['node_runs', 'node_run_seq_allocations'],
  dependsOn: [RUN_SEQUENCES],
  build(staged, put, lookups) {
    let observedHighWater = 0
    for (const table of ['node_runs', 'node_run_seq_allocations'])
      for (const row of staged.rows(table))
        if (!row.codecFailure && typeof row.values.seq === 'number')
          observedHighWater = Math.max(observedHighWater, row.values.seq)
    let allocationCount = 0
    for (const [, plan] of lookups(RUN_SEQUENCES).entries())
      allocationCount = Math.max(allocationCount, plan.allocationCount)
    put('global', { observedHighWater, allocationCount })
  },
}
