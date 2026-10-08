import { and, desc, eq, exists, gte, lt, or, sql } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { taskVisibilityCondition, type ProviderNeutralDatabase } from '@/db/query'
import { taskRepos, tasks } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import type { ObservationTaskPageQuery } from '@agent-workflow/shared'
import type { TaskObservationFactsQuery } from '../public/queries'
import { createTaskObservationFacts } from './taskObservationFacts'
import { systemAgentObservationGroups as systemGroups } from '@/db/observationSystem'
import { createSystemObservationFacts, systemObservationVisibility } from './systemObservationFacts'
import { createCombinedObservationNativeScopes } from './observationNativeSources'

/** Historical observation retains internal and soft-deleted original rows. Ordinary catalogs are unchanged. */
export function createCompleteTaskObservationFacts(
  db: ProviderNeutralDatabase,
  taskId?: string,
): TaskObservationFactsQuery {
  const original = createTaskObservationFacts(db)
  const system = createSystemObservationFacts(db)
  const visible = (actor: Actor) =>
    taskVisibilityCondition(db, {
      userId: actor.user.id,
      canReadAllTasks: actor.permissions.has('tasks:read:all'),
    })
  const fields = {
    id: tasks.id,
    name: tasks.name,
    status: tasks.status,
    errorSummary: tasks.errorSummary,
    parentTaskId: tasks.parentTaskId,
    startedAt: tasks.startedAt,
    finishedAt: tasks.finishedAt,
    runningMs: tasks.runningMs,
    runningSince: tasks.runningSince,
  }
  function population(actor: Actor, query: ObservationTaskPageQuery) {
    const engine = engineOf(db),
      search = query.q === undefined ? null : engine.likeEscape(query.q)
    const seed = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          visible(actor),
          taskId === undefined
            ? and(
                gte(tasks.startedAt, query.from),
                lt(tasks.startedAt, query.to),
                query.status === undefined ? undefined : eq(tasks.status, query.status),
                query.workflow === undefined ? undefined : eq(tasks.workflowId, query.workflow),
                search === null
                  ? undefined
                  : or(
                      engine.likeCaseInsensitive(tasks.name, search.pattern, search.escape),
                      engine.likeCaseInsensitive(tasks.id, search.pattern, search.escape),
                    ),
                query.repository === undefined
                  ? undefined
                  : or(
                      eq(tasks.repoPath, query.repository),
                      eq(tasks.repoUrl, query.repository),
                      exists(
                        db
                          .select({ id: taskRepos.taskId })
                          .from(taskRepos)
                          .where(
                            and(
                              eq(taskRepos.taskId, tasks.id),
                              or(
                                eq(taskRepos.repoPath, query.repository),
                                eq(taskRepos.repoUrl, query.repository),
                              ),
                            ),
                          ),
                      ),
                    ),
              )
            : eq(tasks.id, taskId),
        ),
      )
    // UNION deduplicates a child selected both directly and through any ancestor.
    return sql`WITH RECURSIVE complete_task_population(id) AS (
      ${seed.getSQL()} UNION
      SELECT child.id FROM tasks child JOIN complete_task_population parent ON child.parent_task_id=parent.id
    ) SELECT id FROM complete_task_population`
  }
  return {
    ...original,
    nativeScopes: createCombinedObservationNativeScopes(db),
    async sourceBacklog(ids) {
      const task = await original.sourceBacklog(ids)
      const byId = new Map((await system.backlog(ids)).map((row) => [row.taskId, row]))
      return task.map((row) => byId.get(row.taskId) ?? row)
    },
    async attemptPage(id, page) {
      return (await system.contains(id))
        ? system.attemptPage(id, page)
        : original.attemptPage!(id, page)
    },
    async attempts(id, limit) {
      if (!(await system.contains(id))) return original.attempts(id, limit)
      const result = await system.attemptPage(id, { limit })
      return { items: result.items, truncated: result.nextCursor !== null }
    },
    async list({ actor, query }) {
      if (!actor.permissions.has('tasks:read:all') && !actor.permissions.has('tasks:read:own'))
        return { items: [], positions: [], nextCursor: null }
      const scope = sha256Hex(
        JSON.stringify([
          actor.user.id,
          [...actor.permissions].sort(),
          taskId ?? null,
          query.from,
          query.to,
          query.timezone,
          query.q,
          query.status,
          query.repository,
          query.workflow,
        ]),
      )
      let after: [number, string] | null = null
      if (query.after !== undefined) {
        const cursor: unknown = JSON.parse(query.after)
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 4 ||
          cursor[0] !== 2 ||
          cursor[1] !== scope ||
          !Number.isSafeInteger(cursor[2]) ||
          typeof cursor[3] !== 'string' ||
          !cursor[3]
        )
          throw new RangeError('Complete Task source cursor changed scope')
        after = [cursor[2] as number, cursor[3]]
      }
      const selected = population(actor, query)
      const excluded = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(sql`${tasks.id} IN (${selected})`, sql`NOT (${visible(actor) ?? sql`true`})`))
        .limit(1)
        .get()
      if (excluded) throw new Error('Complete Task tree contains inaccessible original facts')
      const rows = await db
        .select(fields)
        .from(tasks)
        .where(
          and(
            visible(actor),
            sql`${tasks.id} IN (${selected})`,
            after === null
              ? undefined
              : or(
                  lt(tasks.startedAt, after[0]),
                  and(eq(tasks.startedAt, after[0]), lt(tasks.id, after[1])),
                ),
          ),
        )
        .orderBy(desc(tasks.startedAt), desc(tasks.id))
        .limit(query.limit + 1)
        .all()
      const engine = engineOf(db)
      const search = query.q === undefined ? null : engine.likeEscape(query.q)
      const systemScope =
        taskId === undefined
          ? or(
              sql`${systemGroups.parentTaskId} IN (${selected})`,
              query.repository !== undefined || query.workflow !== undefined
                ? sql`false`
                : and(
                    gte(systemGroups.startedAt, query.from),
                    lt(systemGroups.startedAt, query.to),
                    query.status === undefined ? undefined : eq(systemGroups.status, query.status),
                    search === null
                      ? undefined
                      : or(
                          engine.likeCaseInsensitive(
                            systemGroups.name,
                            search.pattern,
                            search.escape,
                          ),
                          engine.likeCaseInsensitive(
                            systemGroups.id,
                            search.pattern,
                            search.escape,
                          ),
                        ),
                  ),
            )
          : or(eq(systemGroups.id, taskId), sql`${systemGroups.parentTaskId} IN (${selected})`)
      const systemRows = await system.rows(
        and(
          systemObservationVisibility(db, actor),
          systemScope,
          after === null
            ? undefined
            : or(
                lt(systemGroups.startedAt, after[0]),
                and(eq(systemGroups.startedAt, after[0]), lt(systemGroups.id, after[1])),
              ),
        ),
        query.limit + 1,
      )
      const combined = [...rows, ...systemRows].sort(
        (a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      const items = combined.slice(0, query.limit),
        last = items.at(-1)
      const cursorOf = (task: { readonly startedAt: number; readonly id: string }) =>
        JSON.stringify([2, scope, task.startedAt, task.id])
      return {
        items,
        positions: items.map((task) => ({ taskId: task.id, cursor: cursorOf(task) })),
        nextCursor: combined.length > query.limit && last ? cursorOf(last) : null,
      }
    },
    async get(actor, id) {
      if (!actor.permissions.has('tasks:read:all') && !actor.permissions.has('tasks:read:own'))
        return null
      const task =
        (await db
          .select(fields)
          .from(tasks)
          .where(and(eq(tasks.id, id), visible(actor)))
          .get()) ?? null
      return task ?? system.get(actor, id)
    },
  }
}
