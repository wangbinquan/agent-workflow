// RFC-359 W4-B3 —— 协作侧的任务可见性 / 角色解析：一份实现，两个 provider 共用。

import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { and, desc, eq } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/actor'
import { resolveTaskRole } from '@/modules/resource-catalog/application/resourceDefaults'
import { taskVisibilitySubjectOf, visibleTaskIdsFor } from '@/db/query'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  CollaborationTaskAccessDecision,
  CollaborationTaskAccessPort,
  CollaborationTaskSnapshot,
} from '../application/ports/collaborationTaskAccess'
import type { ReviewActor } from '../public/types'

function snapshot(row: PersistenceTables['tasks']['$inferSelect']): CollaborationTaskSnapshot {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    workflowSnapshot: row.workflowSnapshot,
  }
}

async function resolve(
  db: PersistenceDb,
  actor: ReviewActor,
  row: PersistenceTables['tasks']['$inferSelect'] | undefined,
): Promise<CollaborationTaskAccessDecision> {
  if (row === undefined) return { task: null, visible: false, actorRole: null }
  const { taskCollaborators } = tablesOf(db)
  const memberships = await db
    .select({ role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(and(eq(taskCollaborators.taskId, row.id), eq(taskCollaborators.userId, actor.user.id)))

  const visible =
    actor.permissions.has('tasks:read:all') ||
    row.ownerUserId === actor.user.id ||
    (row.ownerUserId === SYSTEM_USER_ID && actor.user.id === SYSTEM_USER_ID) ||
    memberships.length > 0
  const actingMember = memberships.some(
    (membership) => membership.role === 'owner' || membership.role === 'collaborator',
  )
  return {
    task: snapshot(row),
    visible,
    actorRole: resolveTaskRole(actor, row.ownerUserId, actingMember),
  }
}

export function createCollaborationTaskAccessPort(db: PersistenceDb): CollaborationTaskAccessPort {
  return {
    async resolveTask(actor, taskId) {
      const { tasks } = tablesOf(db)
      const row = await first(db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))
      return await resolve(db, actor, row)
    },
    async resolveNodeRunTask(actor, nodeRunId) {
      const { nodeRuns } = tablesOf(db)
      const run = await first(
        db
          .select({ taskId: nodeRuns.taskId })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, nodeRunId))
          .limit(1),
      )
      if (run === undefined) {
        return { nodeRunExists: false, taskId: null, task: null, visible: false, actorRole: null }
      }
      const decision = await this.resolveTask(actor, run.taskId)
      return { nodeRunExists: true, taskId: run.taskId, ...decision }
    },
    async resolveClarifyRoundTask(actor, intermediaryNodeRunId) {
      const { clarifyRounds, nodeRuns } = tablesOf(db)
      const round = await first(
        db
          .select({ taskId: clarifyRounds.taskId })
          .from(clarifyRounds)
          .where(eq(clarifyRounds.intermediaryNodeRunId, intermediaryNodeRunId))
          .orderBy(desc(clarifyRounds.createdAt))
          .limit(1),
      )
      if (round === undefined) {
        const run = await first(
          db
            .select({ id: nodeRuns.id })
            .from(nodeRuns)
            .where(eq(nodeRuns.id, intermediaryNodeRunId))
            .limit(1),
        )
        return {
          roundExists: false,
          nodeRunExists: run !== undefined,
          taskId: null,
          task: null,
          visible: false,
          actorRole: null,
        }
      }
      const decision = await this.resolveTask(actor, round.taskId)
      return { roundExists: true, nodeRunExists: true, taskId: round.taskId, ...decision }
    },
    async visibleTaskIds(actor, taskIds) {
      // RFC-359 W57：判据 + 分块都走 `db/query.ts` 的唯一一份。此前这一段与
      // `reviewTaskAccess.ts` 里的**逐字相同**，且两份各自把分块大小硬写成 500。
      return await visibleTaskIdsFor(db, taskVisibilitySubjectOf(actor), taskIds)
    },
    async questionTaskId(entryId) {
      const { taskQuestions } = tablesOf(db)
      const row = await first(
        db
          .select({ taskId: taskQuestions.taskId })
          .from(taskQuestions)
          .where(eq(taskQuestions.id, entryId))
          .limit(1),
      )
      return row?.taskId ?? null
    },
  }
}
