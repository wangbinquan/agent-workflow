// RFC-510 — task run selection completeness checks: the root selection, each drive configuration and a selected run binding.
import type { TaskDriveRequest } from './ports/taskExecutionTopology'
import type {
  TaskRunConfigurationReference,
  TaskRunDriveBinding,
  TaskRunFamilyBinding,
  TaskRunRootSelection,
} from './ports/taskRunSelection'

export function requireTaskRunRootSelection(selected: TaskRunRootSelection): void {
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

export function requireTaskRunConfiguration(configuration: TaskRunConfigurationReference): void {
  if (
    configuration?.kind !== 'task-run-configuration' ||
    configuration.reference === null ||
    typeof configuration.reference !== 'object'
  ) {
    throw new TypeError('Task run selection requires its configuration reference')
  }
}

export function requireTaskRunDriveBinding(selected: TaskRunDriveBinding): void {
  if (selected === null || typeof selected !== 'object' || typeof selected.bind !== 'function') {
    throw new TypeError('Task provider requires a complete run binding')
  }
}

/**
 * RFC-514 — the standalone configuration references: each drive request is registered under a fresh opaque reference,
 * and a run family binding finds its request again; an unknown reference fails closed.
 */
export function createTaskRunConfigurationReferences(): {
  configurationFor(request: TaskDriveRequest): TaskRunConfigurationReference
  requestFor(binding: TaskRunFamilyBinding): TaskDriveRequest
} {
  const requests = new WeakMap<object, TaskDriveRequest>()
  const requestFor = (binding: TaskRunFamilyBinding): TaskDriveRequest => {
    const request = requests.get(binding.configuration.reference)
    if (request === undefined) throw new Error('local-task-run-configuration-unavailable')
    return request
  }
  return {
    configurationFor(request: TaskDriveRequest): TaskRunConfigurationReference {
      const reference = Object.freeze({})
      requests.set(reference, request)
      return Object.freeze({ kind: 'task-run-configuration', reference })
    },
    requestFor,
  }
}
