import type { TaskStatus } from '@agent-workflow/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { existsSync } from 'node:fs'

import { tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import {
  ConcurrentTaskTransition,
  isTerminalTaskStatus,
  resolveTerminalWorkspacePruneDecision,
} from '@/services/lifecycle'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import type { TaskRuntimeLifecyclePersistence } from '../application/ports/taskRuntimeLifecyclePersistence'
import {
  appendPostgresqlTaskLifecycleTransitionTx,
  assertPostgresqlTaskOwnerlessTx,
  assertPostgresqlTaskOwnerTx,
  withPostgresqlSerializableTaskExecution,
  type PostgresqlTaskExecutionTransaction,
} from './postgresqlTaskLifecycleTransaction'

type LifecycleRow = Readonly<{
  status: TaskStatus
  worktreePath: string
  spaceKind: 'local' | 'scratch' | 'remote' | 'internal' | 'inherited'
  workspacePruningAt: number | null
  workspacePruneCause: 'webhook-terminal' | null
  workspacePrunedAt: number | null
  sourceTerminationFence: 'closed' | 'merged' | null
  errorSummary: string | null
}>

export class PostgresqlTaskRuntimeLifecyclePersistence implements TaskRuntimeLifecyclePersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async trySet(input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0]): Promise<boolean> {
    try {
      await this.set(input)
      return true
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) return false
      throw error
    }
  }

  /** Provider-private composition hook for named cross-context atoms. The
   * application port never receives this transaction callback. */
  async trySetWithGuard(
    input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0],
    guard: (tx: PostgresqlTaskExecutionTransaction) => Promise<void>,
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
    guard?: (tx: PostgresqlTaskExecutionTransaction) => Promise<void>,
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
      if (snapshot.worktreePath !== '' && !existsSync(snapshot.worktreePath)) {
        await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
          await this.fence(tx, input)
          await tx
            .update(tasks)
            .set({ workspacePrunedAt: input.now })
            .where(
              and(
                eq(tasks.id, input.taskId),
                isNull(tasks.workspacePruningAt),
                isNull(tasks.workspacePrunedAt),
              ),
            )
        })
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
    const result = await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      await this.fence(tx, input)
      await guard?.(tx)
      const updated = await tx
        .update(tasks)
        .set({
          status: input.to,
          ...(input.to === 'running'
            ? { runningSince: input.now }
            : from === 'running'
              ? {
                  runningMs: sql`${tasks.runningMs} + (${input.now} - COALESCE(${tasks.runningSince}, ${input.now}))`,
                  runningSince: null,
                }
              : {}),
          ...(input.extra ?? {}),
          ...(prune.prune
            ? { workspacePruningAt: input.now, workspacePruneCause: prune.cause }
            : {}),
          lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.status, from),
            ...(isRevival
              ? [isNull(tasks.workspacePruningAt), isNull(tasks.workspacePrunedAt)]
              : []),
            ...(prune.prune
              ? [
                  isNull(tasks.workspacePruningAt),
                  isNull(tasks.workspacePruneCause),
                  isNull(tasks.workspacePrunedAt),
                ]
              : []),
          ),
        )
        .returning({ lifecycleEventRevision: tasks.lifecycleEventRevision })
      const changed = updated[0]
      if (changed === undefined) {
        throw new ConcurrentTaskTransition(input.taskId, input.allowedFrom, input.reason)
      }
      const eventRef = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
        taskId: input.taskId,
        lifecycleRevision: changed.lifecycleEventRevision,
        previousStatus: from,
        status: input.to,
        errorSummary:
          input.extra?.errorSummary === undefined
            ? snapshot.errorSummary
            : (input.extra.errorSummary ?? null),
        workspacePruneClaim: prune.prune
          ? { claimedAt: new Date(input.now).toISOString(), cause: prune.cause }
          : null,
        occurredAt: input.now,
      })
      return eventRef === null ? [] : [eventRef]
    })
    await publishCommittedEventsAfterCommit(result)
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
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
      .get()
    if (row === undefined) throw new NotFoundError('task-not-found', `task ${taskId} not found`)
    return { ...row, status: row.status as TaskStatus }
  }

  private async fence(
    tx: Parameters<Parameters<typeof withPostgresqlSerializableTaskExecution>[1]>[0],
    input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0],
  ): Promise<void> {
    if (input.executionContext === undefined) {
      await assertPostgresqlTaskOwnerlessTx(tx, input.taskId)
      return
    }
    if (input.executionContext.token.taskId !== input.taskId) {
      throw new ConflictError(
        'task-execution-context-mismatch',
        `execution context for '${input.executionContext.token.taskId}' cannot mutate task '${input.taskId}'`,
      )
    }
    await assertPostgresqlTaskOwnerTx(tx, input.executionContext.token, input.now)
  }
}
