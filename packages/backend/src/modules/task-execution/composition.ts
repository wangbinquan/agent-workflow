// RFC-328 — the daemon-owned task-execution composition root.

import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import { TaskClaimGate } from './application/taskClaimGate'
import { DrizzleTaskOwnershipPersistence } from './infrastructure/taskOwnershipPersistence'
import { InMemoryTaskRuntimeRegistry } from './infrastructure/inMemoryTaskRuntimeRegistry'
import type { RuntimeStopTicket } from './infrastructure/inMemoryTaskRuntimeRegistry'
import {
  createWorkerIdentity,
  type ClaimAttachPermit,
  type OwnershipToken,
} from './domain/ownership'
import type { TaskExecutionPersistence } from './application/ports/taskExecutionPersistence'
import type { TaskOwnershipPersistence } from './application/ports/taskOwnershipPersistence'

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
  // RFC-359 W7：终态维护认领不再挂在这里。删除 / 归档 / workspace-GC 三条路径与两个 provider
  // 的组合根共用 `DrizzleTerminalMaintenancePersistence`（`createTerminalMaintenanceStore(db)`），
  // 因此这个进程级单例不再需要一个 bun:sqlite 专属的同步 store 成员。

  /**
   * RFC-359 —— 归属写面**只有一份**：`DrizzleTaskOwnershipPersistence`，两个引擎共用。
   * 此前这里还挂着一个 bun:sqlite 专属的同步 `SqliteTaskOwnershipStore` 进程级单例（签名吃
   * `DbClient`、方法同步返回），`services/task.ts` 与 `taskDriverLifecycle.ts` 各自从它取
   * `read` / `revokeExact` / `markRecoveryRequired` / `heartbeat`。同一件事两份实现，正是本 RFC
   * 要消灭的形态；现在统一从这里按库取中立那份（PG 侧的驱动生命周期本来就是这个形状）。
   */
  ownershipFor(db: ProviderNeutralDatabase): TaskOwnershipPersistence {
    return new DrizzleTaskOwnershipPersistence(db)
  }

  constructor(readonly daemonGeneration: string) {
    this.claimGate = new TaskClaimGate(daemonGeneration)
    this.runtimeRegistry = new InMemoryTaskRuntimeRegistry(this.claimGate)
  }

  /**
   * RFC-359 —— 认领走**中立**归属持久化（`DrizzleTaskOwnershipPersistence`），不再经同步 store。
   * 那是同步事务面最后一个 `dbTxSync` 调用点；两份实现的判据逐条相同
   * （intent 必须 pending、任务不在终态维护认领里、owner 转移表裁决、epoch/revision 递增），
   * 中立那份把事务形态换成 `databaseSessionFor(db).serializable`——每任务至多一个活跃 owner、
   * 每任务至多一条 pending·claimed intent 都是跨行谓词，沿用 SERIALIZABLE 是对的。
   *
   * 代价是本方法从同步变成 async：生产唯一调用方 `taskDriverLifecycle.ts` 本来就在 async 里，
   * 夹具按调用点补 await。
   */
  async claim(input: {
    db: ProviderNeutralDatabase
    intentId: string
    now?: number
    leaseMs?: number
  }): Promise<ClaimedTaskExecution> {
    const permit = this.claimGate.enter()
    try {
      const token = await this.ownershipFor(input.db).claimPendingIntent({
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
