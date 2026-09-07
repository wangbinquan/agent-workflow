// RFC-328 — the daemon-owned task-execution composition root.

import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import { TaskClaimGate } from './application/taskClaimGate'
import { SqliteTaskExecutionEffectStore } from './infrastructure/sqliteTaskExecutionEffect'
import { SqliteTaskExecutionIntentStore } from './infrastructure/sqliteTaskExecutionIntent'
import { SqliteTaskOwnershipStore } from './infrastructure/sqliteTaskOwnership'
import { InMemoryTaskRuntimeRegistry } from './infrastructure/inMemoryTaskRuntimeRegistry'
import type { RuntimeStopTicket } from './infrastructure/inMemoryTaskRuntimeRegistry'
import {
  createWorkerIdentity,
  type ClaimAttachPermit,
  type OwnershipToken,
} from './domain/ownership'
import type { TaskExecutionPersistence } from './application/ports/taskExecutionPersistence'

export const DEFAULT_OWNERSHIP_LEASE_MS = 60_000
export const DEFAULT_OWNERSHIP_HEARTBEAT_MS = 15_000

export interface ClaimedTaskExecution {
  readonly intentId: string
  readonly token: OwnershipToken
  readonly permit: ClaimAttachPermit
}

export class TaskExecutionModule {
  readonly moduleId = ulid()
  readonly claimGate: TaskClaimGate
  readonly runtimeRegistry: InMemoryTaskRuntimeRegistry
  readonly ownership = new SqliteTaskOwnershipStore()
  readonly intents = new SqliteTaskExecutionIntentStore()
  readonly effects = new SqliteTaskExecutionEffectStore(this.ownership)
  // RFC-359 W7：终态维护认领不再挂在这里。删除 / 归档 / workspace-GC 三条路径与两个 provider
  // 的组合根共用 `DrizzleTerminalMaintenancePersistence`（`createTerminalMaintenanceStore(db)`），
  // 因此这个进程级单例不再需要一个 bun:sqlite 专属的同步 store 成员。

  constructor(readonly daemonGeneration: string) {
    this.claimGate = new TaskClaimGate(daemonGeneration)
    this.runtimeRegistry = new InMemoryTaskRuntimeRegistry(this.claimGate)
  }

  claim(input: {
    db: DbClient
    intentId: string
    now?: number
    leaseMs?: number
  }): ClaimedTaskExecution {
    const permit = this.claimGate.enter()
    try {
      const token = this.ownership.claimPendingIntent({
        db: input.db,
        intentId: input.intentId,
        identity: createWorkerIdentity({
          ownerId: ulid(),
          daemonGeneration: this.daemonGeneration,
        }),
        now: input.now ?? Date.now(),
        leaseMs: input.leaseMs ?? DEFAULT_OWNERSHIP_LEASE_MS,
      })
      this.claimGate.bind(permit, token)
      return { intentId: input.intentId, token, permit }
    } catch (error) {
      this.claimGate.leave(permit)
      throw error
    }
  }

  seal(): void {
    this.claimGate.seal()
  }

  async awaitIdle(): Promise<void> {
    await this.claimGate.awaitIdle()
  }

  /** Reversible provider-session freeze: block claims, drain attach permits,
   * then stop the exact in-process runtimes. The module can be resumed without
   * replacing any HTTP or trigger references that capture it. */
  async pause(reason: string): Promise<readonly RuntimeStopTicket[]> {
    if (reason.length === 0) throw new Error('task execution module pause requires a reason')
    this.claimGate.pause()
    await this.awaitIdle()
    return this.runtimeRegistry.abortAll(reason)
  }

  resume(): void {
    this.claimGate.resume()
  }

  /** One-way daemon disposal: close admission, drain attach permits, stop exact handles. */
  async dispose(reason: string): Promise<readonly RuntimeStopTicket[]> {
    if (reason.length === 0) throw new Error('task execution module disposal requires a reason')
    this.seal()
    await this.awaitIdle()
    return this.runtimeRegistry.abortAll(reason)
  }

  /** Test isolation only; production disposal remains one-way. */
  resetForTesting(): void {
    this.runtimeRegistry.clearForTesting()
    this.claimGate.resetForTesting()
  }
}

/**
 * RFC-359 W5-T19b —— 持久化交齐之后的模块。
 *
 * 改造前 `persistence` 是基类上的一个**可选**构造参数，`claimPersisted` 进门先
 * `if (this.persistence === undefined) throw new Error('task-execution persistence is not composed')`。
 * 那是「装配未完成但已经可被调用」的典型形状：类型层完全合法，缺口只在运行到那一行时才炸，
 * 而两个 provider 的 daemon 跑到它的时机不一样——正是 RFC-359 W1-T1 修掉的那批
 * `*-not-bound` 的同族。
 *
 * 现在把它拆成两个类型：**要持久化认领的能力，就得先拿到一个持有持久化的模块**。基类不再有
 * 空槽（进程级单例与测试模块本来就没有持久化，它们走同步的 `claim(db)`），
 * `claimPersisted` 只长在这里，于是「没装配」在类型层不可表达，那句 throw 无处可写。
 */
export class ProviderTaskExecutionModule extends TaskExecutionModule {
  constructor(
    daemonGeneration: string,
    readonly persistence: TaskExecutionPersistence,
  ) {
    super(daemonGeneration)
  }

  async claimPersisted(input: {
    intentId: string
    now?: number
    leaseMs?: number
  }): Promise<ClaimedTaskExecution> {
    const permit = this.claimGate.enter()
    try {
      const token = await this.persistence.ownership.claimPendingIntent({
        intentId: input.intentId,
        identity: createWorkerIdentity({
          ownerId: ulid(),
          daemonGeneration: this.daemonGeneration,
        }),
        now: input.now ?? Date.now(),
        leaseMs: input.leaseMs ?? DEFAULT_OWNERSHIP_LEASE_MS,
      })
      this.claimGate.bind(permit, token)
      return { intentId: input.intentId, token, permit }
    } catch (error) {
      this.claimGate.leave(permit)
      throw error
    }
  }
}

// One production module per JS daemon generation.  Tests that need isolated
// registries call createTaskExecutionTestModule explicitly; production
// adapters only import this instance.
export const taskExecutionModule = new TaskExecutionModule(DAEMON_GENERATION)

export function createTaskExecutionTestModule(
  daemonGeneration: string = `test-${ulid()}`,
): TaskExecutionModule {
  return new TaskExecutionModule(daemonGeneration)
}

export function createProviderTaskExecutionModule(input: {
  readonly daemonGeneration: string
  readonly persistence: TaskExecutionPersistence
}): ProviderTaskExecutionModule {
  return new ProviderTaskExecutionModule(input.daemonGeneration, input.persistence)
}
