// RFC-303 — lease/retry worker for durable MR/PR terminal effects.
import { and, asc, eq, inArray, lt, lte, ne, or } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import {
  webhookMrControlEffects,
  webhookMrControlTargets,
  webhookMrLaunchGuards,
} from '@/db/schema'
import type { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import type { TaskSourceTerminationParticipant } from '@/modules/task-execution/public/participants'
import type { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import { createLogger } from '@/util/log'

const log = createLogger('webhook-mr-terminal-control')
const LEASE_MS = 30_000
const RECOVERY_SCAN_MS = 5_000
const WAITING_RETRY_MS = 250
const MAX_BACKOFF_MS = 60_000

type EffectRow = typeof webhookMrControlEffects.$inferSelect
type Receipt = Awaited<ReturnType<TaskSourceTerminationParticipant['apply']>>[number]

function retryDelay(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(10, Math.max(0, attempt - 1)))
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/(?:https?:\/\/)[^\s]+/gi, '[redacted-url]').slice(0, 1000)
}

export class MrTerminalControlWorker {
  private readonly workerId = `mr-control-${ulid()}`
  private running: Promise<void> | null = null
  private requested = false
  private stopped = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly db: DbClient,
    private readonly launchGuards: MrLaunchGuardCoordinator,
    private readonly participant: TaskSourceTerminationParticipant,
    private readonly mintCapability: typeof mintSourceTerminationEffectCapability,
  ) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.wake(), RECOVERY_SCAN_MS)
    this.timer.unref?.()
  }

  wake(_effectId?: string | null): void {
    if (this.stopped) return
    this.requested = true
    if (this.running !== null) return
    this.running = this.drain().finally(() => {
      this.running = null
      if (this.requested && !this.stopped) this.wake()
    })
  }

  async reconcileOnBoot(): Promise<void> {
    this.launchGuards.reconcileStaleOnBoot()
    await this.drainAllDue()
    this.start()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.launchGuards.supervisor.abortAll()
    await this.running
  }

  private async drain(): Promise<void> {
    do {
      this.requested = false
      this.launchGuards.abortRevoked()
      await this.drainAllDue()
    } while (this.requested && !this.stopped)
  }

  private async drainAllDue(): Promise<void> {
    for (;;) {
      const effect = this.claimNextDue()
      if (effect === null) return
      await this.applyClaimed(effect)
    }
  }

  private claimNextDue(): EffectRow | null {
    const now = Date.now()
    const candidates = this.db
      .select()
      .from(webhookMrControlEffects)
      .where(
        and(
          ne(webhookMrControlEffects.status, 'succeeded'),
          lte(webhookMrControlEffects.nextAttemptAt, now),
          or(
            inArray(webhookMrControlEffects.status, ['pending', 'waiting-launches', 'retryable']),
            and(
              eq(webhookMrControlEffects.status, 'leased'),
              lte(webhookMrControlEffects.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(asc(webhookMrControlEffects.createdAt), asc(webhookMrControlEffects.revision))
      .all()

    for (const candidate of candidates) {
      const older = this.db
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
        .all()[0]
      if (older !== undefined) continue
      const claimed = this.db
        .update(webhookMrControlEffects)
        .set({
          status: 'leased',
          leaseOwner: this.workerId,
          leaseExpiresAt: now + LEASE_MS,
          attemptCount: candidate.attemptCount + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(webhookMrControlEffects.id, candidate.id),
            ne(webhookMrControlEffects.status, 'succeeded'),
          ),
        )
        .returning()
        .all()[0]
      if (claimed !== undefined) return claimed
    }
    return null
  }

  private async applyClaimed(effect: EffectRow): Promise<void> {
    const input = {
      effectId: effect.id,
      binding: effect.binding,
      streamRevision: effect.revision,
      kind: effect.kind,
      deliveryId: effect.deliveryId,
    } as const
    try {
      // Stop visible tasks immediately; a slow pre-task launch must not delay
      // cancellation of work that already has an execution owner.
      this.launchGuards.abortRevoked()
      const first = await this.participant.apply(this.mintCapability(input), input)
      this.persistReceipts(effect.id, first)

      const barrier = this.db
        .select({ id: webhookMrLaunchGuards.id })
        .from(webhookMrLaunchGuards)
        .where(
          and(
            eq(webhookMrLaunchGuards.binding, effect.binding),
            lt(webhookMrLaunchGuards.launchRevision, effect.revision),
            inArray(webhookMrLaunchGuards.status, [
              'reserved',
              'launching',
              'revoking-terminal',
              'task-committed',
            ]),
          ),
        )
        .limit(1)
        .all()[0]
      if (barrier !== undefined) {
        this.finishAttempt(effect.id, {
          status: 'waiting-launches',
          nextAttemptAt: Date.now() + WAITING_RETRY_MS,
          lastError: null,
        })
        return
      }

      // Fixed-point sweep after the guard barrier closes. A task committed in
      // the second-gate→INSERT seam is now guaranteed to be visible.
      const final = await this.participant.apply(this.mintCapability(input), input)
      this.persistReceipts(effect.id, final)
      const all = this.db
        .select({ releaseOutcome: webhookMrControlTargets.releaseOutcome })
        .from(webhookMrControlTargets)
        .where(eq(webhookMrControlTargets.effectId, effect.id))
        .all()
      if (all.some((target) => target.releaseOutcome === 'unreaped')) {
        this.finishAttempt(effect.id, {
          status: 'retryable',
          nextAttemptAt: Date.now() + retryDelay(effect.attemptCount),
          lastError: 'task-driver-unreaped',
        })
        return
      }
      this.finishAttempt(effect.id, {
        status: 'succeeded',
        nextAttemptAt: Date.now(),
        lastError: null,
      })
    } catch (error) {
      const message = safeError(error)
      log.warn('terminal control attempt failed; retrying', {
        effectId: effect.id,
        attempt: effect.attemptCount,
        error: message,
      })
      this.finishAttempt(effect.id, {
        status: 'retryable',
        nextAttemptAt: Date.now() + retryDelay(effect.attemptCount),
        lastError: message,
      })
    }
  }

  private persistReceipts(effectId: string, receipts: readonly Receipt[]): void {
    const now = Date.now()
    for (const receipt of receipts) {
      const releaseOutcome =
        receipt.releaseOutcome === 'not-required' ? 'no-active-owner' : receipt.releaseOutcome
      this.db
        .insert(webhookMrControlTargets)
        .values({
          effectId,
          taskId: receipt.taskId,
          priorStatus: receipt.priorStatus,
          fenceOutcome: receipt.fenceOutcome,
          cancelOutcome: receipt.cancelOutcome,
          releaseOutcome,
          error: receipt.errorCode,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [webhookMrControlTargets.effectId, webhookMrControlTargets.taskId],
          set: {
            // The first sweep owns the durable cancellation/fence audit.  The
            // fixed-point sweep may observe the same row after it has already
            // become terminal; it may refine release settlement, but must not
            // rewrite `canceled` into `already-terminal`.
            releaseOutcome,
            error: receipt.errorCode,
            updatedAt: now,
          },
        })
        .run()
    }
  }

  private finishAttempt(
    effectId: string,
    state: Pick<EffectRow, 'status' | 'nextAttemptAt' | 'lastError'>,
  ): void {
    this.db
      .update(webhookMrControlEffects)
      .set({
        ...state,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(webhookMrControlEffects.id, effectId),
          eq(webhookMrControlEffects.leaseOwner, this.workerId),
        ),
      )
      .run()
    if (state.status === 'waiting-launches' || state.status === 'retryable') {
      const delay = Math.max(0, state.nextAttemptAt - Date.now())
      const timeout = setTimeout(() => this.wake(effectId), delay)
      timeout.unref?.()
    }
  }
}
