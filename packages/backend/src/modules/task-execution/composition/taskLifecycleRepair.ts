import {
  applyRepairOption,
  listRepairOptionsForAlert,
  type ApplyRepairOptionArgs,
} from '@/platform/persistence/sqlite/taskLifecycleRepair'
import type { TaskLifecycleAutoRepairBinding } from '../infrastructure/taskLifecycleAutoRepairCommand'

export type {
  TaskLifecycleAutoRepairCommand,
  TaskLifecycleAutoRepairPolicy,
  TaskLifecycleAutoRepairResult,
} from '../application/ports/taskLifecycleAutoRepairCommand'
export { createTaskLifecycleAutoRepairCommand } from '../infrastructure/taskLifecycleAutoRepairCommand'

/** Bind the existing local repair engine; the automatic loop itself is shared. */
export function bindTaskLifecycleRepair(
  input: Omit<ApplyRepairOptionArgs, 'taskId' | 'alertId' | 'optionId' | 'actorUserId'>,
): TaskLifecycleAutoRepairBinding {
  return {
    resolveOptions: async (alert) =>
      (
        await listRepairOptionsForAlert({
          ...input,
          taskId: alert.taskId,
          alertId: alert.id,
          actorUserId: null,
        })
      ).options.slice(),
    applyOption: async (alert, optionId) => {
      const result = await applyRepairOption({
        ...input,
        taskId: alert.taskId,
        alertId: alert.id,
        actorUserId: null,
        optionId,
      })
      return { outcome: result.outcome }
    },
  }
}
