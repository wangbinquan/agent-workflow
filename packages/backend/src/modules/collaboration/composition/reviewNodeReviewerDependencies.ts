import type { Actor } from '@/auth/actor'
import { hasResourceAclBypass, resolveTaskRole } from '@/services/resourceAcl'
import { canViewTask, hasActingMembership } from '@/services/taskCollab'
import { visibleTaskIdsOf } from '@/services/taskAuthorization'
import type { ReviewNodeReviewerDependencies } from '../application/reviewNodeReviewers'
import type { ReviewTaskAccessPort } from '../application/ports/reviewTaskAccess'
import { SqliteReviewNodeReviewerStore } from '../infrastructure/sqliteReviewNodeReviewerStore'
import {
  requireCollaborationTaskExecutionReadModels,
  resolveCollaborationCommandContext,
} from './commandContext'
import type { CollaborationCommandContext } from '../public/types'

function createReviewTaskAccessPort(context: CollaborationCommandContext): ReviewTaskAccessPort {
  const { db } = resolveCollaborationCommandContext(context)
  return {
    canManageReviewers(actor, taskOwnerUserId) {
      return hasResourceAclBypass(actor) || taskOwnerUserId === actor.user.id
    },
    async resolveRelationship(actor, taskId, taskOwnerUserId) {
      const [taskVisible, actingMember] = await Promise.all([
        canViewTask(db, actor, { id: taskId, ownerUserId: taskOwnerUserId }),
        hasActingMembership(db, taskId, actor.user.id),
      ])
      return {
        taskVisible,
        taskActorRole: resolveTaskRole(actor, taskOwnerUserId, actingMember),
        resourceAclBypass: hasResourceAclBypass(actor),
      }
    },
    async visibleTaskIds(actor: Actor, taskIds: readonly string[]) {
      if (actor.permissions.has('tasks:read:all')) return new Set(taskIds)
      return visibleTaskIdsOf(db, actor, taskIds)
    },
  }
}

export function reviewNodeReviewerDependencies(
  context: CollaborationCommandContext,
): ReviewNodeReviewerDependencies {
  const { db } = resolveCollaborationCommandContext(context)
  return {
    reviewerStore: new SqliteReviewNodeReviewerStore(db),
    taskAccess: createReviewTaskAccessPort(context),
    taskExecutionReadModels: requireCollaborationTaskExecutionReadModels(context),
  }
}
