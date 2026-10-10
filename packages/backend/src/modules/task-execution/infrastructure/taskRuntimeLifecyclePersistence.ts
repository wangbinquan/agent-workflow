// RFC-359 W4-B1 批 2g —— 任务运行时状态迁移（tasks.status 的 CAS + lifecycle committed event）：一份实现，两个 provider 共用。
// 此前 SQLite 侧只是 `platform/persistence/sqlite/taskLifecycle.ts` 同步内核的薄壳，PG 侧是整份实现；现在端口两侧都走
// 统一写事务 + owner 围栏（PG READ COMMITTED：CAS 与围栏都是行级条件 UPDATE）。同步内核暂留给尚未迁移的 legacy 直接调用方。

import type { TaskStatus } from '@agent-workflow/shared'
import { and, eq, isNull } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import {
  ConcurrentTaskTransition,
  isTerminalTaskStatus,
  resolveTerminalWorkspacePruneDecision,
} from '@/services/lifecycle'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import type {
  TaskRuntimeLifecycleMutation,
  TaskRuntimeLifecyclePersistence,
} from '../application/ports/taskRuntimeLifecyclePersistence'
import {
  fenceTaskWrite,
  type TaskExecutionTransaction,
  withTaskExecutionWrite,
} from './ownedTaskExecution'
import { appendTaskLifecycleTransitionCommittedEvent } from './taskLifecycleCommittedEvents'
import { driveAsyncProgram } from '@/platform/persistence/transactionProgram'
import {
  taskLifecycleWriteSequence,
  type TaskLifecycleWriteInput,
} from './taskLifecycleWriteSequence'
import { runWithTaskExecutionContext } from '../application/taskExecutionContext'
import type {
  withTaskHostNewWork,
  withTaskHostIssuedAck,
  TaskHostWriteBinding,
  TaskHostWriteSelection,
} from './hostExecutionWriteTransaction'
import { captureTaskHostExecutionWrite } from './taskHostExecutionWriteSelection'

type HostLifecycleWrite = Readonly<{
  selection: Extract<TaskHostWriteSelection, { kind: 'selected' }>
  write: typeof withTaskHostNewWork | typeof withTaskHostIssuedAck
}>

type LifecycleRow = Readonly<{
  status: TaskStatus
  worktreePath: string
  spaceKind: 'local' | 'scratch' | 'remote' | 'internal' | 'inherited'
  workspacePruningAt: number | null
  workspacePruneCause: 'webhook-terminal' | null
  workspacePrunedAt: number | null
  sourceTerminationFence: 'closed' | 'merged' | null
  errorSummary: string | null
  lifecycleEventRevision: number
}>

type TaskRuntimeLifecycleWriteInput = Omit<
  TaskLifecycleWriteInput<TaskExecutionTransaction>,
  'extra' | 'onTransitionTx'
> &
  Readonly<{
    extra?: TaskRuntimeLifecycleMutation &
      Partial<
        Pick<typeof tasks.$inferInsert, 'sourceTerminationFence' | 'sourceTerminationEffectRev'>
      >
    onTransitionTx?: (
      ...args: Parameters<
        NonNullable<TaskLifecycleWriteInput<TaskExecutionTransaction>['onTransitionTx']>
      >
    ) => Promise<void>
  }>

/** Async interpretation of the shared physical CAS and event sequence. Named atoms own
 * validation and the transaction; companions run after the CAS, before its
 * event is appended. A CAS miss returns null before any companion runs, while
 * companion failures propagate so the enclosing transaction rolls back. */
export async function writeTaskRuntimeLifecycleInTx(
  tx: TaskExecutionTransaction,
  input: TaskRuntimeLifecycleWriteInput,
) {
  return driveAsyncProgram(
    taskLifecycleWriteSequence(tx, input, appendTaskLifecycleTransitionCommittedEvent),
    (step) => step(),
  )
}

export class DrizzleTaskRuntimeLifecyclePersistence implements TaskRuntimeLifecyclePersistence {
  constructor(
    private readonly db: ProviderNeutralDatabase,
    private readonly workspacePresence: WorkspacePresenceQueries,
  ) {}

  async trySet(input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0]): Promise<boolean> {
    try {
      await this.set(input)
      return true
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) return false
      throw error
    }
  }

  /** Provider-private purpose entry; capture precedes the first lifecycle read. */
  async trySetWithHostWrite(
    input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0],
    binding: TaskHostWriteBinding,
    write: typeof withTaskHostNewWork | typeof withTaskHostIssuedAck,
  ): Promise<boolean> {
    const work = captureTaskHostExecutionWrite(binding, input)
    const capturedInput = {
      ...input,
      allowedFrom: [...input.allowedFrom],
      ...(input.extra === undefined ? {} : { extra: { ...input.extra } }),
      executionContext: work.context,
    }
    return runWithTaskExecutionContext(work.context, async () => {
      try {
        await this.set(capturedInput, undefined, { selection: work.selection, write })
        return true
      } catch (error) {
        if (error instanceof ConflictError || error instanceof NotFoundError) return false
        throw error
      }
    })
  }

  /** Provider-private composition hook for named cross-context atoms. The
   * application port never receives this transaction callback. */
  async trySetWithGuard(
    input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0],
    guard: (tx: TaskExecutionTransaction) => Promise<void>,
  ): Promise<boolean> {
    try {
      await this.set(input, guard)
      return true
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) return false
      throw error
    }
  }

  private async set(
    input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0],
    guard?: (tx: TaskExecutionTransaction) => Promise<void>,
    hostWrite?: HostLifecycleWrite,
  ): Promise<void> {
    const snapshot = await this.load(input.taskId)
    const from = snapshot.status
    if (isTerminalTaskStatus(from) && input.allowTerminal !== true) {
      throw new ConflictError(
        'illegal-task-transition',
        `task ${input.taskId} is terminal ('${from}'); refuse to overwrite (${input.reason})`,
      )
    }
    if (!input.allowedFrom.includes(from)) {
      throw new ConflictError(
        'illegal-task-transition',
        `task ${input.taskId} status='${from}' not in allowedFrom=[${input.allowedFrom.join(',')}] (${input.reason})`,
      )
    }
    const isRevival =
      input.allowTerminal === true && isTerminalTaskStatus(from) && !isTerminalTaskStatus(input.to)
    if (isRevival) {
      if (snapshot.sourceTerminationFence !== null) {
        throw new ConflictError(
          snapshot.sourceTerminationFence === 'closed'
            ? 'task-source-terminal-closed'
            : 'task-source-terminal-merged',
          `task ${input.taskId} is fenced by an MR/PR ${snapshot.sourceTerminationFence} event; cannot ${input.reason}`,
        )
      }
      if (snapshot.workspacePrunedAt !== null) {
        throw new DomainError(
          'workspace-pruned',
          `task ${input.taskId} workspace was reclaimed by GC; cannot ${input.reason}`,
          410,
        )
      }
      if (snapshot.workspacePruningAt !== null) {
        throw new ConflictError(
          'workspace-pruning',
          `task ${input.taskId} workspace is being reclaimed by GC right now; retry after it finishes (${input.reason})`,
        )
      }
      if (
        snapshot.worktreePath !== '' &&
        !(await this.workspacePresence.exists(snapshot.worktreePath))
      ) {
        const changed = await this.withWrite(
          hostWrite,
          async (tx) => {
            await this.fence(tx, input)
            return await tx
              .update(tasks)
              .set({ workspacePrunedAt: input.now })
              .where(
                and(
                  eq(tasks.id, input.taskId),
                  eq(tasks.status, snapshot.status),
                  eq(tasks.worktreePath, snapshot.worktreePath),
                  eq(tasks.lifecycleEventRevision, snapshot.lifecycleEventRevision),
                  isNull(tasks.deletedAt),
                  isNull(tasks.sourceTerminationFence),
                  isNull(tasks.workspacePruningAt),
                  isNull(tasks.workspacePrunedAt),
                ),
              )
              .returning({ id: tasks.id })
              .all()
          },
          (changed) => {
            if (changed.length === 0) {
              throw new ConcurrentTaskTransition(input.taskId, input.allowedFrom, input.reason)
            }
          },
        )
        if (changed.length === 0) {
          throw new ConcurrentTaskTransition(input.taskId, input.allowedFrom, input.reason)
        }
        throw new DomainError(
          'workspace-pruned',
          `task ${input.taskId} workspace '${snapshot.worktreePath}' no longer exists (reclaimed before tombstones existed); cannot ${input.reason}`,
          410,
        )
      }
    }

    const prune = await resolveTerminalWorkspacePruneDecision(
      {
        taskId: input.taskId,
        spaceKind: snapshot.spaceKind,
        workspacePruningAt: snapshot.workspacePruningAt,
        workspacePruneCause: snapshot.workspacePruneCause,
        workspacePrunedAt: snapshot.workspacePrunedAt,
      },
      input.to,
    )
    const result = await this.withWrite(hostWrite, async (tx) => {
      await this.fence(tx, input)
      await guard?.(tx)
      const changed = await writeTaskRuntimeLifecycleInTx(tx, {
        ...input,
        from,
        isRevival,
        ...(isRevival
          ? {
              expectedLifecycleRevision: snapshot.lifecycleEventRevision,
              expectedWorktreePath: snapshot.worktreePath,
            }
          : {}),
        workspacePruneDecision: prune,
        previousErrorSummary: snapshot.errorSummary,
      })
      if (changed === null) {
        throw new ConcurrentTaskTransition(input.taskId, input.allowedFrom, input.reason)
      }
      return changed.eventRef === null ? [] : [changed.eventRef]
    })
    await publishCommittedEventsAfterCommit(result)
  }

  private withWrite<T>(
    hostWrite: HostLifecycleWrite | undefined,
    body: (tx: TaskExecutionTransaction) => Promise<T>,
    beforeConsume?: (result: T) => void,
  ): Promise<T> {
    if (hostWrite === undefined) return withTaskExecutionWrite(this.db, body)
    return hostWrite.write({
      db: this.db,
      selection: hostWrite.selection,
      body: async (tx) => {
        const result = await body(tx)
        beforeConsume?.(result)
        return result
      },
    })
  }

  private async load(taskId: string): Promise<LifecycleRow> {
    const row = await this.db
      .select({
        status: tasks.status,
        worktreePath: tasks.worktreePath,
        spaceKind: tasks.spaceKind,
        workspacePruningAt: tasks.workspacePruningAt,
        workspacePruneCause: tasks.workspacePruneCause,
        workspacePrunedAt: tasks.workspacePrunedAt,
        sourceTerminationFence: tasks.sourceTerminationFence,
        errorSummary: tasks.errorSummary,
        lifecycleEventRevision: tasks.lifecycleEventRevision,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
      .get()
    if (row === undefined) throw new NotFoundError('task-not-found', `task ${taskId} not found`)
    return { ...row, status: row.status as TaskStatus }
  }

  private async fence(
    tx: TaskExecutionTransaction,
    input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0],
  ): Promise<void> {
    // 围栏规则两引擎同一（ownedTaskExecution）：显式上下文 > 环境上下文 > 无主围栏。
    await fenceTaskWrite(tx, {
      taskId: input.taskId,
      context: input.executionContext,
      now: input.now,
    })
  }
}
