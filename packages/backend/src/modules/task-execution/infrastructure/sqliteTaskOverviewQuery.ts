import { and, count, eq, gte, inArray, isNull, or, type SQL } from 'drizzle-orm'

import type { OverviewTasks } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { taskCollaborators, tasks } from '@/db/schema'
import type { TaskOverviewQuery } from '../public/queries'

async function loadOverview(
  db: DbClient,
  input: Parameters<TaskOverviewQuery['load']>[0],
): Promise<OverviewTasks> {
  const canReadAll = input.actor.permissions.has('tasks:read:all')
  if (!canReadAll && !input.actor.permissions.has('tasks:read:own')) {
    return { running: 0, awaiting: 0, done7d: 0, failed7d: 0 }
  }

  const collaboratorTaskIds = db
    .select({ taskId: taskCollaborators.taskId })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.userId, input.actor.user.id))
  const visibility = canReadAll
    ? undefined
    : or(eq(tasks.ownerUserId, input.actor.user.id), inArray(tasks.id, collaboratorTaskIds))
  const countWhere = async (status: SQL<unknown>): Promise<number> => {
    const rows = await db
      .select({ value: count() })
      .from(tasks)
      .where(
        and(visibility, isNull(tasks.parentTaskId), eq(tasks.catalogVisibility, 'public'), status),
      )
    return rows[0]?.value ?? 0
  }

  const [running, awaiting, done7d, failed7d] = await Promise.all([
    countWhere(eq(tasks.status, 'running')),
    countWhere(inArray(tasks.status, ['awaiting_review', 'awaiting_human'])),
    countWhere(and(eq(tasks.status, 'done'), gte(tasks.finishedAt, input.since))!),
    countWhere(and(eq(tasks.status, 'failed'), gte(tasks.finishedAt, input.since))!),
  ])
  return { running, awaiting, done7d, failed7d }
}

export function createSqliteTaskOverviewQuery(db: DbClient): TaskOverviewQuery {
  return Object.freeze({
    load: async (input: Parameters<TaskOverviewQuery['load']>[0]) => await loadOverview(db, input),
  })
}
