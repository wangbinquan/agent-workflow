import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { LookupResolver } from '@/platform/persistence/migration/conversion/lookups'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import { taskExecutionOf } from './usability'

/** A text cell the frozen codec read as such; a failed column says nothing about its task. */
function readableId(row: SourceRow, column: string): string | null {
  const value = row.values[column]
  return typeof value === 'string' &&
    value.length > 0 &&
    !row.codecFailure?.columns.includes(column)
    ? value
    : null
}

/**
 * RFC-626 §3.2.2: the tasks a row of the task rule can end. A member row belongs to its task.
 * A task row is its own task, and — while it has not finished, or when its status cannot be
 * read — also its parent's: a child that is still running and is set aside whole leaves a
 * parent waiting on a call that no longer exists in the new database, so that parent ends too.
 * A child that had already finished takes nothing with it.
 */
export function taskRuleTasksOf(row: SourceRow): readonly string[] {
  if (row.table !== 'tasks') {
    const taskId = readableId(row, 'task_id')
    return taskId === null ? [] : [taskId]
  }
  const taskId = readableId(row, 'id')
  if (taskId === null) return []
  const parentTaskId = readableId(row, 'parent_task_id')
  const execution = row.codecFailure?.columns.includes('status')
    ? null
    : taskExecutionOf(row.values.status)
  const finished = execution !== null && execution !== 'executable'
  return parentTaskId !== null && parentTaskId !== taskId && !finished
    ? [taskId, parentTaskId]
    : [taskId]
}

/**
 * RFC-626 §3.2.2 step 2: the tasks covering one group of the task rule (`tasksOfGroup`). The
 * group is keyed by the task id; its member rows give that task or none, and its task row gives
 * it and, while unfinished, its parent. The task facts are derived from that very row (`TASK_FACTS`
 * holds a task only when its row is usable, with the status and parent the row carries), so they
 * tell both; a task without facts cannot be told from its key and is read.
 */
export function taskRuleTasksOfGroup(
  groupKey: string,
  lookup: LookupResolver,
): readonly string[] | undefined {
  const facts = lookup(TASK_FACTS).get(groupKey)
  if (!facts) return undefined
  return facts.execution === 'executable' && facts.parentTaskId !== null
    ? [groupKey, facts.parentTaskId]
    : [groupKey]
}
