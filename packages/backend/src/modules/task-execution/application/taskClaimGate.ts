import { ulid } from 'ulid'
import {
  assertClaimAttachPermit,
  assertOwnershipToken,
  createClaimAttachPermit,
  ownershipTokenKey,
  type ClaimAttachPermit,
  type OwnershipToken,
} from '../domain/ownership'
import { TaskExecutionError } from './taskExecutionError'

interface PermitState {
  readonly permit: ClaimAttachPermit
  tokenKey: string | null
  token: OwnershipToken | null
}

/**
 * Closes the claim-commit → runtime-attach gap.  A permit is held from before
 * the durable claim until attach or explicit compensation is complete.
 */
export class TaskClaimGate {
  private readonly permits = new Map<string, PermitState>()
  private sealed = false
  private paused = false
  private idleWaiters = new Set<() => void>()
  private readonly tokenWaiters = new Map<string, Set<() => void>>()

  constructor(readonly generation: string) {}

  enter(): ClaimAttachPermit {
    if (this.sealed || this.paused) {
      throw new TaskExecutionError(
        'task-execution-shutting-down',
        this.sealed
          ? 'task execution admission is sealed for daemon shutdown'
          : 'task execution admission is paused for provider-session freeze',
      )
    }
    const permit = createClaimAttachPermit({ gateGeneration: this.generation, permitId: ulid() })
    this.permits.set(permit.permitId, { permit, tokenKey: null, token: null })
    return permit
  }

  bind(permit: ClaimAttachPermit, token: OwnershipToken): void {
    assertClaimAttachPermit(permit)
    assertOwnershipToken(token)
    const state = this.permits.get(permit.permitId)
    if (state?.permit !== permit || permit.gateGeneration !== this.generation) {
      throw new Error('claim-attach permit is not active in this gate')
    }
    if (state.tokenKey !== null) throw new Error('claim-attach permit is already bound')
    state.tokenKey = ownershipTokenKey(token)
    state.token = token
  }

  assertBound(permit: ClaimAttachPermit, token: OwnershipToken): void {
    assertClaimAttachPermit(permit)
    assertOwnershipToken(token)
    const state = this.permits.get(permit.permitId)
    if (state?.permit !== permit || state.tokenKey !== ownershipTokenKey(token)) {
      throw new Error('claim-attach permit does not bind this exact token')
    }
  }

  leave(permit: ClaimAttachPermit): void {
    assertClaimAttachPermit(permit)
    const state = this.permits.get(permit.permitId)
    if (state?.permit !== permit) return
    this.permits.delete(permit.permitId)
    if (state.tokenKey !== null && !this.hasTokenPermit(state.tokenKey)) {
      const waiters = this.tokenWaiters.get(state.tokenKey)
      this.tokenWaiters.delete(state.tokenKey)
      for (const resolve of waiters ?? []) resolve()
    }
    if (this.permits.size === 0) {
      const waiters = this.idleWaiters
      this.idleWaiters = new Set()
      for (const resolve of waiters) resolve()
    }
  }

  seal(): void {
    this.sealed = true
    this.paused = true
  }

  get isSealed(): boolean {
    return this.sealed
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Reversible provider-session admission freeze. Existing permits drain. */
  pause(): void {
    if (this.sealed) {
      throw new TaskExecutionError(
        'task-execution-shutting-down',
        'task execution admission is sealed for daemon shutdown',
      )
    }
    this.paused = true
  }

  /** Reopen a provider session after a successful rollback or resume. */
  resume(): void {
    if (this.sealed) {
      throw new TaskExecutionError(
        'task-execution-shutting-down',
        'task execution admission is sealed for daemon shutdown',
      )
    }
    this.paused = false
  }

  /** Test isolation only; a production daemon never reopens after shutdown. */
  resetForTesting(): void {
    if (this.permits.size !== 0) throw new Error('cannot reset a non-idle claim gate')
    this.sealed = false
    this.paused = false
    this.idleWaiters.clear()
    this.tokenWaiters.clear()
  }

  async awaitIdle(): Promise<void> {
    if (this.permits.size === 0) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  async awaitTokenIdle(token: OwnershipToken): Promise<void> {
    assertOwnershipToken(token)
    const key = ownershipTokenKey(token)
    if (!this.hasTokenPermit(key)) return
    await new Promise<void>((resolve) => {
      const waiters = this.tokenWaiters.get(key) ?? new Set<() => void>()
      waiters.add(resolve)
      this.tokenWaiters.set(key, waiters)
    })
  }

  tokenForKey(tokenKey: string): OwnershipToken | null {
    for (const state of this.permits.values()) {
      if (state.tokenKey === tokenKey) return state.token
    }
    return null
  }

  private hasTokenPermit(tokenKey: string): boolean {
    for (const state of this.permits.values()) {
      if (state.tokenKey === tokenKey) return true
    }
    return false
  }
}
