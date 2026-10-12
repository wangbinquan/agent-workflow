import { and, desc, eq, exists, gte, inArray, lt, or, sql } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { taskVisibilityCondition, type ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, taskRepos, tasks } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import type { ObservationTaskPageQuery } from '@agent-workflow/shared'
import type { CompleteTaskObservationFactsQuery } from '../public/queries'
import { createTaskObservationFacts } from './taskObservationFacts'
import { systemAgentObservationGroups as systemGroups } from '@/db/observationSystem'
import { createSystemObservationFacts, systemObservationVisibility } from './systemObservationFacts'
import { createCombinedObservationNativeScopes } from './observationNativeSources'
import { ORCHESTRATOR_AGENT_ID, ORCHESTRATOR_AGENT_NAME } from '../domain/orchestratorAgentIdentity'

/** Historical observation retains internal and soft-deleted original rows. Ordinary catalogs are unchanged. */
export function createCompleteTaskObservationFacts(
  db: ProviderNeutralDatabase,
  taskId?: string,
): CompleteTaskObservationFactsQuery {
  return completeTaskObservationFacts(db, taskId)
}

/** Internal original-owner reader for the daemon projection. It is not an HTTP
 * identity and does not change any user's visibility. Published projection
 * queries reapply the current original-owner visibility independently. */
export function createProjectionTaskObservationFacts(
  db: ProviderNeutralDatabase,
  ids?: readonly string[],
  attemptIds?: readonly string[],
) {
  const facts = completeTaskObservationFacts(db, undefined, { ids, attemptIds })
  return {
    ...facts,
    async projectionList(query: ObservationTaskPageQuery) {
      if (ids === undefined || ids.length <= 200) return facts.list({ actor: null, query })
      const selected = new Map<
        string,
        {
          task: import('@agent-workflow/shared').ObservationTaskFacts
          position: { taskId: string; cursor: string }
        }
      >()
      let more = false
      for (let at = 0; at < ids.length; at += 200) {
        const page = await completeTaskObservationFacts(db, undefined, {
          ids: ids.slice(at, at + 200),
          scopeIds: ids,
          attemptIds,
        }).list({ actor: null, query })
        more ||= page.nextCursor !== null
        for (let index = 0; index < page.items.length; index++)
          selected.set(page.items[index]!.id, {
            task: page.items[index]!,
            position: page.positions[index]!,
          })
      }
      const ordered = [...selected.values()].sort(
          (a, b) => b.task.startedAt - a.task.startedAt || b.task.id.localeCompare(a.task.id),
        ),
        items = ordered.slice(0, query.limit)
      return {
        items: items.map((row) => row.task),
        positions: items.map((row) => row.position),
        nextCursor:
          (more || ordered.length > query.limit) && items.length
            ? items.at(-1)!.position.cursor
            : null,
      }
    },
    projectionGet: (id: string) => facts.get(null, id),
    async projectionSelectors(ids: readonly string[]) {
      const result = new Map<
        string,
        { workflowId: string | null; repositories: string[]; visibilityKey: string }
      >()
      for (let at = 0; at < ids.length; at += 200) {
        const packet = ids.slice(at, at + 200)
        const members = await db
          .select({
            taskId: taskCollaborators.taskId,
            userId: taskCollaborators.userId,
            role: taskCollaborators.role,
          })
          .from(taskCollaborators)
          .where(inArray(taskCollaborators.taskId, [...packet]))
          .all()
        for (const row of await db
          .select({
            id: tasks.id,
            workflowId: tasks.workflowId,
            repoPath: tasks.repoPath,
            repoUrl: tasks.repoUrl,
            owner: tasks.ownerUserId,
          })
          .from(tasks)
          .where(inArray(tasks.id, [...packet]))
          .all())
          result.set(row.id, {
            workflowId: row.workflowId,
            repositories: [row.repoPath, row.repoUrl].filter(
              (value): value is string => typeof value === 'string',
            ),
            visibilityKey: sha256Hex(
              JSON.stringify([
                row.owner,
                members
                  .filter((member) => member.taskId === row.id)
                  .map((member) => JSON.stringify([member.userId, member.role]))
                  .sort(),
              ]),
            ),
          })
        for (const row of await db
          .select({
            id: systemGroups.id,
            owner: systemGroups.ownerUserId,
            parent: systemGroups.parentTaskId,
          })
          .from(systemGroups)
          .where(inArray(systemGroups.id, [...packet]))
          .all())
          result.set(row.id, {
            workflowId: null,
            repositories: [],
            visibilityKey: sha256Hex(JSON.stringify([row.owner, row.parent])),
          })
        for (const row of await db
          .select({
            id: taskRepos.taskId,
            repoPath: taskRepos.repoPath,
            repoUrl: taskRepos.repoUrl,
          })
          .from(taskRepos)
          .where(inArray(taskRepos.taskId, [...packet]))
          .all()) {
          const value = result.get(row.id)
          if (value)
            value.repositories.push(
              ...[row.repoPath, row.repoUrl].filter(
                (item): item is string => typeof item === 'string',
              ),
            )
        }
      }
      return result
    },
  }
}

function completeTaskObservationFacts(
  db: ProviderNeutralDatabase,
  taskId?: string,
  projection?: {
    readonly ids?: readonly string[]
    readonly scopeIds?: readonly string[]
    readonly attemptIds?: readonly string[]
  },
) {
  const original = createTaskObservationFacts(db, projection?.attemptIds)
  const system = createSystemObservationFacts(db, projection?.attemptIds)
  const visible = (actor: Actor | null) => {
    if (projection) return undefined
    if (!actor) throw new Error('Original Task actor missing')
    return taskVisibilityCondition(db, {
      userId: actor.user.id,
      canReadAllTasks: actor.permissions.has('tasks:read:all'),
    })
  }
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
  function population(actor: Actor | null, query: ObservationTaskPageQuery) {
    const engine = engineOf(db),
      search = query.q === undefined ? null : engine.likeEscape(query.q)
    const seed = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          visible(actor),
          projection
            ? projection.ids === undefined
              ? undefined
              : projection.ids.length
                ? inArray(tasks.id, [...projection.ids])
                : sql`false`
            : taskId === undefined
              ? and(
                  query.cohort === 'usage' ? undefined : gte(tasks.startedAt, query.from),
                  query.cohort === 'usage' ? undefined : lt(tasks.startedAt, query.to),
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
    if (projection) return sql`${seed.getSQL()}`
    return sql`WITH RECURSIVE complete_task_population(id) AS (
      ${seed.getSQL()} UNION
      SELECT child.id FROM tasks child JOIN complete_task_population parent ON child.parent_task_id=parent.id
    ) SELECT id FROM complete_task_population`
  }
  return {
    ...original,
    originalAgentName: (id: string) =>
      id === ORCHESTRATOR_AGENT_ID
        ? Promise.resolve(ORCHESTRATOR_AGENT_NAME)
        : system.originalAgentName(id),
    async visibleIds(actor: Actor, sourceIds: readonly string[]) {
      if (
        !sourceIds.length ||
        (!actor.permissions.has('tasks:read:all') && !actor.permissions.has('tasks:read:own'))
      )
        return []
      const taskRows = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(inArray(tasks.id, [...sourceIds]), visible(actor)))
        .all()
      const systemRows = await db
        .select({ id: systemGroups.id })
        .from(systemGroups)
        .where(
          and(inArray(systemGroups.id, [...sourceIds]), systemObservationVisibility(db, actor)),
        )
        .all()
      return [...new Set([...taskRows, ...systemRows].map((row) => row.id))]
    },
    nativeScopes: createCombinedObservationNativeScopes(db),
    async sourceBacklog(ids: readonly string[]) {
      const task = await original.sourceBacklog(ids)
      const byId = new Map((await system.backlog(ids)).map((row) => [row.taskId, row]))
      return task.map((row) => byId.get(row.taskId) ?? row)
    },
    async attemptPage(id: string, page: { readonly limit: number; readonly after?: string }) {
      return (await system.contains(id))
        ? system.attemptPage(id, page)
        : original.attemptPage!(id, page)
    },
    async attempts(id: string, limit: number) {
      if (!(await system.contains(id))) return original.attempts(id, limit)
      const result = await system.attemptPage(id, { limit })
      return { items: result.items, truncated: result.nextCursor !== null }
    },
    async list({
      actor,
      query,
    }: {
      readonly actor: Actor | null
      readonly query: ObservationTaskPageQuery
    }) {
      if (
        !projection &&
        (!actor ||
          (!actor.permissions.has('tasks:read:all') && !actor.permissions.has('tasks:read:own')))
      )
        return { items: [], positions: [], nextCursor: null }
      const scope = sha256Hex(
        JSON.stringify([
          actor?.user.id ?? 'original-daemon-projection',
          actor ? [...actor.permissions].sort() : (projection?.scopeIds ?? projection?.ids ?? null),
          taskId ?? null,
          query.from,
          query.to,
          query.timezone,
          query.q,
          query.status,
          query.repository,
          query.workflow,
          ...(query.cohort === undefined ? [] : [query.cohort]),
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
      const excluded = projection
        ? undefined
        : await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(sql`${tasks.id} IN (${selected})`, sql`NOT (${visible(actor) ?? sql`true`})`),
            )
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
      const systemScope = projection
        ? projection.ids === undefined
          ? undefined
          : projection.ids.length
            ? inArray(systemGroups.id, [...projection.ids])
            : sql`false`
        : taskId === undefined
          ? or(
              sql`${systemGroups.parentTaskId} IN (${selected})`,
              query.repository !== undefined || query.workflow !== undefined
                ? sql`false`
                : and(
                    query.cohort === 'usage' ? undefined : gte(systemGroups.startedAt, query.from),
                    query.cohort === 'usage' ? undefined : lt(systemGroups.startedAt, query.to),
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
          projection ? undefined : systemObservationVisibility(db, actor!),
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
    async get(actor: Actor | null, id: string) {
      if (
        !projection &&
        (!actor ||
          (!actor.permissions.has('tasks:read:all') && !actor.permissions.has('tasks:read:own')))
      )
        return null
      const task =
        (await db
          .select(fields)
          .from(tasks)
          .where(and(eq(tasks.id, id), visible(actor)))
          .get()) ?? null
      if (task) return task
      if (projection) return (await system.rows(eq(systemGroups.id, id), 1))[0] ?? null
      return system.get(actor!, id)
    },
  }
}
