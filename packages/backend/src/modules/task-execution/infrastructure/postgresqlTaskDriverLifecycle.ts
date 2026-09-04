import { eq } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  TaskDriveAttachOutcome,
  TaskDriverLifecyclePort,
} from '../application/drive/taskDriveCoordinator'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type { TaskExecutionModule } from '../composition'
import { createTaskExecutionContext } from '../application/taskExecutionContext'
import { ownershipTokenKey, type OwnershipToken } from '../domain/ownership'
import {
  releaseTaskDriverAndFinalize,
  type TaskDriverReleaseDependencies,
} from './taskDriverRelease'

const OWNER_LEASE_MS = 60_000
const OWNER_HEARTBEAT_MS = 15_000

export interface PostgresqlTaskDriverLifecycleOptions {
  readonly db: PostgresqlDatabaseClient
  readonly module: TaskExecutionModule
  readonly persistence: TaskExecutionPersistence
  readonly log: TaskExecutionTopologyLogger
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
}

/**
 * PostgreSQL's async claim/attach/release boundary.  The exact same in-memory
 * registry instance is shared with cancellation and activity participants;
 * durable ownership is always changed through the selected PostgreSQL
 * persistence aggregate.
 */
export function createPostgresqlTaskDriverLifecyclePort(
  options: PostgresqlTaskDriverLifecycleOptions,
): TaskDriverLifecyclePort {
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()

  const startHeartbeat = (token: OwnershipToken, controller: AbortController): void => {
    const key = ownershipTokenKey(token)
    const previous = heartbeatTimers.get(key)
    if (previous !== undefined) clearInterval(previous)
    const timer = setInterval(() => {
      void options.persistence.ownership
        .heartbeat({ token, now: Date.now(), leaseMs: OWNER_LEASE_MS })
        .catch((error: unknown) => {
          controller.abort('task-execution-stale-owner')
          options.log.warn('durable task owner heartbeat was fenced', {
            taskId: token.taskId,
            epoch: token.epoch,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }, OWNER_HEARTBEAT_MS)
    timer.unref?.()
    heartbeatTimers.set(key, timer)
  }

  const attach = async (input: {
    readonly taskId: string
    readonly intentId: string
    readonly controller: AbortController
  }): Promise<TaskDriveAttachOutcome> => {
    const rows = await options.db
      .select({ status: tasks.status, sourceTerminationFence: tasks.sourceTerminationFence })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
    const row = rows[0]
    if (
      row === undefined ||
      (row.status !== 'pending' && row.status !== 'running') ||
      row.sourceTerminationFence !== null
    ) {
      return { kind: 'not-attached' }
    }

    // 两阶段停机（RFC-359 T7b 修订）：上一任 driver 已停但库里 owner 行还在转移时，等它 settle
    // 再认领——否则这里的 claim 会撞上仍是 'claimed' 的 owner 行。
    await options.module.runtimeRegistry.awaitReleasedSettled(input.taskId)
    const claimed = await options.module.claimPersisted({ intentId: input.intentId })
    let attached: ReturnType<typeof options.module.runtimeRegistry.tryAttach>
    try {
      attached = options.module.runtimeRegistry.tryAttach({
        token: claimed.token,
        intentId: input.intentId,
        permit: claimed.permit,
        controller: input.controller,
      })
    } finally {
      options.module.claimGate.leave(claimed.permit)
    }
    if (attached !== 'attached') return { kind: 'not-attached' }
    startHeartbeat(claimed.token, input.controller)
    return {
      kind: 'attached',
      attachment: {
        execution: createTaskExecutionContext({
          intentId: input.intentId,
          token: claimed.token,
          persistence: options.persistence,
        }),
      },
    }
  }

  // RFC-359 T7b：释放序列是一份实现（taskDriverRelease.ts），PG 只装配依赖。
  const releaseDependencies: TaskDriverReleaseDependencies = {
    registry: options.module.runtimeRegistry,
    persistence: options.persistence,
    stopHeartbeat: (tokenKey) => {
      const timer = heartbeatTimers.get(tokenKey)
      if (timer !== undefined) clearInterval(timer)
      heartbeatTimers.delete(tokenKey)
    },
    finalizeWorkspace: options.finalizeWorkspace,
  }

  const releaseAndFinalize = async (input: {
    readonly taskId: string
    readonly controller: AbortController
  }): Promise<void> => {
    await releaseTaskDriverAndFinalize(releaseDependencies, input)
  }

  return Object.freeze({ attach, releaseAndFinalize })
}
