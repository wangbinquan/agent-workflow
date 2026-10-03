import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm'
import type { ObservationTaskPageQuery } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { taskVisibilityCondition, type ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionObservationSources, taskRepos, tasks } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import type { TaskObservationFactsQuery } from '../public/queries'
import { createObservationSpanSources } from './observationSpanSources'
import { observationAttemptKinds } from './taskObservationKinds'

const canRead = (actor: Actor) =>
  actor.permissions.has('tasks:read:all') || actor.permissions.has('tasks:read:own')
const scope = (query: ObservationTaskPageQuery) => {
  const filters = [query.q, query.status, query.repository, query.workflow]
  return JSON.stringify([
    query.from,
    query.to,
    query.timezone,
    ...(filters.some((value) => value !== undefined) ? [sha256Hex(JSON.stringify(filters))] : []),
  ])
}
function continuation(query: ObservationTaskPageQuery): [number, string] | null {
  if (query.after === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(query.after)
  } catch {
    throw new RangeError('Invalid task observation cursor')
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== 1 ||
    parsed[1] !== scope(query) ||
    !Number.isSafeInteger(parsed[2]) ||
    typeof parsed[3] !== 'string' ||
    !parsed[3]
  )
    throw new RangeError('Task observation cursor changed window')
  return [parsed[2] as number, parsed[3]]
}

function attemptContinuation(taskId: string, cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch {
    throw new RangeError('Invalid observation attempt cursor')
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== 1 ||
    value[1] !== taskId ||
    typeof value[2] !== 'string' ||
    !value[2]
  )
    throw new RangeError('Observation attempt cursor changed task')
  return value[2]
}
function attemptFields() {
  return {
    id: nodeRuns.id,
    nodeId: nodeRuns.nodeId,
    status: nodeRuns.status,
    startedAt: nodeRuns.startedAt,
    finishedAt: nodeRuns.finishedAt,
    retryIndex: nodeRuns.retryIndex,
    iteration: nodeRuns.iteration,
    wgRound: nodeRuns.wgRound,
    reviewIteration: nodeRuns.reviewIteration,
  }
}

/** Bind to the snapshot handle supplied by bootstrap; do not open another transaction. */
export function createTaskObservationFacts(db: ProviderNeutralDatabase): TaskObservationFactsQuery {
  const taskFields = {
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
  const visible = (actor: Actor) =>
    taskVisibilityCondition(db, {
      userId: actor.user.id,
      canReadAllTasks: actor.permissions.has('tasks:read:all'),
    })
  return {
    spanSources: createObservationSpanSources(db),
    async sourceBacklog(taskIds) {
      if (taskIds.length > 200)
        throw new RangeError('Observation source cohort exceeds read budget')
      if (!taskIds.length) return []
      const source = taskExecutionObservationSources
      const rows = await db
        .select({
          taskId: nodeRuns.taskId,
          retainedRecords: count(),
          pendingRecords: sql`sum(case when ${source.pending} then 1 else 0 end)`,
        })
        .from(nodeRuns)
        .innerJoin(
          source,
          and(eq(source.nodeRunId, nodeRuns.id), eq(source.taskId, nodeRuns.taskId)),
        )
        .where(inArray(nodeRuns.taskId, [...new Set(taskIds)]))
        .groupBy(nodeRuns.taskId)
        .all()
      const byTask = new Map(rows.map((row) => [row.taskId, row]))
      return [...new Set(taskIds)].map((taskId) => {
        const row = byTask.get(taskId)
        return {
          taskId,
          retainedRecords: row
            ? engineOf(db).numericFromRawRow(row.retainedRecords, 'retainedRecords')
            : 0,
          pendingRecords: row
            ? engineOf(db).numericFromRawRow(row.pendingRecords, 'pendingRecords')
            : 0,
        }
      })
    },
    async list({ actor, query }) {
      const after = continuation(query)
      if (!canRead(actor)) return { items: [], positions: [], nextCursor: null }
      const engine = engineOf(db)
      const search = query.q === undefined ? null : engine.likeEscape(query.q)
      const rows = await db
        .select(taskFields)
        .from(tasks)
        .where(
          and(
            visible(actor),
            isNull(tasks.deletedAt),
            eq(tasks.catalogVisibility, 'public'),
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
      const items = rows.slice(0, query.limit),
        last = items.at(-1)
      return {
        items,
        positions: items.map((task) => ({
          taskId: task.id,
          cursor: JSON.stringify([1, scope(query), task.startedAt, task.id]),
        })),
        nextCursor:
          rows.length > query.limit && last
            ? JSON.stringify([1, scope(query), last.startedAt, last.id])
            : null,
      }
    },
    async get(actor, taskId) {
      if (!canRead(actor)) return null
      return (
        (await db
          .select(taskFields)
          .from(tasks)
          .where(and(eq(tasks.id, taskId), visible(actor), isNull(tasks.deletedAt)))
          .get()) ?? null
      )
    },
    async attemptPage(taskId, page) {
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000)
        throw new RangeError('Attempt page size must be 1 through 1000')
      const after = attemptContinuation(taskId, page.after)
      const rows = await db
        .select(attemptFields())
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, taskId),
            after === undefined ? undefined : gt(nodeRuns.id, after),
          ),
        )
        .orderBy(asc(nodeRuns.id))
        .limit(page.limit + 1)
        .all()
      const items = rows.slice(0, page.limit),
        last = items.at(-1)
      return {
        items: await observationAttemptKinds(db, taskId, items),
        nextCursor: rows.length > page.limit && last ? JSON.stringify([1, taskId, last.id]) : null,
      }
    },
    async attempts(taskId, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new RangeError('Attempt limit must be 1 through 1000')
      const rows = await db
        .select(attemptFields())
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .orderBy(asc(nodeRuns.id))
        .limit(limit + 1)
        .all()
      return {
        items: await observationAttemptKinds(db, taskId, rows.slice(0, limit)),
        truncated: rows.length > limit,
      }
    },
  }
}
