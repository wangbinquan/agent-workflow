import type { Plugin } from '@agent-workflow/shared'
import type { FrozenTaskExecutionResourceSnapshot } from '../../public/types'

export type TaskAgentInjectionSnapshot = Extract<
  FrozenTaskExecutionResourceSnapshot,
  { readonly kind: 'agent-injection' }
>

/**
 * RFC-563: the content reference Resource Catalog issues for one skill or plugin, declared with this module's own
 * shape. Only this owner interprets it; the material compiler carries it as one of its content references.
 */
export interface TaskAgentResourceContentReference {
  readonly owner: 'resource-catalog'
  readonly reference: string
  readonly version: string | number | null
}

export interface TaskAgentSkillMaterial {
  readonly name: string
  readonly sourceKind: 'managed' | 'project'
  readonly skillId?: string
  readonly contentVersion?: number
  readonly content: TaskAgentResourceContentReference
}

export interface TaskAgentPluginMaterial {
  readonly declaration: Readonly<Pick<Plugin, 'id' | 'name' | 'options' | 'enabled'>>
  readonly content: TaskAgentResourceContentReference
}

/** Ordered declarations and content references, without native locations or readers. */
export interface TaskAgentResourceMaterial {
  readonly skills: readonly TaskAgentSkillMaterial[]
  readonly plugins: readonly TaskAgentPluginMaterial[]
}

/** Bootstrap selects the content dialect used by the same material compiler. */
export interface TaskAgentMaterialReferences {
  references(snapshot: TaskAgentInjectionSnapshot): TaskAgentResourceMaterial
}
