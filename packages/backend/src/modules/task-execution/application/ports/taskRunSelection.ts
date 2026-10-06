import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import type { NodeRunRuntimePersistence } from './nodeRunRuntimePersistence'
import type { NodeRunPromptOperations } from './nodeRunPromptContent'
import type { PortArtifactOperations } from './portArtifactContent'
import type { TaskAgentRunFamily } from './taskAgentRunFamily'
import type { TaskOperationConfigurationQueries } from './taskOperationConfiguration'
import type { TaskScriptRunFamily } from './taskScriptRunFamily'
import type { TaskExecutionContextRef } from './taskExecutionTopology'

/** The selected implementation owns both reference dialects and their lifetime. */
export interface TaskRunContentNamespace {
  readonly kind: 'task-run-content-namespace'
  readonly reference: object
}

export interface TaskRunConfigurationReference {
  readonly kind: 'task-run-configuration'
  readonly reference: object
}

export interface TaskRunOwnerDependencies {
  readonly nodeRunRuntime: NodeRunRuntimePersistence
  readonly runtimeRegistry: RuntimeExecutionQueries
  readonly operationConfiguration?: TaskOperationConfigurationQueries
}

/** One effective drive's logical inputs. Native configuration stays in its bridge. */
export interface TaskRunFamilyBinding extends TaskRunOwnerDependencies {
  readonly taskId: string
  readonly executionContext: TaskExecutionContextRef
  readonly signal: AbortSignal
  readonly contentNamespace: TaskRunContentNamespace
  readonly configuration: TaskRunConfigurationReference
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
}

export interface BoundTaskRunFamilies {
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly taskAgentRuns: TaskAgentRunFamily
  readonly taskScriptRuns: TaskScriptRunFamily
}

/** A whole selection shares root content readers and binds fresh families per drive. */
export interface TaskRunSelection {
  readonly contentNamespace: TaskRunContentNamespace
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  taskAgentRunsFor(binding: TaskRunFamilyBinding): TaskAgentRunFamily | Promise<TaskAgentRunFamily>
  taskScriptRunsFor(
    binding: TaskRunFamilyBinding,
  ): TaskScriptRunFamily | Promise<TaskScriptRunFamily>
}
