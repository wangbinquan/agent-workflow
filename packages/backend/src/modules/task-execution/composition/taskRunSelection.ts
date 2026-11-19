import type {
  BoundTaskRunFamilies,
  TaskRunDriveBinding,
  TaskRunFamilyBinding,
  TaskRunRootBinding,
  TaskRunRootSelection,
} from '../application/ports/taskRunSelection'
import type { TaskAgentRunFamily } from '../application/ports/taskAgentRunFamily'
import type { TaskScriptRunFamily } from '../application/ports/taskScriptRunFamily'
import {
  requireTaskRunConfiguration,
  requireTaskRunRootSelection,
} from '../application/taskRunSelection'
export type {
  TaskRunDriveBinding,
  TaskRunRootBinding,
  TaskRunRootSelection,
} from '../application/ports/taskRunSelection'

/** A sync native binding keeps its original call timing; selected async bindings await ACK. */
export function taskRunBindingPending<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function'
}

/** Every drive binds the selection's own root content receivers (RFC-431: both deployments select one). */
export function bindTaskRunRootSelection(selected: TaskRunRootSelection): TaskRunRootBinding {
  requireTaskRunRootSelection(selected)
  const runs = selected.runs
  const nodeRunPrompts = runs.nodeRunPrompts
  const portArtifacts = runs.portArtifacts
  const drive = Object.freeze<TaskRunDriveBinding>({
    bind(request, owners) {
      const contents = { nodeRunPrompts, portArtifacts }
      const configuration = selected.configurationFor(request)
      requireTaskRunConfiguration(configuration)
      const binding: TaskRunFamilyBinding = {
        ...owners,
        taskId: request.taskId,
        executionContext: request.executionContext,
        signal: request.signal,
        contentNamespace: runs.contentNamespace,
        configuration,
        ...contents,
      }
      const bound = (taskAgentRuns: TaskAgentRunFamily, taskScriptRuns: TaskScriptRunFamily) =>
        Object.freeze<BoundTaskRunFamilies>({ ...contents, taskAgentRuns, taskScriptRuns })
      const bindScript = (taskAgentRuns: TaskAgentRunFamily) => {
        const taskScriptRuns = runs.taskScriptRunsFor(binding)
        return taskRunBindingPending(taskScriptRuns)
          ? taskScriptRuns.then((script) => bound(taskAgentRuns, script))
          : bound(taskAgentRuns, taskScriptRuns)
      }
      const taskAgentRuns = runs.taskAgentRunsFor(binding)
      return taskRunBindingPending(taskAgentRuns)
        ? taskAgentRuns.then(bindScript)
        : bindScript(taskAgentRuns)
    },
  })
  return Object.freeze({ nodeRunPrompts, portArtifacts, drive })
}
