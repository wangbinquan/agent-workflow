// RFC-359 W4-B3 —— 评审侧的任务关系解析：一份实现，两个 provider 共用（取 SQLite 的单次成员查询形态）。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'
import { SYSTEM_USER_ID } from '@/auth/actor'
import { createTaskGateQueries } from '@/modules/task-execution/public/queries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { resolveTaskRole } from '@/modules/resource-catalog/application/resourceDefaults'
import { hasResourceAclBypass } from '@/modules/resource-catalog/domain/resourceAccess'
import type { ReviewTaskAccessPort } from '../application/ports/reviewTaskAccess'
import type { ReviewActor } from '../public/types'

export function createReviewTaskAccessPort(db: PersistenceDb): ReviewTaskAccessPort {
  return {
    canManageReviewers(actor, taskOwnerUserId) {
      return hasResourceAclBypass(actor) || taskOwnerUserId === actor.user.id
    },
    async resolveRelationship(actor, taskId, taskOwnerUserId) {
      const { taskCollaborators } = tablesOf(db)
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
      // RFC-395 II-b：判据 + 分块都走 task-execution 的唯一一份。此前这一段与
      // `collaborationTaskAccess.ts` 里的**逐字相同**，且两份各自把分块大小硬写成 500。
      return await createTaskGateQueries(db).visibleTaskIds(
        { userId: actor.user.id, canReadAllTasks: actor.permissions.has('tasks:read:all') },
        taskIds,
      )
    },
  }
}
