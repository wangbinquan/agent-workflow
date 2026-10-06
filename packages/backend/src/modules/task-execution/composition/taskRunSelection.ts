import type { NodeRunPromptOperations } from '../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../application/ports/portArtifactContent'
import type { TaskDriveRequest } from '../application/ports/taskExecutionTopology'
import type {
  BoundTaskRunFamilies,
  TaskRunConfigurationReference,
  TaskRunFamilyBinding,
  TaskRunOwnerDependencies,
  TaskRunSelection,
} from '../application/ports/taskRunSelection'
import type { TaskAgentRunFamily } from '../application/ports/taskAgentRunFamily'
import type { TaskScriptRunFamily } from '../application/ports/taskScriptRunFamily'

/** Only this compatibility bridge accepts the public standalone drive vocabulary. */
export interface TaskRunRootSelection {
  readonly runs: TaskRunSelection
  configurationFor(request: TaskDriveRequest): TaskRunConfigurationReference
}

export interface TaskRunDriveBinding {
  bind(
    request: TaskDriveRequest,
    owners: TaskRunOwnerDependencies,
  ): BoundTaskRunFamilies | Promise<BoundTaskRunFamilies>
}

export interface TaskRunRootBinding {
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly drive: TaskRunDriveBinding
}

/** A sync native binding keeps its original call timing; selected async bindings await ACK. */
export function taskRunBindingPending<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function'
}

function requireTaskRunRootSelection(selected: TaskRunRootSelection): void {
  const runs = selected?.runs
  if (
    selected === null ||
    typeof selected !== 'object' ||
    typeof selected.configurationFor !== 'function' ||
    runs === null ||
    typeof runs !== 'object' ||
    runs.contentNamespace?.kind !== 'task-run-content-namespace' ||
    runs.contentNamespace.reference === null ||
    typeof runs.contentNamespace.reference !== 'object' ||
    typeof runs.nodeRunPrompts?.read !== 'function' ||
    typeof runs.nodeRunPrompts.store !== 'function' ||
    typeof runs.portArtifacts?.read !== 'function' ||
    typeof runs.portArtifacts.archive !== 'function' ||
    typeof runs.taskAgentRunsFor !== 'function' ||
    typeof runs.taskScriptRunsFor !== 'function'
  ) {
    throw new TypeError('Task run selection requires complete content and execution families')
  }
}

/** The local bridge can retain legacy per-drive content factory timing. */
export function bindTaskRunRootSelection(
  selected: TaskRunRootSelection,
  contentsFor?: (
    request: TaskDriveRequest,
  ) => Pick<BoundTaskRunFamilies, 'nodeRunPrompts' | 'portArtifacts'>,
): TaskRunRootBinding {
  requireTaskRunRootSelection(selected)
  const runs = selected.runs
  const nodeRunPrompts = runs.nodeRunPrompts
  const portArtifacts = runs.portArtifacts
  const drive = Object.freeze<TaskRunDriveBinding>({
    bind(request, owners) {
      const contents =
        contentsFor === undefined ? { nodeRunPrompts, portArtifacts } : contentsFor(request)
      const configuration = selected.configurationFor(request)
      if (
        configuration?.kind !== 'task-run-configuration' ||
        configuration.reference === null ||
        typeof configuration.reference !== 'object'
      ) {
        throw new TypeError('Task run selection requires its configuration reference')
      }
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

/** An absent whole selection lets bootstrap retain its native content construction timing. */
export function selectTaskRunRootSelection(
  selected?: TaskRunRootSelection,
): TaskRunRootBinding | undefined {
  return selected === undefined ? undefined : bindTaskRunRootSelection(selected)
}
