import type { TaskStatus } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type {
  TaskDriveAttachOutcome,
  TaskDriverLifecyclePort,
} from '../application/drive/taskDriveCoordinator'
import { createTaskExecutionContext } from '../application/taskExecutionContext'
import { createTaskExecutionPersistence } from '../composition/taskExecutionPersistence'
import {
  DEFAULT_OWNERSHIP_HEARTBEAT_MS,
  DEFAULT_OWNERSHIP_LEASE_MS,
  taskExecutionModule,
  type ClaimedTaskExecution,
  type TaskExecutionModule,
} from '../composition'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import { ownershipTokenKey, type OwnershipToken } from '../domain/ownership'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  releaseTaskDriverAndFinalize,
  type TaskDriverReleaseDependencies,
} from './taskDriverRelease'

const DRIVER_ATTACHABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['pending', 'running'])
const ownerHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()

/**
 * RFC-359 AC-1（plan §5hm）—— 驱动生命周期端口**一份实现，两个引擎共用**。
 *
 * 合一之前这里有两份：本文件（SQLite）与 `postgresqlTaskDriverLifecycle.ts`。逐项对下来，
 * 前四项差异都是同一个故事的第 N 遍（同步 `.all()[0]` vs `await`、进程级单例 vs 实例、
 * `claim({db})` vs `claimPersisted()`、执行上下文的薄包装），而**第五项是真差异且方向是 PG 更弱**：
 * SQLite 的 attach 整个包在 `withTaskReviewMutationLock` 里、PG 那份一句都没有——
 * 于是 PG 上 attach 能与「取消正在封评审行」交错（`rfc359-w5hm-attach-review-lock-parity`
 * 把这个交错照了出来：合一前它在 PG 上是红的）。
 *
 * 合并取「有锁 + 端口化」那半。认领方式由装配方交一个 `claim` 闭包决定：
 * SQLite 绑进程级单例的 `claim({ db, intentId })`，PG 绑实例的 `claimPersisted({ intentId })`
 * ——两者函数体本来就逐字相同，只差归属持久化从哪来。
 */
export interface TaskDriverLifecycleDependencies {
  /** 状态读与（SQLite 侧）执行上下文的 legacy 连接。两个引擎都能用的中立句柄。 */
  readonly db: ProviderNeutralDatabase
  readonly module: TaskExecutionModule
  readonly claim: (intentId: string) => Promise<ClaimedTaskExecution>
  readonly persistence: TaskExecutionPersistence
  readonly log: TaskExecutionTopologyLogger
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
  /**
   * SQLite 兼容层仍要在执行上下文里带上 legacy 连接（`legacyConnection` / `compatibility.db`），
   * 那是 `services/task` 那条启动路还没退役的残留（plan §5hn）。PG 不带。
   */
  readonly legacyConnection?: ProviderNeutralDatabase
}

export async function attachTaskDriver(
  input: {
    readonly taskId: string
    readonly intentId: string
    readonly controller: AbortController
  },
  deps: Omit<TaskDriverLifecycleDependencies, 'finalizeWorkspace'>,
): Promise<TaskDriveAttachOutcome> {
  return withTaskReviewMutationLock(input.taskId, async () => {
    // 中立读法：`await` 在 SQLite 上拿到的是同步结果、在 PostgreSQL 上是 Promise，
    // 两边都成立；`.all()` 那种「一边是数组、一边是 Promise」的写法只服务一个引擎。
    const row = (
      await deps.db
        .select({ status: tasks.status, sourceTerminationFence: tasks.sourceTerminationFence })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1)
    )[0]
    if (
      row === undefined ||
      !DRIVER_ATTACHABLE_STATUSES.has(row.status) ||
      row.sourceTerminationFence !== null
    ) {
      return { kind: 'not-attached' }
    }

    // 两阶段停机（RFC-359 T7b 修订）：上一任 driver 已停但库里 owner 行还在转移时，等它 settle
    // 再认领——否则这里的 claim 会撞上仍是 'claimed' 的 owner 行。
    await deps.module.runtimeRegistry.awaitReleasedSettled(input.taskId)
    const claimed = await deps.claim(input.intentId)
    let attached: ReturnType<typeof deps.module.runtimeRegistry.tryAttach>
    try {
      attached = deps.module.runtimeRegistry.tryAttach({
        token: claimed.token,
        intentId: input.intentId,
        permit: claimed.permit,
        controller: input.controller,
      })
    } finally {
      deps.module.claimGate.leave(claimed.permit)
    }
    if (attached !== 'attached') return { kind: 'not-attached' }

    startOwnerHeartbeat(deps.persistence, claimed.token, input.controller, deps.log)
    return {
      kind: 'attached',
      attachment: {
        execution: createTaskExecutionContext({
          intentId: input.intentId,
          token: claimed.token,
          persistence: deps.persistence,
          ...(deps.legacyConnection === undefined
            ? {}
            : {
                legacyConnection: deps.legacyConnection,
                compatibility: { db: deps.legacyConnection },
              }),
        }),
      },
    }
  })
}

function startOwnerHeartbeat(
  persistence: TaskExecutionPersistence,
  token: OwnershipToken,
  controller: AbortController,
  log: TaskExecutionTopologyLogger,
): void {
  const key = ownershipTokenKey(token)
  const existing = ownerHeartbeatTimers.get(key)
  if (existing !== undefined) clearInterval(existing)
  // RFC-359 AC-1（plan §5hm）：心跳走中立归属持久化。合一前这里是
  // `taskExecutionModule.ownershipFor(db)`、PG 那份是 `persistence.ownership`——
  // 而 `ownershipFor(db)` 的函数体就是 `new DrizzleTaskOwnershipPersistence(db)`，
  // 与 `createTaskExecutionPersistence(db).ownership` 同一个东西。装配方交哪个都一样。
  const timer = setInterval(() => {
    void persistence.ownership
      .heartbeat({ token, now: Date.now(), leaseMs: DEFAULT_OWNERSHIP_LEASE_MS })
      .catch((error: unknown) => {
        controller.abort('task-execution-stale-owner')
        log.warn('durable task owner heartbeat was fenced', {
          taskId: token.taskId,
          epoch: token.epoch,
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }, DEFAULT_OWNERSHIP_HEARTBEAT_MS)
  timer.unref?.()
  ownerHeartbeatTimers.set(key, timer)
}

/** RFC-359 T7b：释放序列是一份实现（taskDriverRelease.ts）；这里只提供 SQLite 的依赖装配。 */
function releaseDependencies(
  deps: Pick<TaskDriverLifecycleDependencies, 'module' | 'persistence' | 'finalizeWorkspace'>,
): TaskDriverReleaseDependencies {
  return {
    registry: deps.module.runtimeRegistry,
    persistence: deps.persistence,
    stopHeartbeat: (tokenKey) => {
      const timer = ownerHeartbeatTimers.get(tokenKey)
      if (timer !== undefined) clearInterval(timer)
      ownerHeartbeatTimers.delete(tokenKey)
    },
    finalizeWorkspace: deps.finalizeWorkspace,
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

/** 两阶段停机：driver 已停但库里 owner 行 / intent 还在转移时等它 settle（准入前调用）。 */
export async function awaitTaskDriverReleasedSettled(taskId: string): Promise<void> {
  await taskExecutionModule.runtimeRegistry.awaitReleasedSettled(taskId)
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
  deps: TaskDriverLifecycleDependencies,
): TaskDriverLifecyclePort {
  const port: TaskDriverLifecyclePort = {
    attach: async (input) => await attachTaskDriver(input, deps),
    releaseAndFinalize: async (input) =>
      await releaseTaskDriverAndFinalize(releaseDependencies(deps), {
        taskId: input.taskId,
        controller: input.controller,
      }),
  }
  return Object.freeze(port)
}

/**
 * SQLite 组合根的装配：进程级单例 + 从 db 造的持久化 + legacy 连接。
 *
 * 这一层存在只是因为 `services/task` 那条启动路还没退役（plan §5hn）——
 * 它手上只有一个 `db`，拿不到模块实例。退役之后这个便利构造也一并消失。
 */
export function createDatabaseTaskDriverLifecyclePort(options: {
  readonly db: ProviderNeutralDatabase
  readonly log: TaskExecutionTopologyLogger
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
}): TaskDriverLifecyclePort {
  return createTaskDriverLifecyclePort({
    db: options.db,
    module: taskExecutionModule,
    claim: (intentId) => taskExecutionModule.claim({ db: options.db, intentId }),
    persistence: createTaskExecutionPersistence(options.db),
    log: options.log,
    finalizeWorkspace: options.finalizeWorkspace,
    legacyConnection: options.db,
  })
}
