import type { NodeRunPromptOperations } from '../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../application/ports/portArtifactContent'
import type { TaskAgentRunFamily } from '../application/ports/taskAgentRunFamily'
import type { TaskScriptRunFamily } from '../application/ports/taskScriptRunFamily'
import type { TaskDriveRequest } from '../application/ports/taskExecutionTopology'
import type {
  TaskRunContentNamespace,
  TaskRunFamilyBinding,
} from '../application/ports/taskRunSelection'
import type { TaskRunDriveBinding, TaskRunRootSelection } from './taskRunSelection'
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

/** The native family factories the local configuration bridge adapts (the standalone selection's, or a case's own). */
export interface LocalTaskRunFamilyFactories {
  readonly taskAgentRunsFor: (binding: LocalTaskAgentRunFamilyBinding) => TaskAgentRunFamily
  readonly taskScriptRunsFor: (request: TaskDriveRequest) => TaskScriptRunFamily
}

/** RFC-613: the provider runtime always receives its drive binding — bootstrap gives its selection's; cases that replace
 * the families per drive build one with `tests/helpers/legacyTaskRunDriveBinding.ts`. */
export interface ProviderTaskRunBindingSelection {
  readonly taskRunBinding: TaskRunDriveBinding
}

/** Adapts a selected-family binding to the native factories: configuration references and the binding's content receivers. */
export function createLocalTaskRunConfigurationBridge(input: LocalTaskRunFamilyFactories) {
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
  const bridge = createLocalTaskRunConfigurationBridge({
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

/** RFC-613: the drive binding is required, so there is nothing to select here; the given binding is checked once. */
export function bindProviderTaskRunParticipantsInput<Input extends object>(
  input: Input & ProviderTaskRunBindingSelection,
): Input & ProviderTaskRunBindingSelection {
  requireTaskRunDriveBinding(input.taskRunBinding)
  return input
}
