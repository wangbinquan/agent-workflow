import { runAutoRepairOnce, type AutoRepairDeps } from '@/services/autoRepair'
import type {
  TaskLifecycleAutoRepairCommand,
  TaskLifecycleAutoRepairPolicy,
} from '../application/ports/taskLifecycleAutoRepairCommand'

/** The automatic loop uses the selected provider's existing repair engine. */
export type TaskLifecycleAutoRepairBinding = Pick<AutoRepairDeps, 'resolveOptions' | 'applyOption'>

export function createTaskLifecycleAutoRepairCommand(
  input: TaskLifecycleAutoRepairBinding & Pick<AutoRepairDeps, 'operations' | 'now'>,
): TaskLifecycleAutoRepairCommand {
  return Object.freeze({
    async run(policy: TaskLifecycleAutoRepairPolicy) {
      const enabledRules = new Set(policy.enabledRules)
      return await runAutoRepairOnce({
        ...input,
        breaker: { maxPerWindow: policy.maxPerWindow, windowMs: policy.windowMs },
        isRuleEnabled: (rule) => enabledRules.has(rule),
      })
    },
  })
}
