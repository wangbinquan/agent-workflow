import type { TaskRunRootSelection } from './taskRunSelection'
import { createHostedAgentParticipants } from '../infrastructure/crewstation/agentInvocationPreparation'
import {
  openHostedTaskAgentRun,
  type HostedTaskRunSelectionInput,
} from '../infrastructure/crewstation/taskAgentRunScope'
import { createHostedTaskMaterialReferences } from '../infrastructure/crewstation/taskMaterialReferences'
import { createHostedTaskScriptRunFamily } from '../infrastructure/crewstation/taskScriptRunFamily'

/** RFC-417: the hosted run scope and material references are the CrewStation adapter; this selection ensures each
 * drive's physical workspace and hands the scope out. */
export function composeCrewStationTaskRunSelection(
  input: HostedTaskRunSelectionInput,
): TaskRunRootSelection {
  const materialReferences = createHostedTaskMaterialReferences()
  const participants = createHostedAgentParticipants()
  return {
    configurationFor: () => ({ kind: 'task-run-configuration', reference: Object.freeze({}) }),
    runs: {
      contentNamespace: { kind: 'task-run-content-namespace', reference: Object.freeze({}) },
      nodeRunPrompts: input.nodeRunPrompts,
      portArtifacts: input.portArtifacts,
      async taskAgentRunsFor(binding) {
        const physical = await input.workspaces.ensure(binding.taskId)
        return {
          runtimeBindings: input.runtimeBindingsFor(binding),
          materialReferences,
          open: (scope) =>
            openHostedTaskAgentRun(input, { binding, physical, participants }, scope),
        }
      },
      taskScriptRunsFor: (binding) =>
        createHostedTaskScriptRunFamily({
          ...input,
          taskId: binding.taskId,
          path: (reference) => input.locate(reference).path,
        }),
    },
  }
}
