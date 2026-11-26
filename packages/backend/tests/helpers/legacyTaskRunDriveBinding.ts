// RFC-613 — the legacy direct drive binding, for cases only. Production always gives the provider runtime its drive binding
// (bootstrap binds the standalone or hosted task-run selection once); cases that replace the families or the content owners
// per drive build this binding instead. Every drive binds prompt → archive → Agent → script from the case's factories,
// through the same configuration bridge the standalone selection uses (`createLocalTaskRunConfigurationBridge`).
import type { NodeRunPromptOperations } from '@/modules/task-execution/application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '@/modules/task-execution/application/ports/portArtifactContent'
import {
  createLocalTaskRunConfigurationBridge,
  type LocalTaskRunFamilyFactories,
} from '@/modules/task-execution/composition/localTaskRunSelection'
import {
  bindTaskRunRootSelection,
  type TaskRunDriveBinding,
} from '@/modules/task-execution/composition/taskRunSelection'

/** A case's complete native factory vocabulary: the two families and the per-drive content owners. */
export interface LegacyTaskRunComposition extends LocalTaskRunFamilyFactories {
  readonly nodeRunPromptsFor: (appHome: string) => NodeRunPromptOperations
  readonly portArtifactsFor: (appHome: string) => PortArtifactOperations
}

export function composeLegacyTaskRunDriveBinding(
  input: LegacyTaskRunComposition,
): TaskRunDriveBinding {
  const bridge = createLocalTaskRunConfigurationBridge(input)
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
