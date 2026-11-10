// RFC-395 II-a A2: one checkpoint-list planner drives both resume and durable review rollback.
// Empty/missing historical pre-snapshots remain a no-op; current isolated runs carry no pre-snapshot.
// RFC-477: moved from services/nodeRollback.ts (task-execution owns target loading, checkpoint planning, the git
// rollback and its RFC-328 effect journal); the outcome type and its user-visible summary are domain/nodeRunRollbackOutcome.ts.

import type { TaskRollbackCheckpointRun } from '../domain/taskCheckpointRollback'
import { hasTaskRollbackCheckpoint } from '../domain/taskCheckpointRollback'
import type { RollbackOutcome } from '../domain/nodeRunRollbackOutcome'
import { taskRollbackPlan } from './taskRollbackCodec'
import { gitCommitExists, rollbackToSnapshot } from '@/util/git'
import type { Logger } from '@/util/log'
import { sha256Hex } from '@/util/hash'
import {
  createNodeRollbackEffectObserver,
  loadNodeRollbackTarget,
  type NodeRollbackDatabase,
} from './nodeRollbackPersistence'
import type { TaskRollbackQueries } from '../application/ports/taskRollbackQueries'

export interface RollbackTarget {
  taskId?: string
  db?: NodeRollbackDatabase
  /** Root workspace reference; checkpoint targets come from the persisted mount list. */
  worktreePath: string
  repos: Array<{ worktreePath: string; mountPath: string }>
}

export type RollbackRunRow = TaskRollbackCheckpointRun

/** The rollback only warns (per-repo failures, an unparsable per-repo map). */
export type NodeRunRollbackLog = Pick<Logger, 'warn'>

export interface PlannedNodeRunRollbackTarget {
  worktreePath: string
  mountPath: string
  snapshot: string
}

/**
 * RFC-333 T8: resolve the exact worktree/snapshot pairs without touching the
 * worktree.  The legacy executor and the durable human-gate effect share this
 * shape so multi-repo fallback semantics cannot drift during the cutover.
 */
export function planNodeRunRollbackTargets(
  target: RollbackTarget,
  run: RollbackRunRow,
): PlannedNodeRunRollbackTarget[] {
  return taskRollbackPlan(target, run).targets
}

/**
 * RFC-098 B1 (audit ⑥-10): load the RollbackTarget for a task — tasks row +
 * taskRepos (repoIndex order), using the actual persisted repository mounts.
 */
export async function loadRollbackTarget(
  db: NodeRollbackDatabase,
  taskId: string,
): Promise<RollbackTarget | null> {
  return await loadNodeRollbackTarget(db, taskId)
}

/** Provider-selected target loader used by PostgreSQL and new SQLite callers. */
export async function loadRollbackTargetFrom(
  queries: TaskRollbackQueries,
  taskId: string,
): Promise<RollbackTarget | null> {
  const snapshot = await queries.load(taskId)
  if (snapshot === null) return null
  return {
    taskId: snapshot.taskId,
    worktreePath: snapshot.worktreePath,
    repos: snapshot.repositories.map((repository) => ({ ...repository })),
  }
}

export async function rollbackNodeRunWorktrees(
  target: RollbackTarget,
  run: RollbackRunRow,
  opts: { checkOnly?: boolean },
  log: NodeRunRollbackLog,
): Promise<RollbackOutcome> {
  const outcome: RollbackOutcome = { attempted: false, failures: [] }
  const plan = taskRollbackPlan(target, run)
  if (plan.parseError !== null)
    log.warn('preSnapshotReposJson parse failed; treating as empty per-repo map', {
      nodeRunId: run.id,
      error: plan.parseError,
    })
  if (plan.targets.length === 0 && !hasTaskRollbackCheckpoint(run)) return outcome
  // Preserve the existing all-repository pre-pass and the single-worktree checkOnly path.
  if (plan.mapped || opts.checkOnly) {
    for (const entry of plan.targets) {
      if (await gitCommitExists(entry.worktreePath, entry.snapshot)) continue
      outcome.failures.push({
        ...(plan.mapped ? { worktreeDirName: entry.mountPath } : {}),
        code: 'snapshot-missing',
        message: `snapshot ${entry.snapshot} not found in the object database (pruned by gc?); no repo touched`,
      })
      if (plan.mapped)
        log.warn('node-run rollback pre-check: per-repo snapshot missing', {
          nodeRunId: run.id,
          worktreeDirName: entry.mountPath,
          sha: entry.snapshot,
        })
    }
    if (outcome.failures.length > 0 || opts.checkOnly) return outcome
  }
  const effect =
    target.taskId === undefined || target.db === undefined
      ? undefined
      : createNodeRollbackEffectObserver({
          db: target.db,
          taskId: target.taskId,
          nodeRunId: run.id,
          request: plan.request,
          resourceKeys: plan.worktreePaths.map((path) => `workspace:${sha256Hex(path)}`),
        })
  await effect?.beforeAct()
  for (const entry of plan.targets) {
    try {
      await rollbackToSnapshot(entry.worktreePath, entry.snapshot)
      outcome.attempted = true
    } catch (error) {
      outcome.failures.push({
        ...(plan.mapped ? { worktreeDirName: entry.mountPath } : {}),
        code: (error as { code?: string }).code ?? 'rollback-failed',
        message: error instanceof Error ? error.message : String(error),
      })
      log.warn(plan.mapped ? 'node-run rollback per-repo failed' : 'node-run rollback failed', {
        nodeRunId: run.id,
        ...(plan.mapped ? { worktreeDirName: entry.mountPath } : {}),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const result = {
    attempted: outcome.attempted,
    ...(plan.mapped ? { repoCount: target.repos.length } : {}),
  }
  if (outcome.failures.length === 0) await effect?.succeed(result)
  else
    await effect?.fail(
      new Error(outcome.failures.map((failure) => failure.message).join('; ')),
      result,
    )
  return outcome
}

/**
 * RFC-477 —— collaboration 的评审回滚规划与反问自动派发的自回滚经 collaboration 自有端口
 * `NodeRunWorkspaceRollbackPort` 进来：bootstrap 把这个工厂交给 collaboration 的 `TaskExecutionParticipantBindings`，
 * collaboration 不取本模块内部。按任务给一个作用域——目标装载一次（带 `db`：在任务执行上下文里回滚照旧写 RFC-328 effect），
 * 规划与执行都对着它；与原来 collaboration 直接调 `loadRollbackTarget(db, taskId)` 再调
 * `planNodeRunRollbackTargets(target, run)` / `rollbackNodeRunWorktrees(target, run, {}, log)` 是同一条路径。
 */
export function createNodeRunWorkspaceRollback(db: NodeRollbackDatabase) {
  return Object.freeze({
    async load(taskId: string) {
      const target = await loadRollbackTarget(db, taskId)
      if (target === null) return null
      return Object.freeze({
        plan: (run: RollbackRunRow) => planNodeRunRollbackTargets(target, run),
        rollback: (run: RollbackRunRow, log: NodeRunRollbackLog) =>
          rollbackNodeRunWorktrees(target, run, {}, log),
      })
    },
  })
}
