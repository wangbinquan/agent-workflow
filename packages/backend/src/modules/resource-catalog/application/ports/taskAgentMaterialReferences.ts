import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import type { FrozenTaskExecutionResourceSnapshot } from '../../public/types'

export type TaskAgentInjectionSnapshot = Extract<
  FrozenTaskExecutionResourceSnapshot,
  { readonly kind: 'agent-injection' }
>

/** Ordered declarations and content references, without native locations or readers. */
export interface TaskAgentResourceMaterial {
  readonly skills: NonNullable<AgentMaterialIntent['injection']['skills']>
  readonly plugins: NonNullable<AgentMaterialIntent['injection']['plugins']>
}

/** Bootstrap selects the content dialect used by the same material compiler. */
export interface TaskAgentMaterialReferences {
  references(snapshot: TaskAgentInjectionSnapshot): TaskAgentResourceMaterial
}
