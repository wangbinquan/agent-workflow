import type { TaskActorRole } from '@agent-workflow/shared'
import type { ReviewActor } from '../../public/types'

export interface ReviewTaskRelationship {
  readonly taskVisible: boolean
  readonly taskActorRole: TaskActorRole | null
  readonly resourceAclBypass: boolean
}

export interface ReviewTaskAccessPort {
  canManageReviewers(actor: ReviewActor, taskOwnerUserId: string | null): boolean
  resolveRelationship(
    actor: ReviewActor,
    taskId: string,
    taskOwnerUserId: string | null,
  ): Promise<ReviewTaskRelationship>
  visibleTaskIds(actor: ReviewActor, taskIds: readonly string[]): Promise<ReadonlySet<string>>
}
