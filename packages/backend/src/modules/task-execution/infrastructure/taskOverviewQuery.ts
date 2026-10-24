// RFC-359 W4-B1 —— 任务总览计数：一份实现，两个 provider 共用（此前 sqlite / postgresql 两份逐字相同）。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import { and, count, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm'

import type { OverviewTasks } from '@agent-workflow/shared'
import { taskVisibilityCondition } from './taskAuthorization'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { TaskOverviewQuery } from '../public/queries'

function createCountTemplates(db: PersistenceDb, canReadAll: boolean) {
  // RFC-359 W57：判据走 `taskAuthorization.ts` 的唯一一份。这里的请求者 id 是**预编译占位符**
  // （模板只编译一次，每次调用换绑定值），共享片段的 subject 因此接受 `Placeholder`——
  // 不放宽那一处，首页计数就只能自己再抄一份判据，而它正是「概览与列表同口径」那条
  // oracle（RFC-190）守的东西。
  const visibility = taskVisibilityCondition(db, {
    userId: sql.placeholder('overviewUserId'),
    canReadAllTasks: canReadAll,
  })
  const countWhere = (status: SQL<unknown>) => {
    const { tasks } = tablesOf(db)
    const query = db
      .select({ value: count() })
      .from(tasks)
      .where(
        and(visibility, isNull(tasks.parentTaskId), eq(tasks.catalogVisibility, 'public'), status),
      )
    const generate = query.getSQL.bind(query)
    let cached: SQL | undefined
    // These private builders belong to this session and never change after construction. Keep only their
    // SQL AST; all() still compiles, binds, prepares and executes every time.
    query.getSQL = () => {
      return (cached ??= generate())
    }
    return query
  }

  const { tasks } = tablesOf(db)
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

export function createTaskOverviewQuery(db: PersistenceDb): TaskOverviewQuery {
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
        const rows = await queryRows(query, { ...parameters, overviewStatus: status })
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
