// RFC-371 v2 §2/§5 — task facts offered to run-observability. Task execution is
// the only owner of task visibility; observation never reads these tables.

import { runHistoryOrder } from '@/platform/persistence/runHistoryOrder'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, desc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { taskVisibilityCondition, taskVisibilitySubjectOf, visibleTaskIdsFor } from '@/db/query'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type {
  ObservationTaskFactsPort,
  ObservedTaskFact,
} from '@/modules/run-observability/public/queries'

const MAX_IDS = 500
const MAX_DURATIONS = 100_000
const MAX_ATTEMPTS = 5_000

const canRead = (actor: Actor) =>
  actor.permissions.has('tasks:read:all') || actor.permissions.has('tasks:read:own')

// Built per query: schema columns are provider projections and must not be captured at load time.
function taskFields(db: object) {
  const { tasks } = tablesOf(db)
  return {
    id: tasks.id,
    name: tasks.name,
    status: tasks.status,
    startedAt: tasks.startedAt,
    finishedAt: tasks.finishedAt,
    runningMs: tasks.runningMs,
  }
}

function fact(row: {
  readonly id: string
  readonly name: string
  readonly status: ObservedTaskFact['status']
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly runningMs: number
}): ObservedTaskFact {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    startedAt: Number(row.startedAt),
    finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
    runningMs: Number(row.runningMs),
  }
}

function decodeAfter(after: string | undefined): [number, string] | null {
  if (after === undefined) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'))
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === 'string'
    )
      return [value[0] as number, value[1]]
  } catch {
    /* fall through */
  }
  throw new RangeError('invalid-cursor')
}

export function createTaskObservationFacts(db: PersistenceDb): ObservationTaskFactsPort {
  const visible = (actor: Actor) => taskVisibilityCondition(db, taskVisibilitySubjectOf(actor))
  const bounded = (ids: readonly string[]) => {
    if (ids.length > MAX_IDS) throw new RangeError('task id batch exceeds 500')
    return [...new Set(ids)]
  }
  return {
    async visibleTaskIds(actor, ids) {
      const unique = bounded(ids)
      if (!unique.length || !canRead(actor)) return []
      // The single task authorization predicate (db/query.ts).
      return [...(await visibleTaskIdsFor(db, taskVisibilitySubjectOf(actor), unique))]
    },

    async summaries(ids) {
      const unique = bounded(ids)
      if (!unique.length) return []
      const { tasks } = tablesOf(db)
      const rows = await db
        .select(taskFields(db))
        .from(tasks)
        .where(and(inArray(tasks.id, unique), isNull(tasks.deletedAt)))
      return rows.map(fact)
    },

    async page(actor, query) {
      if (!canRead(actor)) return { items: [], nextCursor: null }
      const after = decodeAfter(query.after)
      const engine = engineOf(db)
      const search = query.q === undefined ? null : engine.likeEscape(query.q)
      const { tasks } = tablesOf(db)
      const rows = await db
        .select(taskFields(db))
        .from(tasks)
        .where(
          and(
            visible(actor),
            isNull(tasks.deletedAt),
            eq(tasks.catalogVisibility, 'public'),
            gte(tasks.startedAt, query.from),
            lt(tasks.startedAt, query.to),
            query.status === undefined
              ? undefined
              : eq(tasks.status, query.status as ObservedTaskFact['status']),
            search === null
              ? undefined
              : or(
                  engine.likeCaseInsensitive(tasks.name, search.pattern, search.escape),
                  engine.likeCaseInsensitive(tasks.id, search.pattern, search.escape),
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
      const items = rows.slice(0, query.limit).map(fact)
      const last = items.at(-1)
      return {
        items,
        nextCursor:
          rows.length > query.limit && last
            ? Buffer.from(JSON.stringify([last.startedAt, last.id])).toString('base64url')
            : null,
      }
    },

    async counts(actor, window) {
      if (!canRead(actor)) return { statuses: {}, durations: [] }
      const { tasks } = tablesOf(db)
      const scope = and(
        visible(actor),
        isNull(tasks.deletedAt),
        eq(tasks.catalogVisibility, 'public'),
        gte(tasks.startedAt, window.from),
        lt(tasks.startedAt, window.to),
      )
      const rows = await db
        .select({ status: tasks.status, startedAt: tasks.startedAt, finishedAt: tasks.finishedAt })
        .from(tasks)
        .where(scope)
      const statuses: Record<string, number> = {}
      const durations: number[] = []
      for (const row of rows) {
        statuses[row.status] = (statuses[row.status] ?? 0) + 1
        if (
          (row.status === 'done' || row.status === 'failed' || row.status === 'canceled') &&
          row.finishedAt !== null &&
          durations.length < MAX_DURATIONS
        )
          durations.push(Math.max(0, Number(row.finishedAt) - Number(row.startedAt)))
      }
      durations.sort((a, b) => a - b)
      return { statuses, durations }
    },

    async attempts(taskId) {
      const { nodeRuns } = tablesOf(db)
      const rows = await db
        .select({ id: nodeRuns.id, nodeId: nodeRuns.nodeId, retryIndex: nodeRuns.retryIndex })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .orderBy(...runHistoryOrder(db, nodeRuns))
        .limit(MAX_ATTEMPTS)
      return rows.map((row) => ({
        nodeRunId: row.id,
        nodeId: row.nodeId,
        retryIndex: Number(row.retryIndex),
      }))
    },
  }
}
