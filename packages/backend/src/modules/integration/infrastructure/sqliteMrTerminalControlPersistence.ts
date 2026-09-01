// RFC-349 — SQLite provider implementation for the Integration-owned MR
// launch/effect Promise ports. Synchronous SQLite transactions are contained
// here and never escape into application/public code.
import { and, asc, eq, inArray, lt, lte, ne, or } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  webhookMrControlEffects,
  webhookMrControlTargets,
  webhookMrLaunchGuards,
  webhookMrStreamStates,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import type {
  MrLaunchGuardPersistencePort,
  MrTerminalEffectPersistencePort,
} from '../application/ports/mrTerminalControlPersistence'
import { ConflictError } from '@/util/errors'

const OPEN_GUARD_STATUSES = ['reserved', 'launching'] as const
const BARRIER_GUARD_STATUSES = [
  'reserved',
  'launching',
  'revoking-terminal',
  'task-committed',
] as const

function safeCode(errorCode: string): string {
  return errorCode.replace(/[^a-z0-9._-]/gi, '-').slice(0, 200)
}

export function createSqliteMrLaunchGuardPersistence(db: DbClient): MrLaunchGuardPersistencePort {
  return {
    async reserve(input) {
      dbTxSync(db, (tx) => {
        const stream = tx
          .select({
            state: webhookMrStreamStates.state,
            revision: webhookMrStreamStates.revision,
            lastTerminalRevision: webhookMrStreamStates.lastTerminalRevision,
          })
          .from(webhookMrStreamStates)
          .where(
            and(
              eq(webhookMrStreamStates.endpointId, input.endpointId),
              eq(webhookMrStreamStates.streamKey, input.streamKey),
            ),
          )
          .get()
        if (
          stream === undefined ||
          stream.revision < input.launchRevision ||
          stream.state !== 'open' ||
          (stream.lastTerminalRevision !== null &&
            stream.lastTerminalRevision > input.launchRevision)
        ) {
          throw new ConflictError(
            'webhook-mr-launch-terminal',
            'the MR/PR stream became terminal before launch reservation',
          )
        }
        tx.insert(webhookMrLaunchGuards)
          .values({
            id: input.guardId,
            endpointId: input.endpointId,
            streamKey: input.streamKey,
            binding: input.binding,
            launchRevision: input.launchRevision,
            deliveryId: input.deliveryId,
            fireId: input.fireId,
            triggerId: input.triggerId,
            triggerNameSnapshot: input.triggerName,
            launchOwnerKey: input.ownerKey,
            status: 'reserved',
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          })
          .run()
      })
    },
    async markLaunching(guardId, now) {
      db.update(webhookMrLaunchGuards)
        .set({ status: 'launching', updatedAt: now })
        .where(
          and(eq(webhookMrLaunchGuards.id, guardId), eq(webhookMrLaunchGuards.status, 'reserved')),
        )
        .run()
    },
    async assertCanCommit(input) {
      const row = db
        .select({
          status: webhookMrLaunchGuards.status,
          state: webhookMrStreamStates.state,
          lastTerminalRevision: webhookMrStreamStates.lastTerminalRevision,
        })
        .from(webhookMrLaunchGuards)
        .innerJoin(
          webhookMrStreamStates,
          and(
            eq(webhookMrStreamStates.endpointId, webhookMrLaunchGuards.endpointId),
            eq(webhookMrStreamStates.streamKey, webhookMrLaunchGuards.streamKey),
          ),
        )
        .where(eq(webhookMrLaunchGuards.id, input.guardId))
        .limit(1)
        .get()
      return (
        row !== undefined &&
        OPEN_GUARD_STATUSES.includes(row.status as (typeof OPEN_GUARD_STATUSES)[number]) &&
        row.state === 'open' &&
        (row.lastTerminalRevision === null || row.lastTerminalRevision <= input.launchRevision)
      )
    },
    async markTaskCommitted(guardId, taskId, now) {
      db.update(webhookMrLaunchGuards)
        .set({ taskId, status: 'task-committed', updatedAt: now })
        .where(
          and(
            eq(webhookMrLaunchGuards.id, guardId),
            inArray(webhookMrLaunchGuards.status, ['reserved', 'launching', 'revoking-terminal']),
          ),
        )
        .run()
    },
    async markLaunchSettled(guardId, taskId, now) {
      db.update(webhookMrLaunchGuards)
        .set({ taskId, status: 'launch-settled', launchOwnerKey: null, updatedAt: now })
        .where(
          and(
            eq(webhookMrLaunchGuards.id, guardId),
            inArray(webhookMrLaunchGuards.status, BARRIER_GUARD_STATUSES),
          ),
        )
        .run()
    },
    async markFailed(guardId, errorCode, now) {
      const current = db
        .select({ status: webhookMrLaunchGuards.status })
        .from(webhookMrLaunchGuards)
        .where(eq(webhookMrLaunchGuards.id, guardId))
        .limit(1)
        .get()
      if (current === undefined || current.status === 'launch-settled') return
      db.update(webhookMrLaunchGuards)
        .set({
          status: current.status === 'revoking-terminal' ? 'aborted-terminal' : 'failed',
          error: safeCode(errorCode),
          launchOwnerKey: null,
          updatedAt: now,
        })
        .where(eq(webhookMrLaunchGuards.id, guardId))
        .run()
    },
    async listRevokingGuardIds() {
      return db
        .select({ id: webhookMrLaunchGuards.id })
        .from(webhookMrLaunchGuards)
        .where(eq(webhookMrLaunchGuards.status, 'revoking-terminal'))
        .all()
        .map((row) => row.id)
    },
    async reconcileStaleOnBoot(now) {
      dbTxSync(db, (tx) => {
        tx.update(webhookMrLaunchGuards)
          .set({ status: 'aborted-terminal', launchOwnerKey: null, updatedAt: now })
          .where(eq(webhookMrLaunchGuards.status, 'revoking-terminal'))
          .run()
        tx.update(webhookMrLaunchGuards)
          .set({
            status: 'failed',
            error: 'daemon-restart-before-task-commit',
            launchOwnerKey: null,
            updatedAt: now,
          })
          .where(
            and(
              inArray(webhookMrLaunchGuards.status, ['reserved', 'launching']),
              lte(webhookMrLaunchGuards.updatedAt, now),
            ),
          )
          .run()
        const committed = tx
          .select({ id: webhookMrLaunchGuards.id, taskId: webhookMrLaunchGuards.taskId })
          .from(webhookMrLaunchGuards)
          .where(eq(webhookMrLaunchGuards.status, 'task-committed'))
          .all()
        for (const row of committed) {
          tx.update(webhookMrLaunchGuards)
            .set({
              status: row.taskId === null ? 'failed' : 'launch-settled',
              error: row.taskId === null ? 'daemon-restart-task-id-missing' : null,
              launchOwnerKey: null,
              updatedAt: now,
            })
            .where(eq(webhookMrLaunchGuards.id, row.id))
            .run()
        }
      })
    },
    async hasLaunchBarrier(binding, revision) {
      return (
        db
          .select({ id: webhookMrLaunchGuards.id })
          .from(webhookMrLaunchGuards)
          .where(
            and(
              eq(webhookMrLaunchGuards.binding, binding),
              lt(webhookMrLaunchGuards.launchRevision, revision),
              inArray(webhookMrLaunchGuards.status, BARRIER_GUARD_STATUSES),
            ),
          )
          .limit(1)
          .get() !== undefined
      )
    },
  }
}

export function createSqliteMrTerminalEffectPersistence(
  db: DbClient,
): MrTerminalEffectPersistencePort {
  return {
    async claimNextDue(input) {
      return dbTxSync(db, (tx) => {
        const candidates = tx
          .select()
          .from(webhookMrControlEffects)
          .where(
            and(
              lte(webhookMrControlEffects.nextAttemptAt, input.now),
              or(
                inArray(webhookMrControlEffects.status, [
                  'pending',
                  'waiting-launches',
                  'retryable',
                ]),
                and(
                  eq(webhookMrControlEffects.status, 'leased'),
                  lte(webhookMrControlEffects.leaseExpiresAt, input.now),
                ),
              ),
            ),
          )
          .orderBy(asc(webhookMrControlEffects.createdAt), asc(webhookMrControlEffects.revision))
          .all()
        for (const candidate of candidates) {
          const older = tx
            .select({ id: webhookMrControlEffects.id })
            .from(webhookMrControlEffects)
            .where(
              and(
                eq(webhookMrControlEffects.endpointId, candidate.endpointId),
                eq(webhookMrControlEffects.streamKey, candidate.streamKey),
                lt(webhookMrControlEffects.revision, candidate.revision),
                ne(webhookMrControlEffects.status, 'succeeded'),
              ),
            )
            .limit(1)
            .get()
          if (older !== undefined) continue
          const claimed = tx
            .update(webhookMrControlEffects)
            .set({
              status: 'leased',
              leaseOwner: input.workerId,
              leaseExpiresAt: input.now + input.leaseMs,
              attemptCount: candidate.attemptCount + 1,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(webhookMrControlEffects.id, candidate.id),
                eq(webhookMrControlEffects.status, candidate.status),
                eq(webhookMrControlEffects.attemptCount, candidate.attemptCount),
              ),
            )
            .returning()
            .get()
          if (claimed !== undefined) {
            return {
              id: claimed.id,
              binding: claimed.binding,
              endpointId: claimed.endpointId,
              streamKey: claimed.streamKey,
              revision: claimed.revision,
              kind: claimed.kind,
              deliveryId: claimed.deliveryId,
              attemptCount: claimed.attemptCount,
            }
          }
        }
        return null
      })
    },
    async recordReceipts(effectId, receipts, now) {
      dbTxSync(db, (tx) => {
        for (const receipt of receipts) {
          tx.insert(webhookMrControlTargets)
            .values({
              effectId,
              taskId: receipt.taskId,
              priorStatus: receipt.priorStatus,
              fenceOutcome: receipt.fenceOutcome as
                | 'fenced-closed'
                | 'fenced-merged'
                | 'cleared-closed'
                | 'unchanged',
              cancelOutcome: receipt.cancelOutcome as
                | 'canceled'
                | 'already-terminal'
                | 'not-applicable',
              releaseOutcome: receipt.releaseOutcome as
                | 'pending'
                | 'no-active-owner'
                | 'released'
                | 'unreaped',
              error: receipt.errorCode,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [webhookMrControlTargets.effectId, webhookMrControlTargets.taskId],
              set: {
                releaseOutcome: receipt.releaseOutcome as
                  | 'pending'
                  | 'no-active-owner'
                  | 'released'
                  | 'unreaped',
                error: receipt.errorCode,
                updatedAt: now,
              },
            })
            .run()
        }
      })
    },
    async listReleaseOutcomes(effectId) {
      return db
        .select({ releaseOutcome: webhookMrControlTargets.releaseOutcome })
        .from(webhookMrControlTargets)
        .where(eq(webhookMrControlTargets.effectId, effectId))
        .all()
        .map((row) => row.releaseOutcome)
    },
    async finishAttempt(input) {
      db.update(webhookMrControlEffects)
        .set({
          status: input.status,
          nextAttemptAt: input.nextAttemptAt,
          lastError: input.lastError,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(webhookMrControlEffects.id, input.effectId),
            eq(webhookMrControlEffects.leaseOwner, input.workerId),
          ),
        )
        .run()
    },
  }
}
