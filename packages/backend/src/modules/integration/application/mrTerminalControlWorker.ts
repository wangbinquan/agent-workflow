// RFC-303 / RFC-349 — lease/retry worker for durable MR/PR terminal effects.
// The worker owns retry behavior; provider-specific lease/CAS persistence is
// supplied through an exact Promise port.
import { ulid } from 'ulid'

import type { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import type {
  MrControlEffectClaim,
  MrControlEffectStatus,
  MrTerminalEffectAuthoritySettlementPort,
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
  private bootRunning: Promise<void> | null = null
  private requested = false
  private stopped = false
  private timer: ReturnType<typeof setInterval> | null = null
  private authorityQuiesced = false
  private authorityVersion = 0
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly pendingSettlements = new Set<() => Promise<void>>()

  constructor(
    private readonly persistence: MrTerminalEffectPersistencePort,
    private readonly launchGuards: MrLaunchGuardCoordinator,
    private readonly participant: TaskSourceTerminationParticipant,
    private readonly mintCapability: typeof mintSourceTerminationEffectCapability,
    private readonly canDispatch: () => boolean = () => true,
    private readonly authoritySettlement?: MrTerminalEffectAuthoritySettlementPort,
  ) {}

  private executionCurrent(version = this.authorityVersion): boolean {
    return (
      version === this.authorityVersion &&
      !this.authorityQuiesced &&
      this.pendingSettlements.size === 0 &&
      this.canDispatch()
    )
  }

  start(): void {
    if (this.stopped) return
    if (!this.executionCurrent()) return
    if (this.timer !== null) return
    this.timer = setInterval(() => this.wake(), RECOVERY_SCAN_MS)
    this.timer.unref?.()
  }

  wake(_effectId?: string | null): void {
    if (this.stopped || !this.executionCurrent()) return
    this.requested = true
    if (this.running !== null) return
    this.running = this.drain(this.authorityVersion)
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
    this.prepareAuthority()
    this.start()
  }

  /** Re-arm without a timer: the selected root still owes its boot barrier. */
  prepareAuthority(): void {
    if (this.authorityQuiesced && (this.running !== null || this.bootRunning !== null))
      throw new Error('mr-terminal-authority-loss-not-drained')
    if (this.pendingSettlements.size > 0) throw new Error('mr-terminal-settlement-not-drained')
    this.authorityQuiesced = false
    this.stopped = false
  }

  reconcileOnBoot(): Promise<void> {
    if (this.bootRunning !== null) return this.bootRunning
    const version = this.authorityVersion
    const attempt = (async () => {
      if (!this.executionCurrent(version)) return
      await this.launchGuards.reconcileStaleOnBoot()
      if (!this.executionCurrent(version)) return
      await this.drainAllDue(version)
      if (!this.executionCurrent(version)) return
      this.start()
    })()
    this.bootRunning = attempt
    void attempt.then(
      () => {
        if (this.bootRunning === attempt) this.bootRunning = null
      },
      () => {
        if (this.bootRunning === attempt) this.bootRunning = null
      },
    )
    return attempt
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.launchGuards.supervisor.abortAll()
    await this.running
    if (this.authoritySettlement !== undefined) {
      for (const timer of this.retryTimers) clearTimeout(timer)
      this.retryTimers.clear()
      await this.bootRunning
    }
  }

  /** Loss stops new control work without invoking normal launch cancellation. */
  quiesceAuthorityLoss(): void {
    this.authorityVersion += 1
    this.authorityQuiesced = true
    this.stopped = true
    this.requested = false
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
  }

  async drainAuthorityLoss(): Promise<void> {
    if (!this.authorityQuiesced) throw new Error('mr-terminal-authority-loss-drain-before-quiesce')
    await Promise.all([this.running, this.bootRunning])
    // Retry only the original receipt/claim ACK, never a task termination call.
    for (const settle of [...this.pendingSettlements]) await settle()
  }

  private async drain(version: number): Promise<void> {
    do {
      if (!this.executionCurrent(version)) return
      this.requested = false
      await this.launchGuards.abortRevoked(() => this.executionCurrent(version))
      if (!this.executionCurrent(version)) return
      await this.drainAllDue(version)
    } while (this.requested && !this.stopped)
  }

  private async drainAllDue(version: number): Promise<void> {
    for (;;) {
      if (this.authoritySettlement !== undefined && this.stopped) return
      if (!this.executionCurrent(version)) return
      const effect = await this.claimNextDue()
      if (effect === null) return
      if (!this.executionCurrent(version)) {
        if (this.authoritySettlement !== undefined) await this.deferClaim(effect, false)
        return
      }
      if (this.authoritySettlement === undefined) await this.applyClaimed(effect, version)
      else await this.applyAuthorityClaimed(effect, version)
    }
  }

  private async claimNextDue(): Promise<MrControlEffectClaim | null> {
    return await this.persistence.claimNextDue({
      workerId: this.workerId,
      now: Date.now(),
      leaseMs: LEASE_MS,
    })
  }

  private settle(work: () => Promise<void>): Promise<void> {
    const preceding = [...this.pendingSettlements]
    let done = false
    let running: Promise<void> | undefined
    const settle = (): Promise<void> => {
      if (done) return Promise.resolve()
      if (running !== undefined) return running
      running = Promise.resolve()
        .then(async () => {
          for (const prior of preceding) await prior()
          await work()
          done = true
          this.pendingSettlements.delete(settle)
        })
        .finally(() => {
          running = undefined
        })
      return running
    }
    this.pendingSettlements.add(settle)
    return settle()
  }

  private finishAuthorityClaim(
    effect: MrControlEffectClaim,
    state: {
      status: Exclude<MrControlEffectStatus, 'leased'>
      nextAttemptAt: number
      lastError: string | null
    },
  ): Promise<void> {
    const port = this.authoritySettlement
    if (port === undefined) throw new Error('mr-terminal-authority-settlement-missing')
    const settle = port.settleClaim.bind(port)
    const input = { claim: effect, workerId: this.workerId, ...state, now: Date.now() }
    const version = this.authorityVersion
    return this.settle(() => settle(input)).then(() =>
      this.scheduleRetry(effect.id, version, state),
    )
  }

  private deferClaim(effect: MrControlEffectClaim, issued: boolean): Promise<void> {
    return this.finishAuthorityClaim(effect, {
      status: issued ? 'retryable' : 'pending',
      nextAttemptAt: Date.now(),
      lastError: issued ? 'host-execution-quiesced' : null,
    })
  }

  /** Same business sweeps, with explicit intake for each exact admitted claim. */
  private async applyAuthorityClaimed(
    effect: MrControlEffectClaim,
    version: number,
  ): Promise<void> {
    let issued = false
    let settling = false
    const finish = (state: Parameters<MrTerminalControlWorker['finishAuthorityClaim']>[1]) => {
      settling = true
      return this.finishAuthorityClaim(effect, state)
    }
    const defer = () =>
      finish({
        status: issued ? 'retryable' : 'pending',
        nextAttemptAt: Date.now(),
        lastError: issued ? 'host-execution-quiesced' : null,
      })
    const proceed = async () => {
      if (this.executionCurrent(version)) return true
      await defer()
      return false
    }
    const input = {
      effectId: effect.id,
      binding: effect.binding,
      streamRevision: effect.revision,
      kind: effect.kind,
      deliveryId: effect.deliveryId,
    } as const
    try {
      if (!(await proceed())) return
      await this.launchGuards.abortRevoked(() => this.executionCurrent(version))
      if (!(await proceed())) return
      // No await separates this fence from the original external-effect call.
      if (!this.executionCurrent(version)) {
        await defer()
        return
      }
      issued = true
      const first = await this.participant.apply(this.mintCapability(input), input)
      await this.settle(() => this.persistReceipts(effect.id, first))
      if (!(await proceed())) return
      const waiting = await this.launchGuards.hasLaunchBarrier(effect.binding, effect.revision)
      if (!(await proceed())) return
      if (waiting) {
        await finish({
          status: 'waiting-launches',
          nextAttemptAt: Date.now() + WAITING_RETRY_MS,
          lastError: null,
        })
        return
      }
      if (!this.executionCurrent(version)) {
        await defer()
        return
      }
      const final = await this.participant.apply(this.mintCapability(input), input)
      await this.settle(() => this.persistReceipts(effect.id, final))
      if (!(await proceed())) return
      const outcomes = await this.persistence.listReleaseOutcomes(effect.id)
      if (!(await proceed())) return
      const unreaped = outcomes.some((outcome) => outcome === 'unreaped')
      await finish({
        status: unreaped ? 'retryable' : 'succeeded',
        nextAttemptAt: Date.now() + (unreaped ? retryDelay(effect.attemptCount) : 0),
        lastError: unreaped ? 'task-driver-unreaped' : null,
      })
    } catch (error) {
      // Retained receipt writes precede this settlement, including on retry.
      // Failure to persist either remains an unacknowledged drain.
      if (settling) throw error
      await finish({
        status: 'retryable',
        nextAttemptAt: Date.now() + retryDelay(effect.attemptCount),
        lastError: safeError(error),
      })
    }
  }

  private async applyClaimed(effect: MrControlEffectClaim, version: number): Promise<void> {
    if (!this.executionCurrent(version)) return
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
      await this.launchGuards.abortRevoked(() => this.executionCurrent(version))
      if (!this.executionCurrent(version)) return
      const first = await this.participant.apply(this.mintCapability(input), input)
      await this.persistReceipts(effect.id, first)
      if (!this.executionCurrent(version)) return

      const waitingLaunches = await this.launchGuards.hasLaunchBarrier(
        effect.binding,
        effect.revision,
      )
      if (!this.executionCurrent(version)) return
      if (waitingLaunches) {
        await this.finishAttempt(effect.id, version, {
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
      if (!this.executionCurrent(version)) return
      const releaseOutcomes = await this.persistence.listReleaseOutcomes(effect.id)
      if (!this.executionCurrent(version)) return
      if (releaseOutcomes.some((outcome) => outcome === 'unreaped')) {
        await this.finishAttempt(effect.id, version, {
          status: 'retryable',
          nextAttemptAt: Date.now() + retryDelay(effect.attemptCount),
          lastError: 'task-driver-unreaped',
        })
        return
      }
      await this.finishAttempt(effect.id, version, {
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
      if (!this.executionCurrent(version)) return
      await this.finishAttempt(effect.id, version, {
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
    version: number,
    state: Readonly<{
      status: MrControlEffectStatus
      nextAttemptAt: number
      lastError: string | null
    }>,
  ): Promise<void> {
    if (!this.executionCurrent(version)) return
    await this.persistence.finishAttempt({
      effectId,
      workerId: this.workerId,
      ...state,
      now: Date.now(),
    })
    this.scheduleRetry(effectId, version, state)
  }

  private scheduleRetry(
    effectId: string,
    version: number,
    state: {
      status: MrControlEffectStatus
      nextAttemptAt: number
    },
  ): void {
    if (
      this.executionCurrent(version) &&
      (state.status === 'waiting-launches' || state.status === 'retryable')
    ) {
      const delay = Math.max(0, state.nextAttemptAt - Date.now())
      const timeout = setTimeout(() => {
        this.retryTimers.delete(timeout)
        this.wake(effectId)
      }, delay)
      this.retryTimers.add(timeout)
      timeout.unref?.()
    }
  }
}
