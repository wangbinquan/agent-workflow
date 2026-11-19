// RFC-510 — task run selection completeness checks: the root selection, each drive configuration and a selected run binding.
import type {
  TaskRunConfigurationReference,
  TaskRunDriveBinding,
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
