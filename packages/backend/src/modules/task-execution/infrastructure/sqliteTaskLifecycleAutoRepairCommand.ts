import type { DbClient } from '@/db/client'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'
import type {
  TaskLifecycleAutoRepairCommand,
  TaskLifecycleAutoRepairPolicy,
} from '../application/ports/taskLifecycleAutoRepairCommand'
import type { LifecycleAlertRow } from '@/services/lifecycleInvariants'
import { runAutoRepairOnce } from '@/services/autoRepair'
import type { StartTaskDeps } from '@/services/task'
import type { OpenLifecycleAlert } from '@/services/taskAlerts'
import {
  applyRepairOption,
  listRepairOptionsForAlert,
} from '@/platform/persistence/sqlite/taskLifecycleRepair'

export function createSqliteTaskLifecycleAutoRepairCommand(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly deps: StartTaskDeps
  readonly operations: TaskRecoveryOperations
  readonly onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  readonly onResolved?: (taskId: string) => void
  readonly now?: () => number
}): TaskLifecycleAutoRepairCommand {
  const resolveOptions = async (alert: OpenLifecycleAlert) =>
    (
      await listRepairOptionsForAlert({
        db: input.db,
        taskId: alert.taskId,
        alertId: alert.id,
        actorUserId: null,
        appHome: input.appHome,
        deps: input.deps,
        ...(input.now === undefined ? {} : { now: input.now }),
      })
    ).options.slice()
  return Object.freeze({
    async run(policy: TaskLifecycleAutoRepairPolicy) {
      const enabledRules = new Set(policy.enabledRules)
      return await runAutoRepairOnce({
        operations: input.operations,
        breaker: { maxPerWindow: policy.maxPerWindow, windowMs: policy.windowMs },
        isRuleEnabled: (rule) => enabledRules.has(rule),
        resolveOptions,
        applyOption: async (alert, optionId) => {
          const result = await applyRepairOption({
            db: input.db,
            taskId: alert.taskId,
            alertId: alert.id,
            actorUserId: null,
            appHome: input.appHome,
            deps: input.deps,
            operations: input.operations,
            optionId,
            ...(input.onAlert === undefined ? {} : { onAlert: input.onAlert }),
            ...(input.onResolved === undefined ? {} : { onResolved: input.onResolved }),
            ...(input.now === undefined ? {} : { now: input.now }),
          })
          return { outcome: result.outcome }
        },
        ...(input.now === undefined ? {} : { now: input.now }),
      })
    },
  })
}
