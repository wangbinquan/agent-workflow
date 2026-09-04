import type { TaskStatus } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type {
  TaskDriveAttachOutcome,
  TaskDriverLifecyclePort,
} from '../application/drive/taskDriveCoordinator'
import { createTaskExecutionContext } from '../composition/sqliteTaskExecutionContext'
import { createSqliteTaskExecutionPersistence } from '../composition/taskExecutionPersistence'
import {
  DEFAULT_OWNERSHIP_HEARTBEAT_MS,
  DEFAULT_OWNERSHIP_LEASE_MS,
  taskExecutionModule,
} from '../composition'
import { ownershipTokenKey, type OwnershipToken } from '../domain/ownership'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  releaseTaskDriverAndFinalize,
  type TaskDriverReleaseDependencies,
} from './taskDriverRelease'

const DRIVER_ATTACHABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['pending', 'running'])
const ownerHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()

export interface TaskDriverLifecycleAdapterOptions {
  readonly db: DbClient
  readonly log: TaskExecutionTopologyLogger
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
}

export async function attachTaskDriver(input: {
  readonly db: DbClient
  readonly taskId: string
  readonly intentId: string
  readonly controller: AbortController
  readonly log: TaskExecutionTopologyLogger
}): Promise<TaskDriveAttachOutcome> {
  return withTaskReviewMutationLock(input.taskId, async () => {
    const row = input.db
      .select({ status: tasks.status, sourceTerminationFence: tasks.sourceTerminationFence })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
      .all()[0]
    if (
      row === undefined ||
      !DRIVER_ATTACHABLE_STATUSES.has(row.status) ||
      row.sourceTerminationFence !== null
    ) {
      return { kind: 'not-attached' }
    }

    // 两阶段停机（RFC-359 T7b 修订）：上一任 driver 已停但库里 owner 行还在转移时，等它 settle
    // 再认领——否则这里的 claim 会撞上仍是 'claimed' 的 owner 行。
    await taskExecutionModule.runtimeRegistry.awaitReleasedSettled(input.taskId)
    const claimed = taskExecutionModule.claim({ db: input.db, intentId: input.intentId })
    let attached: ReturnType<typeof taskExecutionModule.runtimeRegistry.tryAttach>
    try {
      attached = taskExecutionModule.runtimeRegistry.tryAttach({
        token: claimed.token,
        intentId: input.intentId,
        permit: claimed.permit,
        controller: input.controller,
      })
    } finally {
      taskExecutionModule.claimGate.leave(claimed.permit)
    }
    if (attached !== 'attached') return { kind: 'not-attached' }

    startOwnerHeartbeat(input.db, claimed.token, input.controller, input.log)
    return {
      kind: 'attached',
      attachment: {
        execution: createTaskExecutionContext({
          intentId: input.intentId,
          token: claimed.token,
          db: input.db,
        }),
      },
    }
  })
}

function startOwnerHeartbeat(
  db: DbClient,
  token: OwnershipToken,
  controller: AbortController,
  log: TaskExecutionTopologyLogger,
): void {
  const key = ownershipTokenKey(token)
  const existing = ownerHeartbeatTimers.get(key)
  if (existing !== undefined) clearInterval(existing)
  const timer = setInterval(() => {
    try {
      taskExecutionModule.ownership.heartbeat({
        db,
        token,
        now: Date.now(),
        leaseMs: DEFAULT_OWNERSHIP_LEASE_MS,
      })
    } catch (error) {
      controller.abort('task-execution-stale-owner')
      log.warn('durable task owner heartbeat was fenced', {
        taskId: token.taskId,
        epoch: token.epoch,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, DEFAULT_OWNERSHIP_HEARTBEAT_MS)
  timer.unref?.()
  ownerHeartbeatTimers.set(key, timer)
}

/** RFC-359 T7b：释放序列是一份实现（taskDriverRelease.ts）；这里只提供 SQLite 的依赖装配。 */
function releaseDependencies(
  db: DbClient,
  finalizeWorkspace: (taskId: string) => Promise<void>,
): TaskDriverReleaseDependencies {
  return {
    registry: taskExecutionModule.runtimeRegistry,
    persistence: createSqliteTaskExecutionPersistence(db),
    stopHeartbeat: (tokenKey) => {
      const timer = ownerHeartbeatTimers.get(tokenKey)
      if (timer !== undefined) clearInterval(timer)
      ownerHeartbeatTimers.delete(tokenKey)
    },
    finalizeWorkspace,
  }
}

export function activeTaskDriverController(taskId: string): AbortController | undefined {
  const registry = taskExecutionModule.runtimeRegistry
  const token = registry.tokenForTask(taskId)
  return token === null ? undefined : (registry.controllerFor(token) ?? undefined)
}

export function isTaskDriverActive(taskId: string): boolean {
  return taskExecutionModule.runtimeRegistry.hasTask(taskId)
}

/** Wait for the current process-local owner to release without requesting a stop. */
export async function awaitTaskDriverIdle(taskId: string): Promise<void> {
  const registry = taskExecutionModule.runtimeRegistry
  const token = registry.tokenForTask(taskId)
  if (token === null) return
  const result = await registry.awaitStopped({ token, tokenKey: ownershipTokenKey(token) })
  if (result.kind === 'unreaped') {
    throw new TaskExecutionError(
      'task-execution-recovery-required',
      `task '${taskId}' owner stopped with unreaped work (${result.code})`,
    )
  }
}

/** Test isolation for the module-owned heartbeat/runtime handles. */
export function clearTaskDriverLifecycleForTesting(): void {
  for (const timer of ownerHeartbeatTimers.values()) clearInterval(timer)
  ownerHeartbeatTimers.clear()
  taskExecutionModule.runtimeRegistry.clearForTesting()
}

export function createTaskDriverLifecyclePort(
  options: TaskDriverLifecycleAdapterOptions,
): TaskDriverLifecyclePort {
  return {
    attach: async (input) =>
      await attachTaskDriver({
        db: options.db,
        taskId: input.taskId,
        intentId: input.intentId,
        controller: input.controller,
        log: options.log,
      }),
    releaseAndFinalize: async (input) =>
      await releaseTaskDriverAndFinalize(
        releaseDependencies(options.db, options.finalizeWorkspace),
        { taskId: input.taskId, controller: input.controller },
      ),
  }
}
