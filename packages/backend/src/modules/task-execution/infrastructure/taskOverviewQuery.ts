// RFC-359 W4-B1 —— 任务总览计数：一份实现，两个 provider 共用（此前 sqlite / postgresql 两份逐字相同）。

import { and, count, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'

import type { OverviewTasks } from '@agent-workflow/shared'
import { currentDatabaseSchemaProvider } from '@/db/providerSchema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, tasks } from '@/db/schema'
import type { TaskOverviewQuery } from '../public/queries'

function createCountTemplates(db: ProviderNeutralDatabase, canReadAll: boolean) {
  const collaboratorTaskIds = db
    .select({ taskId: taskCollaborators.taskId })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.userId, sql.placeholder('overviewUserId')))
  const visibility = canReadAll
    ? undefined
    : or(
        eq(tasks.ownerUserId, sql.placeholder('overviewUserId')),
        inArray(tasks.id, collaboratorTaskIds),
      )
  const countWhere = (status: SQL<unknown>) => {
    const query = db
      .select({ value: count() })
      .from(tasks)
      .where(
        and(visibility, isNull(tasks.parentTaskId), eq(tasks.catalogVisibility, 'public'), status),
      )
    const generate = query.getSQL.bind(query)
    let cached: { context: ReturnType<typeof currentDatabaseSchemaProvider>; sql: SQL } | undefined
    // These private builders never change after construction. Keep only their
    // SQL AST; all() still compiles, binds, prepares and executes every time.
    query.getSQL = () => {
      const context = currentDatabaseSchemaProvider()
      if (cached !== undefined && cached.context === context) return cached.sql
      const generated = generate()
      cached = { context, sql: generated }
      return generated
    }
    return query
  }

  // Retain builders, not native prepared statements: each all() still prepares
  // and executes through the current client instrumentation. Bindings belong to
  // each call, so concurrent terminal counts never share mutable parameter state.
  return Object.freeze({
    single: countWhere(eq(tasks.status, sql.placeholder('overviewStatus'))),
    awaiting: countWhere(inArray(tasks.status, ['awaiting_review', 'awaiting_human'])),
    terminal: countWhere(
      and(
        eq(tasks.status, sql.placeholder('overviewStatus')),
        gte(tasks.finishedAt, sql.placeholder('overviewSince')),
      )!,
    ),
  })
}

type CountTemplates = ReturnType<typeof createCountTemplates>

export function createTaskOverviewQuery(db: ProviderNeutralDatabase): TaskOverviewQuery {
  let all: CountTemplates | undefined
  let filtered: CountTemplates | undefined
  return Object.freeze({
    async load(input: Parameters<TaskOverviewQuery['load']>[0]): Promise<OverviewTasks> {
      const canReadAll = input.actor.permissions.has('tasks:read:all')
      if (!canReadAll && !input.actor.permissions.has('tasks:read:own')) {
        return { running: 0, awaiting: 0, done7d: 0, failed7d: 0 }
      }

      const templates = canReadAll
        ? (all ??= createCountTemplates(db, true))
        : (filtered ??= createCountTemplates(db, false))
      const parameters = { overviewUserId: input.actor.user.id, overviewSince: input.since }
      const countWhere = async (
        query: CountTemplates['single'],
        status?: string,
      ): Promise<number> => {
        const rows = await query.all({ ...parameters, overviewStatus: status })
        return rows[0]?.value ?? 0
      }
      const [running, awaiting, done7d, failed7d] = await Promise.all([
        countWhere(templates.single, 'running'),
        countWhere(templates.awaiting),
        countWhere(templates.terminal, 'done'),
        countWhere(templates.terminal, 'failed'),
      ])
      return { running, awaiting, done7d, failed7d }
    },
  })
}
