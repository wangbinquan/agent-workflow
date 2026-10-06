import type { NodeRunPromptOperations } from '../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../application/ports/portArtifactContent'
import type { TaskAgentRunFamily } from '../application/ports/taskAgentRunFamily'
import type { TaskScriptRunFamily } from '../application/ports/taskScriptRunFamily'
import type { TaskDriveRequest } from '../application/ports/taskExecutionTopology'
import type {
  TaskRunConfigurationReference,
  TaskRunContentNamespace,
  TaskRunFamilyBinding,
} from '../application/ports/taskRunSelection'
import {
  bindTaskRunRootSelection,
  type TaskRunDriveBinding,
  type TaskRunRootBinding,
  type TaskRunRootSelection,
} from './taskRunSelection'
import {
  composeLocalTaskAgentRunFamilyFor,
  type LocalTaskAgentRunFamilyBinding,
} from './localTaskAgentRunFamily'
import { composeLocalTaskScriptRunFamily } from './localTaskScriptRunFamily'
import type { WorkspaceExcludeProfileFactory } from '@/modules/source-control/public/participants'
import { selectWorkspaceExcludeProfileFactory } from '@/modules/source-control/public/participants'
import { Paths } from '@/util/paths'

/** The Task bootstrap bridge alone translates the legacy application-home override. */
export function composeTaskWorkspaceExcludeProfilesFor(
  selected?: WorkspaceExcludeProfileFactory,
): (request: Pick<TaskDriveRequest, 'appHome'>) => WorkspaceExcludeProfileFactory {
  if (selected !== undefined) {
    const factory = selectWorkspaceExcludeProfileFactory(selected)
    return () => factory
  }
  return (request) =>
    selectWorkspaceExcludeProfileFactory(undefined, () => request.appHome ?? Paths.root)
}

/** Legacy direct compositions retain their complete native factory vocabulary here. */
export interface LegacyTaskRunComposition {
  readonly nodeRunPromptsFor: (appHome: string) => NodeRunPromptOperations
  readonly portArtifactsFor: (appHome: string) => PortArtifactOperations
  readonly taskAgentRunsFor: (binding: LocalTaskAgentRunFamilyBinding) => TaskAgentRunFamily
  readonly taskScriptRunsFor: (request: TaskDriveRequest) => TaskScriptRunFamily
}

export type ProviderTaskRunBindingSelection =
  | { readonly taskRunBinding: TaskRunDriveBinding }
  | (Pick<LegacyTaskRunComposition, 'taskAgentRunsFor' | 'taskScriptRunsFor'> &
      Partial<Pick<LegacyTaskRunComposition, 'nodeRunPromptsFor' | 'portArtifactsFor'>> & {
        readonly taskRunBinding?: undefined
      })

function localConfigurationBridge(
  input: Pick<LegacyTaskRunComposition, 'taskAgentRunsFor' | 'taskScriptRunsFor'>,
) {
  const requests = new WeakMap<object, TaskDriveRequest>()
  const contentNamespace: TaskRunContentNamespace = Object.freeze({
    kind: 'task-run-content-namespace',
    reference: Object.freeze({}),
  })
  const requestFor = (binding: TaskRunFamilyBinding): TaskDriveRequest => {
    const request = requests.get(binding.configuration.reference)
    if (request === undefined) throw new Error('local-task-run-configuration-unavailable')
    return request
  }
  return {
    contentNamespace,
    configurationFor(request: TaskDriveRequest): TaskRunConfigurationReference {
      const reference = Object.freeze({})
      requests.set(reference, request)
      return Object.freeze({ kind: 'task-run-configuration', reference })
    },
    taskAgentRunsFor(binding: TaskRunFamilyBinding): TaskAgentRunFamily {
      return input.taskAgentRunsFor({
        request: requestFor(binding),
        nodeRunRuntime: binding.nodeRunRuntime,
        runtimeRegistry: binding.runtimeRegistry,
        nodeRunPrompts: binding.nodeRunPrompts,
        portArtifacts: binding.portArtifacts,
        ...(binding.operationConfiguration === undefined
          ? {}
          : { operationConfiguration: binding.operationConfiguration }),
      })
    },
    taskScriptRunsFor(binding: TaskRunFamilyBinding): TaskScriptRunFamily {
      return input.taskScriptRunsFor(requestFor(binding))
    },
  }
}

/** Root readers and every native drive use the same already selected content receivers. */
export function composeLocalTaskRunRootSelection(input: {
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
}): TaskRunRootBinding {
  const local: LegacyTaskRunComposition = {
    nodeRunPromptsFor: () => input.nodeRunPrompts,
    portArtifactsFor: () => input.portArtifacts,
    taskAgentRunsFor: composeLocalTaskAgentRunFamilyFor,
    taskScriptRunsFor: composeLocalTaskScriptRunFamily,
  }
  const bridge = localConfigurationBridge(local)
  const selected: TaskRunRootSelection = {
    runs: {
      contentNamespace: bridge.contentNamespace,
      nodeRunPrompts: input.nodeRunPrompts,
      portArtifacts: input.portArtifacts,
      taskAgentRunsFor: (binding) => bridge.taskAgentRunsFor(binding),
      taskScriptRunsFor: (binding) => bridge.taskScriptRunsFor(binding),
    },
    configurationFor: (request) => bridge.configurationFor(request),
  }
  return bindTaskRunRootSelection(selected, (request) => ({
    nodeRunPrompts: local.nodeRunPromptsFor(request.appHome),
    portArtifacts: local.portArtifactsFor(request.appHome),
  }))
}

/** Direct legacy fixtures still bind prompt→archive→Agent→script at every drive. */
export function composeLegacyTaskRunDriveBinding(
  input: LegacyTaskRunComposition,
): TaskRunDriveBinding {
  const bridge = localConfigurationBridge(input)
  return Object.freeze<TaskRunDriveBinding>({
    bind(request, owners) {
      const nodeRunPrompts = input.nodeRunPromptsFor(request.appHome)
      const portArtifacts = input.portArtifactsFor(request.appHome)
      return bindTaskRunRootSelection({
        runs: {
          contentNamespace: bridge.contentNamespace,
          nodeRunPrompts,
          portArtifacts,
          taskAgentRunsFor: (binding) => bridge.taskAgentRunsFor(binding),
          taskScriptRunsFor: (binding) => bridge.taskScriptRunsFor(binding),
        },
        configurationFor: (drive) => bridge.configurationFor(drive),
      }).drive.bind(request, owners)
    },
  })
}

/** The freshly assembled provider input remains the receiver of all legacy factories. */
export function bindProviderTaskRunParticipantsInput<Input extends object>(
  input: Input & ProviderTaskRunBindingSelection,
  defaults: Pick<LegacyTaskRunComposition, 'nodeRunPromptsFor' | 'portArtifactsFor'>,
): Input & { readonly taskRunBinding: TaskRunDriveBinding } {
  if (input.taskRunBinding !== undefined) {
    const selected = input.taskRunBinding
    if (selected === null || typeof selected !== 'object' || typeof selected.bind !== 'function') {
      throw new TypeError('Task provider requires a complete run binding')
    }
    return Object.assign(input, { taskRunBinding: selected })
  }
  const receiver = Object.assign(input, {
    taskAgentRunsFor: input.taskAgentRunsFor,
    taskScriptRunsFor: input.taskScriptRunsFor,
    nodeRunPromptsFor:
      input.nodeRunPromptsFor === undefined ? defaults.nodeRunPromptsFor : input.nodeRunPromptsFor,
    portArtifactsFor:
      input.portArtifactsFor === undefined ? defaults.portArtifactsFor : input.portArtifactsFor,
  })
  return Object.assign(receiver, { taskRunBinding: composeLegacyTaskRunDriveBinding(receiver) })
}
