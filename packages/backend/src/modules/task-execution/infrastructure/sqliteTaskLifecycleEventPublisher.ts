import { and, asc, eq, lte, or } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { taskLifecycleEventOutbox } from '@/db/schema'
import type { EventObservationParticipant } from '@/modules/event-center/public/participants'
import type { EventObservationInput } from '@/modules/event-center/public/types'

function changes(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}

export interface TaskLifecycleEventPublisher {
  runOne(): Promise<'completed' | 'retried' | 'dead-letter' | 'idle'>
}

/**
 * Drains the task-owned outbox into the public Event Center command. A retry
 * republishes the same dedupe key, so EventRecord and every subscriber
 * delivery remain idempotent.
 */
export function createSqliteTaskLifecycleEventPublisher(input: {
  readonly db: DbClient
  readonly events: EventObservationParticipant
  readonly retryLimits: () => {
    readonly defaultNodeRetries: number
    readonly sessionRestartBudget: number
  }
  readonly workerId?: string
  readonly now?: () => number
  readonly leaseMs?: number
}): TaskLifecycleEventPublisher {
  const now = input.now ?? Date.now
  const workerId = input.workerId ?? `task-lifecycle-${process.pid}`
  const leaseMs = input.leaseMs ?? 60_000

  return {
    async runOne() {
      const claimed = input.db.transaction((tx) => {
        const at = now()
        const candidate = tx
          .select()
          .from(taskLifecycleEventOutbox)
          .where(
            and(
              lte(taskLifecycleEventOutbox.nextAttemptAt, at),
              or(
                eq(taskLifecycleEventOutbox.state, 'pending'),
                and(
                  eq(taskLifecycleEventOutbox.state, 'claimed'),
                  lte(taskLifecycleEventOutbox.claimExpiresAt, at),
                ),
              ),
            ),
          )
          .orderBy(asc(taskLifecycleEventOutbox.createdAt), asc(taskLifecycleEventOutbox.id))
          .limit(1)
          .get()
        if (candidate === undefined) return null
        const result = tx
          .update(taskLifecycleEventOutbox)
          .set({
            state: 'claimed',
            claimedBy: workerId,
            claimExpiresAt: at + leaseMs,
            attemptCount: candidate.attemptCount + 1,
          })
          .where(
            and(
              eq(taskLifecycleEventOutbox.id, candidate.id),
              eq(taskLifecycleEventOutbox.state, candidate.state),
              eq(taskLifecycleEventOutbox.attemptCount, candidate.attemptCount),
            ),
          )
          .run()
        return changes(result) === 1
          ? { ...candidate, attemptCount: candidate.attemptCount + 1 }
          : null
      })
      if (claimed === null) return 'idle'

      try {
        input.events.observe(JSON.parse(claimed.observationJson) as EventObservationInput)
        const result = input.db
          .update(taskLifecycleEventOutbox)
          .set({
            state: 'completed',
            claimedBy: null,
            claimExpiresAt: null,
            lastError: null,
            completedAt: now(),
          })
          .where(
            and(
              eq(taskLifecycleEventOutbox.id, claimed.id),
              eq(taskLifecycleEventOutbox.state, 'claimed'),
              eq(taskLifecycleEventOutbox.claimedBy, workerId),
            ),
          )
          .run()
        if (changes(result) !== 1)
          throw new Error(`task lifecycle outbox lease lost: ${claimed.id}`)
        return 'completed'
      } catch (error) {
        const limits = input.retryLimits()
        const maxAttempts =
          1 +
          Math.max(0, Math.trunc(limits.defaultNodeRetries)) +
          Math.max(0, Math.trunc(limits.sessionRestartBudget))
        const terminal = claimed.attemptCount >= maxAttempts
        const at = now()
        const result = input.db
          .update(taskLifecycleEventOutbox)
          .set({
            state: terminal ? 'dead-letter' : 'pending',
            claimedBy: null,
            claimExpiresAt: null,
            nextAttemptAt: terminal
              ? at
              : at + Math.min(30_000, 1_000 * 2 ** Math.max(0, claimed.attemptCount - 1)),
            lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
            ...(terminal ? { deadLetterAt: at } : {}),
          })
          .where(
            and(
              eq(taskLifecycleEventOutbox.id, claimed.id),
              eq(taskLifecycleEventOutbox.state, 'claimed'),
              eq(taskLifecycleEventOutbox.claimedBy, workerId),
            ),
          )
          .run()
        if (changes(result) !== 1)
          throw new Error(`task lifecycle outbox lease lost: ${claimed.id}`)
        return terminal ? 'dead-letter' : 'retried'
      }
    },
  }
}
