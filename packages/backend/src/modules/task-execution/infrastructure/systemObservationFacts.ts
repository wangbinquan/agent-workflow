import { and, asc, count, desc, eq, exists, gt, inArray, or, sql, type SQL } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { taskVisibilityCondition, type ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import {
  systemAgentObservationGroups as groups,
  systemAgentObservationOwners as owners,
  systemAgentObservationSources as sources,
} from '@/db/observationSystem'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { ObservationAttemptFacts } from '@agent-workflow/shared'

export const systemObservationFields = {
  id: groups.id,
  name: groups.name,
  status: groups.status,
  errorSummary: sql<string | null>`NULL`,
  parentTaskId: groups.parentTaskId,
  startedAt: groups.startedAt,
  finishedAt: groups.finishedAt,
  // A System group has owner intervals, but no original Task running-state clock.
  runningMs: sql<null>`NULL`,
  runningSince: sql<null>`NULL`,
}

/** Independent calls obey their original owner; linked calls inherit the original Task visibility. */
export function systemObservationVisibility(db: ProviderNeutralDatabase, actor: Actor) {
  if (actor.permissions.has('tasks:read:all')) return undefined
  return or(
    eq(groups.ownerUserId, actor.user.id),
    exists(
      db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, groups.parentTaskId),
            taskVisibilityCondition(db, { userId: actor.user.id, canReadAllTasks: false }),
          ),
        ),
    ),
  )
}

export function createSystemObservationFacts(db: ProviderNeutralDatabase) {
  return {
    async originalAgentName(id: string) {
      const rows = await db
        .selectDistinct({ name: owners.agentName })
        .from(owners)
        .where(eq(owners.agentId, id))
        .all()
      const name = rows.length === 1 ? rows[0]!.name : null
      return name !== null && name.trim().length > 0 ? name : null
    },
    async get(actor: Actor, id: string) {
      const row = await db
        .select(systemObservationFields)
        .from(groups)
        .where(and(eq(groups.id, id), systemObservationVisibility(db, actor)))
        .get()
      return row ?? null
    },
    async rows(condition: SQL | undefined, limit: number) {
      const rows = await db
        .select(systemObservationFields)
        .from(groups)
        .where(condition)
        .orderBy(desc(groups.startedAt), desc(groups.id))
        .limit(limit)
        .all()
      return rows
    },
    async contains(id: string) {
      return (
        (await db.select({ id: groups.id }).from(groups).where(eq(groups.id, id)).get()) !==
        undefined
      )
    },
    async backlog(ids: readonly string[]) {
      if (!ids.length) return []
      const rows = await db
        .select({
          taskId: sources.taskId,
          retainedRecords: count(),
          pendingRecords: sql`sum(case when ${sources.pending} then 1 else 0 end)`.mapWith(
            (value) => engineOf(db).numericFromRawRow(value, 'pendingRecords'),
          ),
        })
        .from(sources)
        .where(inArray(sources.taskId, [...ids]))
        .groupBy(sources.taskId)
        .all()
      return rows.map((row) => ({
        taskId: row.taskId,
        retainedRecords: engineOf(db).numericFromRawRow(row.retainedRecords, 'retainedRecords'),
        pendingRecords: engineOf(db).numericFromRawRow(row.pendingRecords, 'pendingRecords'),
      }))
    },
    async attemptPage(taskId: string, page: { readonly limit: number; readonly after?: string }) {
      let after: string | undefined
      if (page.after !== undefined) {
        const value: unknown = JSON.parse(page.after)
        if (
          !Array.isArray(value) ||
          value.length !== 3 ||
          value[0] !== 1 ||
          value[1] !== taskId ||
          typeof value[2] !== 'string' ||
          !value[2]
        )
          throw new Error('System attempt cursor changed its original group')
        after = value[2]
      }
      const rows = await db
        .select()
        .from(owners)
        .where(
          and(eq(owners.groupId, taskId), after === undefined ? undefined : gt(owners.id, after)),
        )
        .orderBy(asc(owners.id))
        .limit(page.limit + 1)
        .all()
      const items: ObservationAttemptFacts[] = rows.slice(0, page.limit).map((row) => {
        const memoryAttempt = /^(\d+):(\d+)$/.exec(row.originalAttempt)
        return {
          id: row.id,
          nodeId: row.agentName,
          computeKind: 'agent',
          status:
            row.finishedAt === null
              ? 'running'
              : row.outcome === 'ok' || row.outcome === 'conforms'
                ? 'done'
                : row.outcome === 'aborted'
                  ? 'cancelled'
                  : 'failed',
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          retryIndex: memoryAttempt ? Number(memoryAttempt[1]) : 0,
          iteration: memoryAttempt ? Number(memoryAttempt[2]) : 0,
          wgRound: null,
          reviewIteration: 0,
        }
      })
      const last = items.at(-1)
      return {
        items,
        nextCursor: rows.length > page.limit && last ? JSON.stringify([1, taskId, last.id]) : null,
      }
    },
  }
}
