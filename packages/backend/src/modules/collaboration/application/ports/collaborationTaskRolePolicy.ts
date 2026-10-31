import type { Actor } from '@/auth/actor'
import type { TaskActorRole } from '@agent-workflow/shared'

export interface CollaborationTaskRolePolicy {
  resolveTaskRole(actor: Actor, ownerUserId: string | null, isMember: boolean): TaskActorRole | null
  hasResourceAclBypass(actor: Actor): boolean
}
