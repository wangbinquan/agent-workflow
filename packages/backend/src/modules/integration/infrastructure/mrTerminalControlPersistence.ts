// RFC-359 W4-B4 —— Integration 拥有的 MR 启动守卫 / 终态 effect 持久化：一份实现，两个 provider 共用。
// 事务走统一原语；PG 侧「先按流序列化再看 open 状态」的事务级 advisory lock 由引擎能力矩阵表达
// （SQLite 单写者下是 no-op）。

import { and, asc, eq, inArray, lt, lte, ne, or } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  webhookMrControlEffects,
  webhookMrControlTargets,
  webhookMrLaunchGuards,
  webhookMrStreamStates,
} from '@/db/schema'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
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

export function createMrLaunchGuardPersistence(
  db: ProviderNeutralDatabase,
): MrLaunchGuardPersistencePort {
  const session = databaseSessionFor(db)
  return {
    async reserve(input) {
      await session.transaction(async (tx) => {
        // The terminal-ingress adapter takes the same transaction-scoped lock.
        // Unlike a row lock this also serializes the first event, before a
        // stream-state row exists, closing terminal-update -> guard-insert.
        await engineOf(tx).advisoryLock(tx, `${input.endpointId}:${input.streamKey}`)
        const stream = (
          await tx
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
            .limit(1)
        )[0]
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
        await tx.insert(webhookMrLaunchGuards).values({
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
      })
    },
    async markLaunching(guardId, now) {
      await db
        .update(webhookMrLaunchGuards)
        .set({ status: 'launching', updatedAt: now })
        .where(
          and(eq(webhookMrLaunchGuards.id, guardId), eq(webhookMrLaunchGuards.status, 'reserved')),
        )
    },
    async assertCanCommit(input) {
      const row = (
        await db
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
      )[0]
      return (
        row !== undefined &&
        OPEN_GUARD_STATUSES.includes(row.status as (typeof OPEN_GUARD_STATUSES)[number]) &&
        row.state === 'open' &&
        (row.lastTerminalRevision === null || row.lastTerminalRevision <= input.launchRevision)
      )
    },
    async markTaskCommitted(guardId, taskId, now) {
      await db
        .update(webhookMrLaunchGuards)
        .set({ taskId, status: 'task-committed', updatedAt: now })
        .where(
          and(
            eq(webhookMrLaunchGuards.id, guardId),
            inArray(webhookMrLaunchGuards.status, ['reserved', 'launching', 'revoking-terminal']),
          ),
        )
    },
    async markLaunchSettled(guardId, taskId, now) {
      await db
        .update(webhookMrLaunchGuards)
        .set({ taskId, status: 'launch-settled', launchOwnerKey: null, updatedAt: now })
        .where(
          and(
            eq(webhookMrLaunchGuards.id, guardId),
            inArray(webhookMrLaunchGuards.status, BARRIER_GUARD_STATUSES),
          ),
        )
    },
    async markFailed(guardId, errorCode, now) {
      const current = (
        await db
          .select({ status: webhookMrLaunchGuards.status })
          .from(webhookMrLaunchGuards)
          .where(eq(webhookMrLaunchGuards.id, guardId))
          .limit(1)
      )[0]
      if (current === undefined || current.status === 'launch-settled') return
      await db
        .update(webhookMrLaunchGuards)
        .set({
          status: current.status === 'revoking-terminal' ? 'aborted-terminal' : 'failed',
          error: safeCode(errorCode),
          launchOwnerKey: null,
          updatedAt: now,
        })
        .where(eq(webhookMrLaunchGuards.id, guardId))
    },
    async listRevokingGuardIds() {
      const rows = await db
        .select({ id: webhookMrLaunchGuards.id })
        .from(webhookMrLaunchGuards)
        .where(eq(webhookMrLaunchGuards.status, 'revoking-terminal'))
      return rows.map((row) => row.id)
    },
    async reconcileStaleOnBoot(now) {
      await session.transaction(async (tx) => {
        await tx
          .update(webhookMrLaunchGuards)
          .set({ status: 'aborted-terminal', launchOwnerKey: null, updatedAt: now })
          .where(eq(webhookMrLaunchGuards.status, 'revoking-terminal'))
        await tx
          .update(webhookMrLaunchGuards)
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
        const committed = await tx
          .select({ id: webhookMrLaunchGuards.id, taskId: webhookMrLaunchGuards.taskId })
          .from(webhookMrLaunchGuards)
          .where(eq(webhookMrLaunchGuards.status, 'task-committed'))
        for (const row of committed) {
          await tx
            .update(webhookMrLaunchGuards)
            .set({
              status: row.taskId === null ? 'failed' : 'launch-settled',
              error: row.taskId === null ? 'daemon-restart-task-id-missing' : null,
              launchOwnerKey: null,
              updatedAt: now,
            })
            .where(eq(webhookMrLaunchGuards.id, row.id))
        }
      })
    },
    async hasLaunchBarrier(binding, revision) {
      return (
        (
          await db
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
        ).length > 0
      )
    },
  }
}

export function createMrTerminalEffectPersistence(
  db: ProviderNeutralDatabase,
): MrTerminalEffectPersistencePort {
  const session = databaseSessionFor(db)
  return {
    async claimNextDue(input) {
      return await session.transaction(async (tx) => {
        const candidates = await tx
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
        for (const candidate of candidates) {
          const older = (
            await tx
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
          )[0]
          if (older !== undefined) continue
          const claimed = (
            await tx
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
          )[0]
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
      await session.transaction(async (tx) => {
        for (const receipt of receipts) {
          await tx
            .insert(webhookMrControlTargets)
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
        }
      })
    },
    async listReleaseOutcomes(effectId) {
      const rows = await db
        .select({ releaseOutcome: webhookMrControlTargets.releaseOutcome })
        .from(webhookMrControlTargets)
        .where(eq(webhookMrControlTargets.effectId, effectId))
      return rows.map((row) => row.releaseOutcome)
    },
    async finishAttempt(input) {
      await db
        .update(webhookMrControlEffects)
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
    },
  }
}
