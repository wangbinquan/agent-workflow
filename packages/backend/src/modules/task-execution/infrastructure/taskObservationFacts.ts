import { and, asc, desc, eq, gte, isNull, lt, or } from 'drizzle-orm'
import type { ObservationTaskPageQuery } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { taskVisibilityCondition, type ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks } from '@/db/schema'
import type { TaskObservationFactsQuery } from '../public/queries'

const canRead = (actor: Actor) =>
  actor.permissions.has('tasks:read:all') || actor.permissions.has('tasks:read:own')
const scope = (query: ObservationTaskPageQuery) =>
  JSON.stringify([query.from, query.to, query.timezone])
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

/** Bind to the snapshot handle supplied by bootstrap; do not open another transaction. */
export function createTaskObservationFacts(db: ProviderNeutralDatabase): TaskObservationFactsQuery {
  const taskFields = {
    id: tasks.id,
    name: tasks.name,
    status: tasks.status,
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
    async list({ actor, query }) {
      const after = continuation(query)
      if (!canRead(actor)) return { items: [], nextCursor: null }
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
    async attempts(taskId, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new RangeError('Attempt limit must be 1 through 1000')
      const rows = await db
        .select({
          id: nodeRuns.id,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          startedAt: nodeRuns.startedAt,
          finishedAt: nodeRuns.finishedAt,
          retryIndex: nodeRuns.retryIndex,
          iteration: nodeRuns.iteration,
          wgRound: nodeRuns.wgRound,
          reviewIteration: nodeRuns.reviewIteration,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .orderBy(asc(nodeRuns.id))
        .limit(limit + 1)
        .all()
      return { items: rows.slice(0, limit), truncated: rows.length > limit }
    },
  }
}
