import type { TaskActorRole } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

export interface ReviewTaskRelationship {
  readonly taskVisible: boolean
  readonly taskActorRole: TaskActorRole | null
  readonly resourceAclBypass: boolean
}

export interface ReviewTaskAccessPort {
  canManageReviewers(actor: Actor, taskOwnerUserId: string | null): boolean
  resolveRelationship(
    actor: Actor,
    taskId: string,
    taskOwnerUserId: string | null,
  ): Promise<ReviewTaskRelationship>
  visibleTaskIds(actor: Actor, taskIds: readonly string[]): Promise<ReadonlySet<string>>
}
