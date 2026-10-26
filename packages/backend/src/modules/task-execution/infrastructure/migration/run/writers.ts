import { parseBatchShardKey, parseMsgShardKey } from '@agent-workflow/shared'
import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { LegacyRunWriterFact } from '../../../domain/runSelection/legacyFacts'
import type { FrozenRunDefinition } from './definitions'
import { nullableText, text, integer } from './source'

export interface WriterEvidenceIndex {
  readonly assignments: readonly {
    readonly id: string
    readonly nodeRunId: string | null
    readonly createdByRunId: string | null
  }[]
  readonly preparations: readonly string[]
  readonly gateStatus: string | null
  readonly dwStateJson: string | null
}
export interface WriterFacts {
  readonly writers: ReadonlyMap<string, LegacyRunWriterFact>
  readonly conflicts: ReadonlyMap<string, LegacyRunWriterFact>
}

/** Candidate evidence includes the actual ledger keys; spelling/cause alone never suffices. */
export function extractWriterFacts(
  task: TaskFacts,
  definition: FrozenRunDefinition,
  rows: readonly SourceRow[],
  evidence: WriterEvidenceIndex,
): WriterFacts {
  const writers = new Map<string, LegacyRunWriterFact>()
  const conflicts = new Map<string, LegacyRunWriterFact>()
  if (!definition.readable || task.subjectKind === 'unknown') return { writers, conflicts }
  const byId = new Map(rows.map((row) => [text(row, 'id'), row]))
  for (const row of rows) {
    const runId = text(row, 'id')
    const nodeId = text(row, 'node_id')
    const parentId = nullableText(row, 'parent_node_run_id')
    const parent = parentId === null ? undefined : byId.get(parentId)
    const top = parentId === null && nullableText(row, 'container_run_id') === null
    const cause = nullableText(row, 'rerun_cause')
    const refs: string[] = [
      `node_runs:${runId}:node_id=${nodeId}`,
      `TASK_FACTS:${task.taskId}:${task.subjectKind}:${task.engineKind}`,
    ]
    let writer: LegacyRunWriterFact['writer'] | undefined
    const node = definition.nodes.find((node) => node.id === nodeId)
    if (nodeId === '__repo_prep__' && top && (evidence.preparations.length || node === undefined)) {
      writer = 'repository-preparation'
      refs.push(
        'node_runs:parent=NULL,container=NULL',
        ...evidence.preparations,
        ...(evidence.preparations.length
          ? []
          : ['tasks.workflow_snapshot:no-repo-prep-node; pre-journal-compatible']),
      )
    } else if (
      (nodeId === '__commit_push__' || nodeId.startsWith('__commit_push__:')) &&
      nullableText(row, 'commit_push_json') !== null &&
      (top || parent !== undefined) &&
      !(
        parent &&
        nullableText(parent, 'commit_push_json') !== null &&
        (text(parent, 'node_id') === '__commit_push__' ||
          text(parent, 'node_id').startsWith('__commit_push__:'))
      )
    ) {
      writer = 'commit-push'
      refs.push(
        `node_runs:${runId}:commit_push_json`,
        `node_runs:${runId}:parent=${parentId ?? 'NULL'}`,
      )
    } else if (
      parent &&
      nodeId === `__merge_resolve__:${text(parent, 'node_id')}:${integer(row, 'iteration')}` &&
      (['conflict-human', 'merge-failed', 'pending-merge'].includes(
        nullableText(parent, 'merge_state') ?? '',
      ) ||
        (nullableText(parent, 'iso_worktree_path') !== null &&
          nullableText(parent, 'iso_base_snapshot') !== null))
    ) {
      writer = 'merge-resolution'
      refs.push(
        `node_runs:${parentId}:merge_state=${nullableText(parent, 'merge_state')}`,
        `node_runs:${parentId}:iso_worktree_path,iso_base_snapshot`,
      )
    } else if (
      nodeId === '__dw_orchestrator__' &&
      top &&
      task.subjectKind === 'workgroup' &&
      (task.engineKind === 'dw-generate' || task.engineKind === 'dag') &&
      evidence.dwStateJson !== null
    ) {
      writer = 'dynamic-workflow'
      refs.push(
        `workgroup_task_state:${task.taskId}:dw_state_json`,
        'node_runs:parent=NULL,container=NULL',
      )
    } else if (
      ['__wg_leader__', '__wg_member__'].includes(nodeId) &&
      top &&
      task.subjectKind === 'workgroup' &&
      task.engineKind === 'workgroup-turns'
    ) {
      const assignments = evidence.assignments.filter(
        (entry) => entry.nodeRunId === runId || entry.createdByRunId === runId,
      )
      const shard = nullableText(row, 'shard_key')
      const batch = parseBatchShardKey(shard)
      const message = shard === null ? null : parseMsgShardKey(shard)
      const knownBatch =
        batch &&
        batch.assignmentIds.every((id) =>
          evidence.assignments.some((entry) => entry.id === id && entry.nodeRunId === runId),
        )
      const gate =
        cause === 'wg-gate' &&
        shard === null &&
        evidence.gateStatus !== null &&
        evidence.gateStatus !== 'idle'
      if (
        (definition.platformHost === 'workgroup-turns' && evidence.gateStatus !== null) ||
        assignments.length ||
        knownBatch ||
        (message && evidence.gateStatus !== null) ||
        gate
      ) {
        writer = 'workgroup-turn'
        refs.push(
          ...assignments.map(
            (entry) =>
              `workgroup_assignments:${entry.id}:${entry.nodeRunId === runId ? 'node_run_id' : 'created_by_run_id'}`,
          ),
        )
        if (knownBatch) refs.push(`shard-key:batch:${shard}`)
        if (message) refs.push(`shard-key:msg:${shard}`, `workgroup_task_state:${task.taskId}`)
        if (gate)
          refs.push(`workgroup_task_state:${task.taskId}:gate_status=${evidence.gateStatus}`)
        refs.push('node_runs:parent=NULL,container=NULL')
        if (definition.platformHost === 'workgroup-turns')
          refs.push(`tasks.workflow_snapshot:platform-host`, `workgroup_task_state:${task.taskId}`)
      }
    }
    if (!writer) continue
    const platformNode =
      (writer === 'workgroup-turn' && definition.platformHost === 'workgroup-turns') ||
      (writer === 'dynamic-workflow' && definition.platformHost === 'dw-generate')
    const fact: LegacyRunWriterFact = {
      taskId: task.taskId,
      runId,
      writer,
      evidence: [
        ...refs,
        `tasks.workflow_snapshot:${node ? (platformNode ? 'platform-node' : 'same-named-node') : 'no-node'}:${nodeId}`,
      ],
    }
    if (node && !platformNode) conflicts.set(runId, fact)
    else writers.set(runId, fact)
  }
  return { writers, conflicts }
}
