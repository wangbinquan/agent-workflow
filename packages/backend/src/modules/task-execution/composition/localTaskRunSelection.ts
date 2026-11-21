import type { NodeRunPromptOperations } from '../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../application/ports/portArtifactContent'
import type { TaskAgentRunFamily } from '../application/ports/taskAgentRunFamily'
import type { TaskScriptRunFamily } from '../application/ports/taskScriptRunFamily'
import type { TaskDriveRequest } from '../application/ports/taskExecutionTopology'
import type {
  TaskRunContentNamespace,
  TaskRunFamilyBinding,
} from '../application/ports/taskRunSelection'
import {
  bindTaskRunRootSelection,
  type TaskRunDriveBinding,
  type TaskRunRootSelection,
} from './taskRunSelection'
import {
  composeLocalTaskAgentRunFamilyFor,
  type LocalTaskAgentRunFamilyBinding,
  type LocalTaskAgentRunProviders,
} from './localTaskAgentRunFamily'
import { composeLocalTaskScriptRunFamily } from './localTaskScriptRunFamily'
import {
  createTaskRunConfigurationReferences,
  requireTaskRunDriveBinding,
} from '../application/taskRunSelection'

/** Legacy direct compositions retain their complete native factory vocabulary here. */
export interface LegacyTaskRunComposition {
  readonly nodeRunPromptsFor: (appHome: string) => NodeRunPromptOperations
  readonly portArtifactsFor: (appHome: string) => PortArtifactOperations
  readonly taskAgentRunsFor: (binding: LocalTaskAgentRunFamilyBinding) => TaskAgentRunFamily
  readonly taskScriptRunsFor: (request: TaskDriveRequest) => TaskScriptRunFamily
}

export type ProviderTaskRunBindingSelection =
  | { readonly taskRunBinding: TaskRunDriveBinding }
  | (Pick<
      LegacyTaskRunComposition,
      'taskAgentRunsFor' | 'taskScriptRunsFor' | 'nodeRunPromptsFor' | 'portArtifactsFor'
    > & {
      readonly taskRunBinding?: undefined
    })

function localConfigurationBridge(
  input: Pick<LegacyTaskRunComposition, 'taskAgentRunsFor' | 'taskScriptRunsFor'>,
) {
  const references = createTaskRunConfigurationReferences()
  const contentNamespace: TaskRunContentNamespace = Object.freeze({
    kind: 'task-run-content-namespace',
    reference: Object.freeze({}),
  })
  return {
    contentNamespace,
    configurationFor: references.configurationFor,
    taskAgentRunsFor(binding: TaskRunFamilyBinding): TaskAgentRunFamily {
      return input.taskAgentRunsFor({
        request: references.requestFor(binding),
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
      return input.taskScriptRunsFor(references.requestFor(binding))
    },
  }
}

/**
 * RFC-431: the standalone task-run selection. Root readers and every native drive use the same content
 * receivers; the application binds it exactly as it binds a hosted selection.
 */
export function composeLocalTaskRunSelection(input: {
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  /** RFC-489: the other modules' implementations of the native task agent run family (bootstrap passes them in). */
  readonly taskAgentProviders: LocalTaskAgentRunProviders
}): TaskRunRootSelection {
  const bridge = localConfigurationBridge({
    taskAgentRunsFor: (binding) =>
      composeLocalTaskAgentRunFamilyFor(binding, input.taskAgentProviders),
    taskScriptRunsFor: composeLocalTaskScriptRunFamily,
  })
  return {
    runs: {
      contentNamespace: bridge.contentNamespace,
      nodeRunPrompts: input.nodeRunPrompts,
      portArtifacts: input.portArtifacts,
      taskAgentRunsFor: (binding) => bridge.taskAgentRunsFor(binding),
      taskScriptRunsFor: (binding) => bridge.taskScriptRunsFor(binding),
    },
    configurationFor: (request) => bridge.configurationFor(request),
  }
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
/** RFC-526: the legacy arm (fixtures only) gives its prompt and artifact owners too; nothing is defaulted here. */
export function bindProviderTaskRunParticipantsInput<Input extends object>(
  input: Input & ProviderTaskRunBindingSelection,
): Input & { readonly taskRunBinding: TaskRunDriveBinding } {
  if (input.taskRunBinding !== undefined) {
    const selected = input.taskRunBinding
    requireTaskRunDriveBinding(selected)
    return Object.assign(input, { taskRunBinding: selected })
  }
  const receiver = Object.assign(input, {
    taskAgentRunsFor: input.taskAgentRunsFor,
    taskScriptRunsFor: input.taskScriptRunsFor,
    nodeRunPromptsFor: input.nodeRunPromptsFor,
    portArtifactsFor: input.portArtifactsFor,
  })
  return Object.assign(receiver, { taskRunBinding: composeLegacyTaskRunDriveBinding(receiver) })
}
