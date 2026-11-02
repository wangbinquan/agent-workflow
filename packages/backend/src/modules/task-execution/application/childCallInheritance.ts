// RFC-420 — what a call-workflow / call-workgroup child inherits from its parent task: the delegated owner actor
// (RFC-285 B3 / RFC-347) and the inheritable runtime (RFC-284 T20 / RFC-331). Moved verbatim from the call node's
// binding (`composition/childCallNodeExecution.ts`); the binding passes the identity-access delegated factory and the
// parent's execution state.
import type { Permission, TriggerContext } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DelegatedRequestAuthorityFactory } from '@/modules/identity-access/public/participants'
import {
  pickInheritableRunConfig,
  type TaskDriveRuntimeOptions,
} from './ports/taskExecutionTopology'

/** D6/Q5 compatibility: a historical NULL owner is deliberately not the
 * literal system account and therefore carries no permissions. */
const OWNERLESS_SYSTEM_USER_ID = '__system__'
const OWNERLESS_LEGACY_ACTOR: Actor = Object.freeze({
  user: Object.freeze({
    id: OWNERLESS_SYSTEM_USER_ID,
    username: OWNERLESS_SYSTEM_USER_ID,
    displayName: OWNERLESS_SYSTEM_USER_ID,
    role: 'user',
    status: 'active',
  }),
  source: 'daemon',
  permissions: new Set<Permission>(),
  authorityRevision: 0,
})

/** The actor a new child task launches as; null when the parent's owner is no longer admitted. */
export async function delegatedCallActor(
  delegated: DelegatedRequestAuthorityFactory,
  input: {
    readonly kind: 'call-workflow' | 'call-workgroup'
    readonly ownerUserId: string | null
    readonly parentTaskId: string
    readonly parentNodeRunId: string
  },
): Promise<Actor | null> {
  if (input.ownerUserId === null) return OWNERLESS_LEGACY_ACTOR
  const admission = await delegated.forCall({
    kind: input.kind,
    ownerUserId: input.ownerUserId,
    parentTaskId: input.parentTaskId,
    parentNodeRunId: input.parentNodeRunId,
  })
  return admission?.actor ?? null
}

/** The parent facts a child runtime is built from. */
export interface ChildRuntimeParent {
  readonly triggerContext: TriggerContext | null
  readonly task: { readonly ownerUserId?: string | null }
  readonly opts: TaskDriveRuntimeOptions
}

/** RFC-284 T20 / RFC-331 — the one child runtime: both launch arms and the child resume use it. */
export function buildChildRuntime(parent: ChildRuntimeParent) {
  return {
    ...(parent.triggerContext === null ? {} : { triggerContext: parent.triggerContext }),
    actorUserId: parent.task.ownerUserId ?? undefined,
    runConfig: pickInheritableRunConfig(parent.opts),
  }
}
