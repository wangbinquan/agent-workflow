import { sha256Hex } from '../domain/digest'
import type { TaskStopCause } from '../domain/sourceTermination'
import {
  assertClaimAttachPermit,
  assertOwnershipToken,
  ownershipTokenKey,
  type ClaimAttachPermit,
  type OwnershipTuple,
  type OwnershipToken,
} from '../domain/ownership'
import type { TaskClaimGate } from '../application/taskClaimGate'

export type RuntimeStopResult =
  | Readonly<{ kind: 'released'; evidenceDigest: string }>
  | Readonly<{ kind: 'unreaped'; code: string; evidenceDigest: string }>

export interface RuntimeStopTicket {
  readonly token: OwnershipToken
  readonly tokenKey: string
}

interface RuntimeEntry {
  readonly token: OwnershipToken
  readonly intentId: string
  readonly controller: AbortController
  readonly stopped: Promise<RuntimeStopResult>
  readonly resolveStopped: (result: RuntimeStopResult) => void
}

function stopDigest(tokenKey: string, result: 'released' | 'unreaped', code?: string): string {
  return sha256Hex(`${tokenKey}\u0000${result}\u0000${code ?? ''}`)
}

/** Process-local handle cache.  Authorization always comes from the token. */
export class InMemoryTaskRuntimeRegistry {
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly taskIndex = new Map<string, string>()
  private readonly completed = new Map<string, RuntimeStopResult>()
  private readonly stopTombstones = new Map<string, TaskStopCause | string>()

  constructor(private readonly gate: TaskClaimGate) {}

  tryAttach(input: {
    token: OwnershipToken
    intentId: string
    permit: ClaimAttachPermit
    controller: AbortController
  }): 'attached' | 'rejected-stopped' | 'rejected-successor-present' {
    assertOwnershipToken(input.token)
    assertClaimAttachPermit(input.permit)
    this.gate.assertBound(input.permit, input.token)
    const key = ownershipTokenKey(input.token)
    if (this.stopTombstones.has(key)) {
      input.controller.abort(this.stopTombstones.get(key))
      return 'rejected-stopped'
    }
    const current = this.taskIndex.get(input.token.taskId)
    if (current !== undefined && current !== key) return 'rejected-successor-present'
    if (this.entries.has(key)) return 'rejected-successor-present'
    let resolveStopped: (result: RuntimeStopResult) => void = () => {}
    const stopped = new Promise<RuntimeStopResult>((resolve) => {
      resolveStopped = resolve
    })
    this.entries.set(key, {
      token: input.token,
      intentId: input.intentId,
      controller: input.controller,
      stopped,
      resolveStopped,
    })
    this.taskIndex.set(input.token.taskId, key)
    this.completed.delete(key)
    return 'attached'
  }

  requestStop(token: OwnershipToken, cause: TaskStopCause | string): RuntimeStopTicket {
    assertOwnershipToken(token)
    const key = ownershipTokenKey(token)
    // Sticky first: a later attach for the same exact durable claim observes it.
    this.stopTombstones.set(key, cause)
    this.entries.get(key)?.controller.abort(cause)
    return { token, tokenKey: key }
  }

  async awaitStopped(ticket: RuntimeStopTicket): Promise<RuntimeStopResult> {
    assertOwnershipToken(ticket.token)
    if (ticket.tokenKey !== ownershipTokenKey(ticket.token)) {
      throw new Error('runtime stop ticket token mismatch')
    }
    await this.gate.awaitTokenIdle(ticket.token)
    const entry = this.entries.get(ticket.tokenKey)
    if (entry !== undefined) return entry.stopped
    return (
      this.completed.get(ticket.tokenKey) ?? {
        kind: 'released',
        evidenceDigest: stopDigest(ticket.tokenKey, 'released'),
      }
    )
  }

  release(input: {
    token: OwnershipToken
    controller: AbortController
    result?: Readonly<{ kind: 'released' }> | Readonly<{ kind: 'unreaped'; code: string }>
  }): boolean {
    assertOwnershipToken(input.token)
    const key = ownershipTokenKey(input.token)
    const entry = this.entries.get(key)
    if (entry === undefined || entry.controller !== input.controller) return false
    const base = input.result ?? { kind: 'released' as const }
    const result: RuntimeStopResult =
      base.kind === 'released'
        ? { kind: 'released', evidenceDigest: stopDigest(key, 'released') }
        : {
            kind: 'unreaped',
            code: base.code,
            evidenceDigest: stopDigest(key, 'unreaped', base.code),
          }
    this.entries.delete(key)
    if (this.taskIndex.get(input.token.taskId) === key) this.taskIndex.delete(input.token.taskId)
    this.completed.set(key, result)
    entry.resolveStopped(result)
    return true
  }

  tokenForTask(taskId: string): OwnershipToken | null {
    const key = this.taskIndex.get(taskId)
    return key === undefined ? null : (this.entries.get(key)?.token ?? null)
  }

  tokenForOwner(owner: OwnershipTuple): OwnershipToken | null {
    const key = `${owner.taskId}\u0000${owner.ownerId}\u0000${owner.daemonGeneration}\u0000${owner.epoch}`
    return this.entries.get(key)?.token ?? this.gate.tokenForKey(key)
  }

  controllerFor(token: OwnershipToken): AbortController | null {
    assertOwnershipToken(token)
    return this.entries.get(ownershipTokenKey(token))?.controller ?? null
  }

  intentFor(token: OwnershipToken): string | null {
    assertOwnershipToken(token)
    return this.entries.get(ownershipTokenKey(token))?.intentId ?? null
  }

  hasTask(taskId: string): boolean {
    return this.taskIndex.has(taskId)
  }

  activeTokens(): readonly OwnershipToken[] {
    return [...this.entries.values()].map((entry) => entry.token)
  }

  abortAll(cause: string): readonly RuntimeStopTicket[] {
    if (cause.length === 0) throw new Error('abortAll requires an explicit shutdown reason')
    return this.activeTokens().map((token) => this.requestStop(token, cause))
  }

  clearForTesting(): void {
    for (const entry of [...this.entries.values()]) {
      this.release({ token: entry.token, controller: entry.controller })
    }
    this.entries.clear()
    this.taskIndex.clear()
    this.completed.clear()
    this.stopTombstones.clear()
  }
}
