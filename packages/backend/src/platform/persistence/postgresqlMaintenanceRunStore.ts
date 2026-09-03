import type { MaintenanceJobKey } from '@agent-workflow/shared'
import { and, asc, eq, inArray, lt, lte, ne, sql } from 'drizzle-orm'

import { maintenanceRuns } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { descNullsLast } from '@/platform/persistence/postgresqlNullOrdering'
import type {
  ClaimedMaintenanceRun,
  MaintenanceRunRecord,
  MaintenanceRunStore,
} from '@/platform/background/maintenanceRunStorePort'

const QUEUED = ['pending', 'deferred'] as const

function json(value: unknown): string {
  return JSON.stringify(value ?? {})
}

function row(value: typeof maintenanceRuns.$inferSelect): MaintenanceRunRecord {
  return value
}

/** PostgreSQL durable maintenance admission/lease store. Every transition
 * after claim includes the lease token, and every write executes through the
 * PostgresqlDatabaseClient transaction fence (including first-live-write). */
export function createPostgresqlMaintenanceRunStore(
  db: PostgresqlDatabaseClient,
): MaintenanceRunStore {
  const recover = async (input: {
    readonly now: number
    readonly errorCode: string
    readonly errorMessage: string
    readonly expiredOnly: boolean
  }): Promise<number> =>
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: maintenanceRuns.id, jobKey: maintenanceRuns.jobKey })
        .from(maintenanceRuns)
        .where(
          input.expiredOnly
            ? and(
                eq(maintenanceRuns.state, 'running'),
                lt(maintenanceRuns.leaseExpiresAt, input.now),
              )
            : eq(maintenanceRuns.state, 'running'),
        )
      let recovered = 0
      for (const candidate of rows) {
        await tx
          .delete(maintenanceRuns)
          .where(
            and(
              eq(maintenanceRuns.jobKey, candidate.jobKey),
              ne(maintenanceRuns.id, candidate.id),
              inArray(maintenanceRuns.state, [...QUEUED]),
            ),
          )
        const updated = await tx
          .update(maintenanceRuns)
          .set({
            state: 'deferred',
            leaseToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            scheduledAt: input.now,
            updatedAt: input.now,
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
          })
          .where(
            and(
              eq(maintenanceRuns.id, candidate.id),
              eq(maintenanceRuns.state, 'running'),
              ...(input.expiredOnly ? [lt(maintenanceRuns.leaseExpiresAt, input.now)] : []),
            ),
          )
          .returning({ id: maintenanceRuns.id })
        recovered += updated.length
      }
      return recovered
    })

  const store: MaintenanceRunStore = {
    async enqueue(input) {
      return await db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(maintenanceRuns)
          .where(
            and(
              eq(maintenanceRuns.jobKey, input.jobKey),
              inArray(maintenanceRuns.state, [...QUEUED]),
            ),
          )
          .orderBy(asc(maintenanceRuns.createdAt))
          .limit(1)
        if (current[0] !== undefined) {
          return { row: row(current[0]), inserted: false, coalesced: true }
        }

        await tx
          .insert(maintenanceRuns)
          .values({
            id: input.id,
            jobKey: input.jobKey,
            jobClass: input.jobClass,
            slotKey: input.slotKey,
            cycleKey: input.cycleKey ?? null,
            state: 'pending',
            payloadJson: json(input.payload),
            scheduledAt: input.scheduledAt,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing()

        const exact = await tx
          .select()
          .from(maintenanceRuns)
          .where(
            and(
              eq(maintenanceRuns.jobKey, input.jobKey),
              eq(maintenanceRuns.slotKey, input.slotKey),
            ),
          )
          .limit(1)
        if (exact[0] !== undefined) {
          return { row: row(exact[0]), inserted: exact[0].id === input.id, coalesced: false }
        }
        const winner = await tx
          .select()
          .from(maintenanceRuns)
          .where(
            and(
              eq(maintenanceRuns.jobKey, input.jobKey),
              inArray(maintenanceRuns.state, [...QUEUED]),
            ),
          )
          .limit(1)
        if (winner[0] === undefined) throw new Error('maintenance-enqueue-lost')
        return { row: row(winner[0]), inserted: false, coalesced: true }
      })
    },

    async recoverExpired(now) {
      return await recover({
        now,
        errorCode: 'worker-lease-expired',
        errorMessage: 'maintenance worker lease expired before completion',
        expiredOnly: true,
      })
    },

    async recoverRunning(now) {
      return await recover({
        now,
        errorCode: 'worker-restarted',
        errorMessage: 'maintenance worker restarted before completion receipt',
        expiredOnly: false,
      })
    },

    async claimNext(input): Promise<ClaimedMaintenanceRun | null> {
      return await db.transaction(async (tx) => {
        const candidates = await tx
          .select()
          .from(maintenanceRuns)
          .where(
            and(
              inArray(maintenanceRuns.state, ['pending', 'deferred']),
              lte(maintenanceRuns.scheduledAt, input.now),
            ),
          )
          .orderBy(
            sql`case ${maintenanceRuns.jobClass}
              when 'recovery' then 0
              when 'checkpoint' then 1
              else 2 end`,
            asc(maintenanceRuns.scheduledAt),
            asc(maintenanceRuns.createdAt),
          )
          .limit(1)
        const candidate = candidates[0]
        if (candidate === undefined) return null
        const claimed = await tx
          .update(maintenanceRuns)
          .set({
            state: 'running',
            leaseToken: input.leaseToken,
            leaseExpiresAt: input.now + input.leaseMs,
            heartbeatAt: input.now,
            attempt: sql`${maintenanceRuns.attempt} + 1`,
            startedAt: candidate.startedAt ?? input.now,
            updatedAt: input.now,
            errorCode: null,
            errorMessage: null,
          })
          .where(
            and(
              eq(maintenanceRuns.id, candidate.id),
              inArray(maintenanceRuns.state, ['pending', 'deferred']),
            ),
          )
          .returning()
        return claimed[0] === undefined
          ? null
          : { row: row(claimed[0]), leaseToken: input.leaseToken }
      })
    },

    async heartbeat(input) {
      const updated = await db
        .update(maintenanceRuns)
        .set({
          heartbeatAt: input.now,
          leaseExpiresAt: input.now + input.leaseMs,
          updatedAt: input.now,
          ...(input.counters === undefined ? {} : { countersJson: json(input.counters) }),
        })
        .where(
          and(
            eq(maintenanceRuns.id, input.runId),
            eq(maintenanceRuns.state, 'running'),
            eq(maintenanceRuns.leaseToken, input.leaseToken),
          ),
        )
        .returning({ id: maintenanceRuns.id })
      return updated.length === 1
    },

    async settle(input) {
      if (input.outcome === 'deferred') {
        return await db.transaction(async (tx) => {
          const owned = await tx
            .select({ jobKey: maintenanceRuns.jobKey })
            .from(maintenanceRuns)
            .where(
              and(
                eq(maintenanceRuns.id, input.runId),
                eq(maintenanceRuns.state, 'running'),
                eq(maintenanceRuns.leaseToken, input.leaseToken),
              ),
            )
            .limit(1)
          if (owned[0] === undefined) return false
          await tx
            .delete(maintenanceRuns)
            .where(
              and(
                eq(maintenanceRuns.jobKey, owned[0].jobKey),
                ne(maintenanceRuns.id, input.runId),
                inArray(maintenanceRuns.state, [...QUEUED]),
              ),
            )
          const updated = await tx
            .update(maintenanceRuns)
            .set({
              state: 'deferred',
              leaseToken: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              countersJson: json(input.counters ?? {}),
              cursorJson:
                input.cursor === undefined || input.cursor === null ? null : json(input.cursor),
              sliceNo: sql`${maintenanceRuns.sliceNo} + 1`,
              errorCode: input.errorCode ?? null,
              errorMessage: input.errorMessage ?? null,
              scheduledAt: input.nextAttemptAt ?? input.now,
              finishedAt: null,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(maintenanceRuns.id, input.runId),
                eq(maintenanceRuns.state, 'running'),
                eq(maintenanceRuns.leaseToken, input.leaseToken),
              ),
            )
            .returning({ id: maintenanceRuns.id })
          return updated.length === 1
        })
      }
      const updated = await db
        .update(maintenanceRuns)
        .set({
          state: input.outcome,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          countersJson: json(input.counters ?? {}),
          cursorJson:
            input.cursor === undefined || input.cursor === null ? null : json(input.cursor),
          sliceNo: sql`${maintenanceRuns.sliceNo} + 1`,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          scheduledAt: sql`${maintenanceRuns.scheduledAt}`,
          finishedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(maintenanceRuns.id, input.runId),
            eq(maintenanceRuns.state, 'running'),
            eq(maintenanceRuns.leaseToken, input.leaseToken),
          ),
        )
        .returning({ id: maintenanceRuns.id })
      return updated.length === 1
    },

    async read(runId) {
      const rows = await db
        .select()
        .from(maintenanceRuns)
        .where(eq(maintenanceRuns.id, runId))
        .limit(1)
      return rows[0] === undefined ? null : row(rows[0])
    },

    async hasCycle(cycleKey) {
      const rows = await db
        .select({ id: maintenanceRuns.id })
        .from(maintenanceRuns)
        .where(and(eq(maintenanceRuns.jobClass, 'cleanup'), eq(maintenanceRuns.cycleKey, cycleKey)))
        .limit(1)
      return rows[0] !== undefined
    },

    async readProjection() {
      const [activeRows, lastRows, backlog] = await Promise.all([
        db
          .select()
          .from(maintenanceRuns)
          .where(eq(maintenanceRuns.state, 'running'))
          .orderBy(descNullsLast(maintenanceRuns.startedAt))
          .limit(1),
        db
          .select()
          .from(maintenanceRuns)
          .where(inArray(maintenanceRuns.state, ['succeeded', 'failed']))
          .orderBy(descNullsLast(maintenanceRuns.finishedAt))
          .limit(1),
        db
          .select()
          .from(maintenanceRuns)
          .where(inArray(maintenanceRuns.state, ['pending', 'deferred', 'failed']))
          .orderBy(asc(maintenanceRuns.createdAt))
          .limit(50),
      ])
      return {
        active: activeRows[0] === undefined ? null : row(activeRows[0]),
        last: lastRows[0] === undefined ? null : row(lastRows[0]),
        backlog: backlog.map(row),
      }
    },
  }
  return Object.freeze(store)
}

export type { MaintenanceJobKey }
