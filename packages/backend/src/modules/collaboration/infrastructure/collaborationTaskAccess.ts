// RFC-359 W4-B3 —— 协作侧的任务可见性 / 角色解析：一份实现，两个 provider 共用。

import { and, desc, eq } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/actor'
import { clarifyRounds, nodeRuns, taskCollaborators, taskQuestions, tasks } from '@/db/schema'
import { resolveTaskRole } from '@/modules/resource-catalog/application/resourceDefaults'
import {
  type ProviderNeutralDatabase,
  taskVisibilitySubjectOf,
  visibleTaskIdsFor,
} from '@/db/query'
import type {
  CollaborationTaskAccessDecision,
  CollaborationTaskAccessPort,
  CollaborationTaskSnapshot,
} from '../application/ports/collaborationTaskAccess'
import type { ReviewActor } from '../public/types'

function snapshot(row: typeof tasks.$inferSelect): CollaborationTaskSnapshot {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    workflowSnapshot: row.workflowSnapshot,
  }
}

async function resolve(
  db: ProviderNeutralDatabase,
  actor: ReviewActor,
  row: typeof tasks.$inferSelect | undefined,
): Promise<CollaborationTaskAccessDecision> {
  if (row === undefined) return { task: null, visible: false, actorRole: null }
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

export function createCollaborationTaskAccessPort(
  db: ProviderNeutralDatabase,
): CollaborationTaskAccessPort {
  return {
    async resolveTask(actor, taskId) {
      const row = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).get()
      return await resolve(db, actor, row)
    },
    async resolveNodeRunTask(actor, nodeRunId) {
      const run = await db
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
        .get()
      if (run === undefined) {
        return { nodeRunExists: false, taskId: null, task: null, visible: false, actorRole: null }
      }
      const decision = await this.resolveTask(actor, run.taskId)
      return { nodeRunExists: true, taskId: run.taskId, ...decision }
    },
    async resolveClarifyRoundTask(actor, intermediaryNodeRunId) {
      const round = await db
        .select({ taskId: clarifyRounds.taskId })
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, intermediaryNodeRunId))
        .orderBy(desc(clarifyRounds.createdAt))
        .limit(1)
        .get()
      if (round === undefined) {
        const run = await db
          .select({ id: nodeRuns.id })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, intermediaryNodeRunId))
          .limit(1)
          .get()
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
      const row = await db
        .select({ taskId: taskQuestions.taskId })
        .from(taskQuestions)
        .where(eq(taskQuestions.id, entryId))
        .limit(1)
        .get()
      return row?.taskId ?? null
    },
  }
}
