// RFC-359 W4-B3 —— 协作侧的任务可见性 / 角色解析：一份实现，两个 provider 共用。

import {
  type TaskGateDefinitionContext,
  createTaskGateQueries,
  createNodeRunQueries,
} from '@/modules/task-execution/public/queries'

import { readClarifyHistory } from './clarifyHistoryProjection'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { and, desc, eq } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/actor'
import { resolveTaskRole } from '@/modules/resource-catalog/application/resourceDefaults'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  CollaborationTaskAccessDecision,
  CollaborationTaskAccessPort,
  CollaborationTaskSnapshot,
} from '../application/ports/collaborationTaskAccess'
import type { ReviewActor } from '../public/types'

function snapshot(row: TaskGateDefinitionContext): CollaborationTaskSnapshot {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    workflowSnapshot: row.workflowSnapshot,
  }
}

async function resolve(
  db: PersistenceDb,
  actor: ReviewActor,
  row: TaskGateDefinitionContext | undefined,
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
      const row = await first(createTaskGateQueries(db).listDefinitionContexts([taskId]))
      return await resolve(db, actor, row)
    },
    async resolveNodeRunTask(actor, nodeRunId) {
      const run = (await createNodeRunQueries(db).readFields(nodeRunId, ['taskId'])) ?? undefined
      if (run === undefined) {
        return { nodeRunExists: false, taskId: null, task: null, visible: false, actorRole: null }
      }
      const decision = await this.resolveTask(actor, run.taskId)
      return { nodeRunExists: true, taskId: run.taskId, ...decision }
    },
    async resolveClarifyRoundTask(actor, intermediaryNodeRunId) {
      const { clarifyRounds } = tablesOf(db)
      const liveRound = await first(
        db
          .select({ taskId: clarifyRounds.taskId })
          .from(clarifyRounds)
          .where(eq(clarifyRounds.intermediaryNodeRunId, intermediaryNodeRunId))
          .orderBy(desc(clarifyRounds.createdAt))
          .limit(1),
      )
      const history = (await readClarifyHistory(db, { intermediaryNodeRunId }))
        .filter((row) => row.intermediaryNodeRunId === intermediaryNodeRunId)
        .sort((a, b) => b.createdAt - a.createdAt)
      const round = liveRound ?? history[0]
      if (round === undefined) {
        const run =
          (await createNodeRunQueries(db).readFields(intermediaryNodeRunId, ['id'])) ?? undefined
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
      // RFC-395 II-b：判据 + 分块都走 task-execution 的唯一一份。此前这一段与
      // `reviewTaskAccess.ts` 里的**逐字相同**，且两份各自把分块大小硬写成 500。
      return await createTaskGateQueries(db).visibleTaskIds(
        { userId: actor.user.id, canReadAllTasks: actor.permissions.has('tasks:read:all') },
        taskIds,
      )
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
