// RFC-395 II-a A2: one checkpoint-list planner drives both resume and durable review rollback.
// Empty/missing historical pre-snapshots remain a no-op; current isolated runs carry no pre-snapshot.

import type { TaskRollbackCheckpointRun } from '@/modules/task-execution/public/types'
import { taskRollbackPlan } from '@/modules/task-execution/public/queries'
import { gitCommitExists, rollbackToSnapshot } from '@/util/git'
import type { Logger } from '@/util/log'
import { sha256Hex } from '@/util/hash'
import {
  createNodeRollbackEffectObserver,
  loadNodeRollbackTarget,
  type NodeRollbackDatabase,
} from '@/modules/task-execution/infrastructure/nodeRollbackPersistence'
import type { TaskRollbackQueries } from '@/modules/task-execution/application/ports/taskRollbackQueries'

export interface RollbackTarget {
  taskId?: string
  db?: NodeRollbackDatabase
  /** Root workspace reference; the epoch-1 adapter handles the historical scalar fallback. */
  worktreePath: string
  repos: Array<{ worktreePath: string; mountPath: string }>
}

export type RollbackRunRow = TaskRollbackCheckpointRun

/** RFC-098 B1: per-repo rollback outcome. `attempted` = at least one worktree
 *  was actually rolled back; `failures` = per-repo errors (warn-and-continue
 *  semantics preserved — callers decide whether a failure escalates). */
export interface RollbackOutcome {
  attempted: boolean
  failures: Array<{ worktreeDirName?: string; code: string; message: string }>
}

/**
 * `snapshot-missing` 那一类失败的合并说明；没有这类失败时返回 null。
 *
 * RFC-359 W57：此前 `postgresqlTaskRouteOperations.ts`（叫 `snapshotLostDetail`）与
 * `childTaskLifecycleParticipant.ts`（叫 `snapshotLost`）各存一份**逐字相同**的
 * 实现——两个名字、一段代码。它格式化的是本文件的 `RollbackOutcome`，落在类型旁边是它本来
 * 该在的地方；两个调用点原本就从这里 import 那个类型，共享它不新增任何一条 import 边。
 *
 * 为什么值得收：这条说明是**用户可见文案**——快照丢失时任务详情页显示的就是它。两份实现
 * 意味着两条路径上的同一种失败可能给出不同措辞。
 */
export function snapshotMissingDetail(outcome: RollbackOutcome): string | null {
  const failures = outcome.failures.filter((failure) => failure.code === 'snapshot-missing')
  if (failures.length === 0) return null
  return failures
    .map((failure) =>
      failure.worktreeDirName === undefined
        ? failure.message
        : `${failure.worktreeDirName}: ${failure.message}`,
    )
    .join('; ')
}

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
 * taskRepos (repoIndex order), with the same single-repo synthesized fallback
 * the scheduler uses for rows predating the multi-repo migration.
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
  log: Logger,
): Promise<RollbackOutcome> {
  const outcome: RollbackOutcome = { attempted: false, failures: [] }
  const plan = taskRollbackPlan(target, run)
  if (plan.parseError !== null)
    log.warn('preSnapshotReposJson parse failed; treating as empty per-repo map', {
      nodeRunId: run.id,
      error: plan.parseError,
    })
  if (!plan.mapped && plan.targets.length === 0) return outcome
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
