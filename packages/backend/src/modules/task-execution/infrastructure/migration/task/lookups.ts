import {
  columnLookup,
  lookupKey,
  idSetLookup,
  type LookupBuilder,
} from '@/platform/persistence/migration/conversion/lookups'
import {
  TASK_FACTS,
  TASK_MOUNTS,
  executionClass,
  type TaskFacts,
  type TaskMountFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import { deterministicChildId } from '@/platform/persistence/migration/conversion/ids'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { deriveTaskSubjectFacts } from './subject'
import { taskRowUsable, unusableTaskSourceValue } from './usability'
import { assignTaskRepositoryMounts } from './workspace'
import { text, nullableText, number } from './values'

export const USER_IDS = idSetLookup('users', 'id').key
export const WORKFLOW_BUILTIN = columnLookup('workflows', ['id'], ['builtin']).key

/**
 * RFC-626: a state row whose `dw_state_json` the frozen codec rejected says nothing about the
 * phase. Invalid JSON text already read as no state; a value that is not text used to throw here.
 */
function readableState(state: SourceRow | undefined): SourceRow | undefined {
  return state?.codecFailure?.columns.includes('dw_state_json') ? undefined : state
}

export const taskFactsLookup: LookupBuilder<TaskFacts> = {
  key: TASK_FACTS,
  sources: ['tasks', 'workgroup_task_state'],
  dependsOn: [WORKFLOW_BUILTIN],
  build(staged, put, lookups) {
    for (const task of staged.rows('tasks')) {
      const taskId = text(task, 'id')
      // RFC-626: a task row that cannot be decoded or used has no facts. Its unit is blocked
      // before the rule runs (source codec or `v2-task-row-unusable`), so nothing requires them.
      if (!taskRowUsable(task)) continue
      const subject = deriveTaskSubjectFacts(
        task,
        lookups(WORKFLOW_BUILTIN).get(text(task, 'workflow_id'))?.builtin === true,
        readableState(staged.group('workgroup_task_state', 'task_id', taskId)[0]),
      )
      put(taskId, {
        taskId,
        parentTaskId: nullableText(task, 'parent_task_id'),
        rootTaskId: nullableText(task, 'root_task_id'),
        status: text(task, 'status'),
        startedAt: number(task, 'started_at'),
        // D4 classification is constructed once and consumed everywhere else.
        execution: executionClass(text(task, 'status')),
        subjectKind: subject.mismatch ? 'unknown' : subject.subject.kind,
        sourceId: subject.subject.sourceId,
        definitionAnchorId: subject.definitionAnchorId,
        engineKind: subject.engineKind,
        spaceKind: text(task, 'space_kind'),
        workflowVersion:
          task.values.workflow_version === null ? null : number(task, 'workflow_version'),
      })
    }
  },
}

export const TASK_ISOLATION = lookupKey<readonly string[]>('task-execution/task-isolation', 1)

export const taskMountsLookup: LookupBuilder<TaskMountFacts> = {
  key: TASK_MOUNTS,
  sources: ['tasks', 'task_repos'],
  dependsOn: [TASK_FACTS, TASK_ISOLATION],
  build(staged, put, lookups) {
    for (const task of staged.rows('tasks')) {
      const taskId = text(task, 'id')
      const repos = staged.group('task_repos', 'task_id', taskId)
      const facts = lookups(TASK_FACTS).get(taskId)
      // A task without facts (RFC-626) or with a member row nobody can read is blocked whole.
      if (
        !facts ||
        task.codecFailure ||
        repos.some((repo) => repo.codecFailure || unusableTaskSourceValue(repo))
      ) {
        put(taskId, { taskId, layout: 'none', mounts: [] })
        continue
      }
      const assigned = assignTaskRepositoryMounts(
        task,
        repos,
        facts,
        { child: deterministicChildId },
        lookups(TASK_ISOLATION).get(taskId),
      )
      put(taskId, {
        taskId,
        layout: assigned.layout,
        mounts: assigned.mounts.map((row) => ({
          ordinal: row.ordinal as number,
          repoKey: row.repo_key as string,
          mountPath: row.mount_path as string,
          worktreeDirName: (repos.find((repo) => repo.values.repo_index === row.ordinal)?.values
            .worktree_dir_name ?? row.mount_path) as string,
        })),
      })
    }
  },
}

export const taskIsolationLookup: LookupBuilder<readonly string[]> = {
  key: TASK_ISOLATION,
  sources: ['node_runs'],
  build(staged, put) {
    for (const taskId of staged.groupKeys('node_runs', 'task_id'))
      put(
        taskId,
        staged
          .group('node_runs', 'task_id', taskId)
          .filter((row) => ['isolating', 'pending-merge'].includes(String(row.values.merge_state)))
          .map((row) => text(row, 'id')),
      )
  },
}
