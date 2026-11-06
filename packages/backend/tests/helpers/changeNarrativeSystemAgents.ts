import type { Task } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { appHome } from '@/util/paths'
import {
  triggerChangeNarrative as triggerSelectedNarrative,
  type ChangeNarrativeDeps as SelectedChangeNarrativeDeps,
} from '@/modules/workspace-insight/application/changeNarrative'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'

export type NativeChangeNarrativeDeps = Omit<
  SelectedChangeNarrativeDeps,
  'systemAgents' | 'resolveRuntime'
> & {
  /** RFC-453: the tasks route's member gate, which the route runs right before the trigger. */
  requireMember(actor: Actor, taskId: string): Promise<void>
  resolveRuntime(input: Parameters<SelectedChangeNarrativeDeps['resolveRuntime']>[0]): Promise<
    Omit<Awaited<ReturnType<SelectedChangeNarrativeDeps['resolveRuntime']>>, 'runtimeBinding'> & {
      readonly binaryPath: string | null
    }
  >
  readonly runFn?: (options: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
}

/** Existing native fixtures explicitly project into the complete selected family.
 * Business fields and profile accessors retain their actual receiver and read point.
 * RFC-453: the member gate moved from the trigger's first statement into the tasks route, right before the call;
 * this helper keeps that order (gate, then trigger) so the gate cases still read as the route runs them. */
export async function triggerChangeNarrative(
  deps: NativeChangeNarrativeDeps,
  task: Task,
  actor: Actor,
): ReturnType<typeof triggerSelectedNarrative> {
  const binding = composeLocalSystemAgentRunFamily({ appHome })
  const descriptors: PropertyDescriptorMap = {}
  for (const field of ['workspace', 'runtimeName', 'defaultRuntime', 'now', 'log'] as const) {
    descriptors[field] = { enumerable: true, get: () => deps[field] }
  }
  const selected = Object.defineProperties<object>(
    {
      async resolveRuntime(input: Parameters<SelectedChangeNarrativeDeps['resolveRuntime']>[0]) {
        return binding.bindRuntime(await deps.resolveRuntime(input))
      },
      get systemAgents() {
        const runFn = deps.runFn
        return runFn === undefined ? binding.family : binding.withFixture(runFn).family
      },
    },
    descriptors,
  ) as SelectedChangeNarrativeDeps
  await deps.requireMember(actor, task.id)
  return triggerSelectedNarrative(selected, task)
}
