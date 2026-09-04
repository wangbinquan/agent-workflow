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
  /**
   * 两阶段停机（RFC-359 T7b 修订）：`release()` 只记下运行时的停机结果，`settle()` 才把它公布给
   * `awaitStopped` 的等待者。中间这段是 driver 在库里转移 owner 行的窗口——等待者（resume /
   * 取消 / webhook 终态控制 / 关机排空）要的都是「库里的 owner 已经不归它了」，早一步就会撞上
   * `already has owner state 'claimed'`。
   */
  stopResult: RuntimeStopResult | null
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
      stopResult: null,
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

  /**
   * 第一阶段：运行时已停（子进程 / 调度循环退出），记下停机结果并返回给释放序列。
   * 返回 null 表示 controller 不是现任、或已经释放过——过期 / 重复的 driver finally 不得再碰库。
   * 任务在 `settle()` 之前仍算在本进程手里：`hasTask` / `tokenForTask` 照旧、successor 的
   * `tryAttach` 仍被拒。
   */
  release(input: {
    token: OwnershipToken
    controller: AbortController
    result?: Readonly<{ kind: 'released' }> | Readonly<{ kind: 'unreaped'; code: string }>
  }): RuntimeStopResult | null {
    assertOwnershipToken(input.token)
    const key = ownershipTokenKey(input.token)
    const entry = this.entries.get(key)
    if (entry === undefined || entry.controller !== input.controller || entry.stopResult !== null) {
      return null
    }
    const base = input.result ?? { kind: 'released' as const }
    const result: RuntimeStopResult =
      base.kind === 'released'
        ? { kind: 'released', evidenceDigest: stopDigest(key, 'released') }
        : {
            kind: 'unreaped',
            code: base.code,
            evidenceDigest: stopDigest(key, 'unreaped', base.code),
          }
    entry.stopResult = result
    return result
  }

  /**
   * 第二阶段：库里的 owner 行已经转移（released / recovery-required / 被新 owner 围栏），
   * 把任务从本进程的索引里摘掉并唤醒 `awaitStopped` 的等待者。幂等；未 `release()` 的条目不动。
   */
  settle(token: OwnershipToken): void {
    assertOwnershipToken(token)
    const key = ownershipTokenKey(token)
    const entry = this.entries.get(key)
    if (entry === undefined || entry.stopResult === null) return
    this.entries.delete(key)
    if (this.taskIndex.get(token.taskId) === key) this.taskIndex.delete(token.taskId)
    this.completed.set(key, entry.stopResult)
    entry.resolveStopped(entry.stopResult)
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
      this.settle(entry.token)
    }
    this.entries.clear()
    this.taskIndex.clear()
    this.completed.clear()
    this.stopTombstones.clear()
  }
}
