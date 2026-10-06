import type { Task } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { appHome } from '@/util/paths'
import {
  triggerChangeNarrative as triggerSelectedNarrative,
  type ChangeNarrativeDeps as SelectedChangeNarrativeDeps,
} from '@/services/changeNarrative'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'

export type NativeChangeNarrativeDeps = Omit<
  SelectedChangeNarrativeDeps,
  'systemAgents' | 'resolveRuntime'
> & {
  resolveRuntime(input: Parameters<SelectedChangeNarrativeDeps['resolveRuntime']>[0]): Promise<
    Omit<Awaited<ReturnType<SelectedChangeNarrativeDeps['resolveRuntime']>>, 'runtimeBinding'> & {
      readonly binaryPath: string | null
    }
  >
  readonly runFn?: (options: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
}

/** Existing native fixtures explicitly project into the complete selected family.
 * Business fields and profile accessors retain their actual receiver and read point. */
export function triggerChangeNarrative(
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
      requireMember(member: Actor, taskId: string) {
        return deps.requireMember(member, taskId)
      },
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
  return triggerSelectedNarrative(selected, task, actor)
}
