// RFC-338 — SQLite-backed durable admission and lease store for maintenance.
// Every mutating transition after claim is fenced by the exact lease token so
// a late result from a crashed/replaced Worker cannot overwrite its successor.

import type { MaintenanceJobClass, MaintenanceJobKey } from '@agent-workflow/shared'
import { and, asc, desc, eq, inArray, lt, lte, ne, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { maintenanceRuns } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'

export type MaintenanceRunRow = typeof maintenanceRuns.$inferSelect

export interface EnqueueMaintenanceRunInput {
  readonly id: string
  readonly jobKey: MaintenanceJobKey
  readonly jobClass: MaintenanceJobClass
  readonly slotKey: string
  readonly cycleKey?: string | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly scheduledAt: number
  readonly now: number
}

export interface ClaimedMaintenanceRun {
  readonly row: MaintenanceRunRow
  readonly leaseToken: string
}

export interface MaintenanceRunStore {
  enqueue(input: EnqueueMaintenanceRunInput): {
    row: MaintenanceRunRow
    inserted: boolean
    coalesced: boolean
  }
  recoverExpired(now: number): number
  recoverRunning(now: number): number
  claimNext(input: {
    leaseToken: string
    now: number
    leaseMs: number
  }): ClaimedMaintenanceRun | null
  heartbeat(input: {
    runId: string
    leaseToken: string
    now: number
    leaseMs: number
    counters?: Readonly<Record<string, number>>
  }): boolean
  settle(input: {
    runId: string
    leaseToken: string
    now: number
    outcome: 'succeeded' | 'failed' | 'deferred'
    counters?: Readonly<Record<string, number>>
    cursor?: object | null
    errorCode?: string
    errorMessage?: string
    nextAttemptAt?: number
  }): boolean
  read(runId: string): MaintenanceRunRow | null
  hasCycle(cycleKey: string): boolean
  readProjection(): {
    active: MaintenanceRunRow | null
    last: MaintenanceRunRow | null
    backlog: MaintenanceRunRow[]
  }
}

const QUEUED = ['pending', 'deferred'] as const

function json(value: unknown): string {
  return JSON.stringify(value ?? {})
}

export function createMaintenanceRunStore(db: DbClient): MaintenanceRunStore {
  const recover = (input: {
    now: number
    errorCode: string
    errorMessage: string
    expiredOnly: boolean
  }): number =>
    dbTxSync(db, (tx) => {
      const rows = tx
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
        .all()
      let recovered = 0
      for (const row of rows) {
        // A future schedule slot is allowed to queue while this job is
        // running. Recovery resumes the interrupted cursor and therefore
        // absorbs that queued catch-up before running -> deferred, preserving
        // the one-queued-per-job invariant atomically.
        tx.delete(maintenanceRuns)
          .where(
            and(
              eq(maintenanceRuns.jobKey, row.jobKey),
              ne(maintenanceRuns.id, row.id),
              inArray(maintenanceRuns.state, [...QUEUED]),
            ),
          )
          .run()
        const updated = tx
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
              eq(maintenanceRuns.id, row.id),
              eq(maintenanceRuns.state, 'running'),
              ...(input.expiredOnly ? [lt(maintenanceRuns.leaseExpiresAt, input.now)] : []),
            ),
          )
          .run() as unknown as { changes: number }
        recovered += updated.changes
      }
      return recovered
    })

  return {
    enqueue(input) {
      return dbTxSync(db, (tx) => {
        const current = tx
          .select()
          .from(maintenanceRuns)
          .where(
            and(
              eq(maintenanceRuns.jobKey, input.jobKey),
              inArray(maintenanceRuns.state, [...QUEUED]),
            ),
          )
          .orderBy(asc(maintenanceRuns.createdAt))
          .get()
        if (current !== undefined) {
          return { row: current, inserted: false, coalesced: true }
        }

        tx.insert(maintenanceRuns)
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
          .run()

        const exact = tx
          .select()
          .from(maintenanceRuns)
          .where(
            and(
              eq(maintenanceRuns.jobKey, input.jobKey),
              eq(maintenanceRuns.slotKey, input.slotKey),
            ),
          )
          .get()
        if (exact !== undefined) {
          return { row: exact, inserted: exact.id === input.id, coalesced: false }
        }
        // A concurrent connection may have won the one-queued partial
        // unique index with a different slot after our first read.
        const winner = tx
          .select()
          .from(maintenanceRuns)
          .where(
            and(
              eq(maintenanceRuns.jobKey, input.jobKey),
              inArray(maintenanceRuns.state, [...QUEUED]),
            ),
          )
          .get()
        if (winner === undefined) throw new Error('maintenance-enqueue-lost')
        return { row: winner, inserted: false, coalesced: true }
      })
    },

    recoverExpired(now) {
      return recover({
        now,
        errorCode: 'worker-lease-expired',
        errorMessage: 'maintenance worker lease expired before completion',
        expiredOnly: true,
      })
    },

    recoverRunning(now) {
      return recover({
        now,
        errorCode: 'worker-restarted',
        errorMessage: 'maintenance worker restarted before completion receipt',
        expiredOnly: false,
      })
    },

    claimNext(input) {
      return dbTxSync(db, (tx) => {
        const candidate = tx
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
          .get()
        if (candidate === undefined) return null
        const claimed = tx
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
          .get()
        return claimed === undefined ? null : { row: claimed, leaseToken: input.leaseToken }
      })
    },

    heartbeat(input) {
      const updated = db
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
        .run() as unknown as { changes: number }
      return updated.changes === 1
    },

    settle(input) {
      const state = input.outcome
      const isDeferred = state === 'deferred'
      if (isDeferred) {
        return dbTxSync(db, (tx) => {
          const owned = tx
            .select({ jobKey: maintenanceRuns.jobKey })
            .from(maintenanceRuns)
            .where(
              and(
                eq(maintenanceRuns.id, input.runId),
                eq(maintenanceRuns.state, 'running'),
                eq(maintenanceRuns.leaseToken, input.leaseToken),
              ),
            )
            .get()
          if (owned === undefined) return false
          // A later schedule slot may already be queued while this slice is
          // running. The retrying current slice subsumes that one catch-up;
          // remove the unclaimed row before changing current -> deferred so
          // the one-queued invariant stays true.
          tx.delete(maintenanceRuns)
            .where(
              and(
                eq(maintenanceRuns.jobKey, owned.jobKey),
                ne(maintenanceRuns.id, input.runId),
                inArray(maintenanceRuns.state, [...QUEUED]),
              ),
            )
            .run()
          const updated = tx
            .update(maintenanceRuns)
            .set({
              state,
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
            .run() as unknown as { changes: number }
          return updated.changes === 1
        })
      }
      const updated = db
        .update(maintenanceRuns)
        .set({
          state,
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
        .run() as unknown as { changes: number }
      return updated.changes === 1
    },

    read(runId) {
      return db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, runId)).get() ?? null
    },

    hasCycle(cycleKey) {
      return (
        db
          .select({ id: maintenanceRuns.id })
          .from(maintenanceRuns)
          .where(
            and(eq(maintenanceRuns.jobClass, 'cleanup'), eq(maintenanceRuns.cycleKey, cycleKey)),
          )
          .limit(1)
          .get() !== undefined
      )
    },

    readProjection() {
      const active =
        db
          .select()
          .from(maintenanceRuns)
          .where(eq(maintenanceRuns.state, 'running'))
          .orderBy(desc(maintenanceRuns.startedAt))
          .get() ?? null
      const last =
        db
          .select()
          .from(maintenanceRuns)
          .where(inArray(maintenanceRuns.state, ['succeeded', 'failed']))
          .orderBy(desc(maintenanceRuns.finishedAt))
          .get() ?? null
      const backlog = db
        .select()
        .from(maintenanceRuns)
        .where(inArray(maintenanceRuns.state, ['pending', 'deferred', 'failed']))
        .orderBy(asc(maintenanceRuns.createdAt))
        .limit(50)
        .all()
      return { active, last, backlog }
    },
  }
}
