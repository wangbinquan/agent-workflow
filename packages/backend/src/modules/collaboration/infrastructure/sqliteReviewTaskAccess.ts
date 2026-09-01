import { and, eq, inArray, or } from 'drizzle-orm'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { taskCollaborators, tasks } from '@/db/schema'
import { resolveTaskRole } from '@/modules/resource-catalog/application/resourceDefaults'
import { hasResourceAclBypass } from '@/modules/resource-catalog/domain/resourceAccess'
import type { ReviewTaskAccessPort } from '../application/ports/reviewTaskAccess'
import type { ReviewActor } from '../public/types'

export function createSqliteReviewTaskAccessPort(db: DbClient): ReviewTaskAccessPort {
  return {
    canManageReviewers(actor, taskOwnerUserId) {
      return hasResourceAclBypass(actor) || taskOwnerUserId === actor.user.id
    },
    async resolveRelationship(actor, taskId, taskOwnerUserId) {
      const memberships = await db
        .select({ role: taskCollaborators.role })
        .from(taskCollaborators)
        .where(
          and(eq(taskCollaborators.taskId, taskId), eq(taskCollaborators.userId, actor.user.id)),
        )
      const taskVisible =
        actor.permissions.has('tasks:read:all') ||
        taskOwnerUserId === actor.user.id ||
        (taskOwnerUserId === SYSTEM_USER_ID && actor.user.id === SYSTEM_USER_ID) ||
        memberships.length > 0
      const actingMember = memberships.some(
        (row) => row.role === 'owner' || row.role === 'collaborator',
      )
      return {
        taskVisible,
        taskActorRole: resolveTaskRole(actor, taskOwnerUserId, actingMember),
        resourceAclBypass: hasResourceAclBypass(actor),
      }
    },
    async visibleTaskIds(actor: ReviewActor, taskIds: readonly string[]) {
      if (taskIds.length === 0) return new Set<string>()
      const result = new Set<string>()
      for (let offset = 0; offset < taskIds.length; offset += 500) {
        const chunk = [...new Set(taskIds.slice(offset, offset + 500))]
        const rows = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            actor.permissions.has('tasks:read:all')
              ? inArray(tasks.id, chunk)
              : and(
                  inArray(tasks.id, chunk),
                  or(
                    eq(tasks.ownerUserId, actor.user.id),
                    inArray(
                      tasks.id,
                      db
                        .select({ taskId: taskCollaborators.taskId })
                        .from(taskCollaborators)
                        .where(eq(taskCollaborators.userId, actor.user.id)),
                    ),
                  ),
                ),
          )
        for (const row of rows) result.add(row.id)
      }
      return result
    },
  }
}
