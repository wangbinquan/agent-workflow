import { CANCELABLE_TASK_STATUSES } from '@agent-workflow/shared'
import type { SettlementContribution } from '@/platform/persistence/migration/conversion/rule'
import type { TaskSettlement } from '@/platform/persistence/migration/conversion/types'
import { unusableTaskSourceValue } from '../task/usability'

/**
 * The children a cancel takes along: those still cancelable, as the cancel transaction selects
 * them (`childTaskLifecycleParticipant.ts:905-911`). An `interrupted` child is not among them.
 */
const CASCADED_CHILD_STATUSES: ReadonlySet<string> = new Set<string>(CANCELABLE_TASK_STATUSES)

/**
 * RFC-626 §3.2.3: a settled task ends its cancelable children as a parent cascade, and theirs in
 * turn, level by level. Tasks already settled are left to their own settlement. A child row the
 * converter cannot read or use is set aside whole and is not ended first.
 */
export const cascadeSettlements: NonNullable<SettlementContribution['expand']> = ({
  settled,
  staged,
}) => {
  const known = new Set(settled.keys())
  const parents = [...settled.keys()].sort()
  const added: TaskSettlement[] = []
  for (let index = 0; index < parents.length; index++) {
    const parentTaskId = parents[index]!
    for (const child of staged.group('tasks', 'parent_task_id', parentTaskId)) {
      const taskId = child.values.id
      const status = child.values.status
      if (
        child.codecFailure ||
        unusableTaskSourceValue(child) ||
        typeof taskId !== 'string' ||
        known.has(taskId) ||
        typeof status !== 'string' ||
        !CASCADED_CHILD_STATUSES.has(status)
      )
        continue
      known.add(taskId)
      parents.push(taskId)
      added.push({
        taskId,
        cause: 'parent-cascade',
        originalStatus: status,
        blockCodes: [],
        parentTaskId,
      })
    }
  }
  return added
}
