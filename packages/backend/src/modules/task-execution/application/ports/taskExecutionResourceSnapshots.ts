import type { WorkflowDefinition } from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type {
  FrozenTaskExecutionResourceSnapshot,
  TaskExecutionResourceRequest,
} from '@/modules/resource-catalog/public/types'

/** Exact authority captured when a task launch or execution is admitted. */
export interface TaskExecutionResourceAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
}

export interface TaskExecutionCallClosureRoot {
  readonly id: string
  readonly definition: WorkflowDefinition
}

/**
 * Provider-neutral, async and atomic resource snapshot boundary.
 *
 * The implementation owns transaction scope. In particular, call-closure
 * traversal must observe one provider snapshot even though discovering the
 * graph requires more than one logical lookup.
 */
export interface TaskExecutionResourceBinding {
  loadAuthorized(
    pair: TaskExecutionResourceAuthorityPair,
    requests: readonly TaskExecutionResourceRequest[],
  ): Promise<readonly FrozenTaskExecutionResourceSnapshot[]>

  freezeCallClosure(
    pair: TaskExecutionResourceAuthorityPair,
    root: TaskExecutionCallClosureRoot,
  ): Promise<string | null>
}

export interface TaskExecutionResourceAuthority extends TaskExecutionResourceAuthorityPair {
  readonly resources: TaskExecutionResourceBinding
}
