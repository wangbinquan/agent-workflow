// RFC-303 / RFC-349 — lease/retry worker for durable MR/PR terminal effects.
// The worker owns retry behavior; provider-specific lease/CAS persistence is
// supplied through an exact Promise port.
import { ulid } from 'ulid'

import type { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import type {
  MrControlEffectClaim,
  MrControlEffectStatus,
  MrTerminalEffectPersistencePort,
} from './ports/mrTerminalControlPersistence'
import type { TaskSourceTerminationParticipant } from '@/modules/task-execution/public/participants'
import type { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import { createLogger } from '@/util/log'

const log = createLogger('webhook-mr-terminal-control')
const LEASE_MS = 30_000
const RECOVERY_SCAN_MS = 5_000
const WAITING_RETRY_MS = 250
const MAX_BACKOFF_MS = 60_000

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
    private readonly persistence: MrTerminalEffectPersistencePort,
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
    this.running = this.drain()
      .catch((error: unknown) => {
        // `wake` is fire-and-forget (interval tick / webhook dispatch), so
        // nothing on the hot path awaits this promise. Without this handler a
        // drain failure becomes an unhandled rejection and takes the whole
        // daemon down — RFC-349 cutover reproduced exactly that when the
        // process-wide schema projection flipped under a still-armed worker.
        log.error('mr terminal control drain failed', { error: safeError(error) })
      })
      .finally(() => {
        this.running = null
        if (this.requested && !this.stopped) this.wake()
      })
  }

  /**
   * Re-arm a worker that a provider pause stopped. `stop` stays terminal for a
   * retired session; only the RFC-349 rollback path — the frozen source session
   * resuming after a failed cutover — revives this exact instance.
   */
  resume(): void {
    this.stopped = false
    this.start()
  }

  async reconcileOnBoot(): Promise<void> {
    await this.launchGuards.reconcileStaleOnBoot()
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
      await this.launchGuards.abortRevoked()
      await this.drainAllDue()
    } while (this.requested && !this.stopped)
  }

  private async drainAllDue(): Promise<void> {
    for (;;) {
      const effect = await this.claimNextDue()
      if (effect === null) return
      await this.applyClaimed(effect)
    }
  }

  private async claimNextDue(): Promise<MrControlEffectClaim | null> {
    return await this.persistence.claimNextDue({
      workerId: this.workerId,
      now: Date.now(),
      leaseMs: LEASE_MS,
    })
  }

  private async applyClaimed(effect: MrControlEffectClaim): Promise<void> {
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
      await this.launchGuards.abortRevoked()
      const first = await this.participant.apply(this.mintCapability(input), input)
      await this.persistReceipts(effect.id, first)

      if (await this.launchGuards.hasLaunchBarrier(effect.binding, effect.revision)) {
        await this.finishAttempt(effect.id, {
          status: 'waiting-launches',
          nextAttemptAt: Date.now() + WAITING_RETRY_MS,
          lastError: null,
        })
        return
      }

      // Fixed-point sweep after the guard barrier closes. A task committed in
      // the second-gate→INSERT seam is now guaranteed to be visible.
      const final = await this.participant.apply(this.mintCapability(input), input)
      await this.persistReceipts(effect.id, final)
      const releaseOutcomes = await this.persistence.listReleaseOutcomes(effect.id)
      if (releaseOutcomes.some((outcome) => outcome === 'unreaped')) {
        await this.finishAttempt(effect.id, {
          status: 'retryable',
          nextAttemptAt: Date.now() + retryDelay(effect.attemptCount),
          lastError: 'task-driver-unreaped',
        })
        return
      }
      await this.finishAttempt(effect.id, {
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
      await this.finishAttempt(effect.id, {
        status: 'retryable',
        nextAttemptAt: Date.now() + retryDelay(effect.attemptCount),
        lastError: message,
      })
    }
  }

  private async persistReceipts(effectId: string, receipts: readonly Receipt[]): Promise<void> {
    const now = Date.now()
    await this.persistence.recordReceipts(
      effectId,
      receipts.map((receipt) => ({
        taskId: receipt.taskId,
        priorStatus: receipt.priorStatus,
        fenceOutcome: receipt.fenceOutcome,
        cancelOutcome: receipt.cancelOutcome,
        releaseOutcome:
          receipt.releaseOutcome === 'not-required' ? 'no-active-owner' : receipt.releaseOutcome,
        errorCode: receipt.errorCode,
      })),
      now,
    )
  }

  private async finishAttempt(
    effectId: string,
    state: Readonly<{
      status: MrControlEffectStatus
      nextAttemptAt: number
      lastError: string | null
    }>,
  ): Promise<void> {
    await this.persistence.finishAttempt({
      effectId,
      workerId: this.workerId,
      ...state,
      now: Date.now(),
    })
    if (state.status === 'waiting-launches' || state.status === 'retryable') {
      const delay = Math.max(0, state.nextAttemptAt - Date.now())
      const timeout = setTimeout(() => this.wake(effectId), delay)
      timeout.unref?.()
    }
  }
}
