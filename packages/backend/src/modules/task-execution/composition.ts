// RFC-328 — the daemon-owned task-execution composition root.

import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import { TaskClaimGate } from './application/taskClaimGate'
import { SqliteTaskExecutionEffectStore } from './infrastructure/sqliteTaskExecutionEffect'
import { SqliteTaskExecutionIntentStore } from './infrastructure/sqliteTaskExecutionIntent'
import { SqliteTaskOwnershipStore } from './infrastructure/sqliteTaskOwnership'
import { SqliteTerminalMaintenanceStore } from './infrastructure/sqliteTerminalMaintenance'
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
  readonly terminalMaintenance = new SqliteTerminalMaintenanceStore()

  constructor(
    readonly daemonGeneration: string,
    readonly persistence?: TaskExecutionPersistence,
  ) {
    this.claimGate = new TaskClaimGate(daemonGeneration)
    this.runtimeRegistry = new InMemoryTaskRuntimeRegistry(this.claimGate)
  }

  async claimPersisted(input: {
    intentId: string
    now?: number
    leaseMs?: number
  }): Promise<ClaimedTaskExecution> {
    if (this.persistence === undefined) {
      throw new Error('task-execution persistence is not composed')
    }
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
}): TaskExecutionModule {
  return new TaskExecutionModule(input.daemonGeneration, input.persistence)
}
