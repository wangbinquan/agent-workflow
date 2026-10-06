import type {
  AgentMaterialIntent,
  TaskAgentRuntimeBindings,
} from '@/modules/runtime-management/public/participants'
import type {
  TaskAgentMaterialReferences,
  TaskAgentResourceMaterial,
} from '@/modules/resource-catalog/public/participants'
import type { TaskAgentRunPurpose } from './taskAgentMaterial'

/** One invocation's owner-issued content, with no native process or resource
 * locator. Working/mount references use the selected Source Control dialect. */
export interface TaskAgentRunScope {
  readonly taskId: string
  readonly nodeRunId: string
  readonly workspaceRef: string
  readonly material: TaskAgentResourceMaterial
  readonly runtimeBinding: AgentMaterialIntent['runtimeBinding']
  taskMountRefs(): readonly string[]
}

/** Bootstrap binds this complete family once per drive, including children.
 * An invocation uses every capability from the same selected family. */
export interface TaskAgentRunFamily {
  readonly runtimeBindings: TaskAgentRuntimeBindings
  readonly materialReferences: TaskAgentMaterialReferences
  open(scope: TaskAgentRunScope): TaskAgentRunPurpose
}
