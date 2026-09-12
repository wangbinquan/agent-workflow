// RFC-359 —— 「这个任务还能不能被继续」的**唯一**判据，两个 provider 共用一份。
//
// 为什么它存在（合一前的形状）：判据原先是 `services/task.ts` 里的私有函数
// `assertWorktreePresentForResume`，只被单进程 SQLite 部署的房间适配器调用；PostgreSQL 部署
// 的 `continuation.assertResumable` 注入的是**空操作**，理由写成「多进程部署看不到工作树」。
// 实测两个部署的 `human-gate-continuation` worker 都跑在同一个 daemon 进程里（`cli/start.ts`
// 的两处注册），工作树对受理请求的进程是可见的——于是那个空操作的净效果只有一个：
// 工作树被 GC 回收后，confirm/approve 在 SQLite 上是 410（闸门与消息随事务回滚、决策可重试），
// 在 PostgreSQL 上却是 200：闸门就地关上、holder 释放、随后 worker 驱动失败只打一行 warn，
// 任务**永久搁浅**且没有第二次 confirm 的入口。这正是
// `tests/rfc164-workgroup-room.test.ts` 的「上线前加固」用例要挡的那条回归——它此前只跑
// SQLite，所以 PostgreSQL 这半从来没被看住。
//
// 判据本身不碰任何 provider SQL：任务行经 `TaskRouteOperations.get`（neutral）取，
// `__repo_prep__` 事实经 `TaskRecoveryOperations`（application port）取，剩下的是纯函数
// `taskWorkspacePhase` 与一次文件系统探测。所以它能原样落在 application 层给两边共用。
//
// 注意 `hasRepoPrepRow` 直接吃 port，不经 `services/taskWorkspacePhase` 那层包装——模块内部
// 反向 import legacy 层是 RFC-317 T23 的红。

import { existsSync } from 'node:fs'

import { taskWorkspacePhase, type Task } from '@agent-workflow/shared'
import { ConflictError, DomainError } from '@/util/errors'

import type { TaskRecoveryOperations } from './ports/taskRecoveryOperations'

export interface WorktreeResumePreflightDependencies {
  /** 任务行（neutral 读；两个 provider 的 `routes.tasks.get` 都满足）。 */
  readonly getTask: (taskId: string) => Promise<Task | null>
  readonly taskRecoveryOperations: TaskRecoveryOperations
  /** 文件系统探测；默认 `existsSync`，测试可注入。 */
  readonly worktreeExists?: (path: string) => boolean
}

/**
 * 工作树还在不在？不在就按形态给出 410（被 GC 回收）或 409（仓库准备没跑完）。
 *
 * RFC-287 G7 / AC-10 —— 「工作树没建出来」与「工作树被回收了」是**两件事**。
 *
 * G7 之前不变量是「有任务行就有工作树」，所以空路径只可能是回收。G7 之后多了一段
 * 新形态：任务行已落、准备（clone/物化）失败或还没跑完，`worktreePath` 是空串。
 * 此时 `existsSync('')` 恒 false，会掉进下面那句 410，并把原因写成
 * 「likely reclaimed by worktree GC」——归因完全错误（它从来没被建出来过，谈不上
 * 被回收），给用户的下一步也相反：正解是**重试准备仓库**（AC-11），不是另起任务。
 * 前端已经靠 `__repo_prep__` 行分出了第四态，服务端这一半必须跟上，否则 API 的
 * 错误码与文案仍在误导（且开了 autoResumeOnBoot 时每次 boot 都吃一个错误归因）。
 *
 * 判据用墓碑区分（DTO 上是 workspaceState：pruned/pruning 即已打/正在打）：
 * 打了墓碑 = 老的「物化失败 / 工作区已回收」形态（沿用原语义）；没打墓碑 + 空
 * 路径 = G7 的准备阶段（AC-15 刻意保证准备失败不打墓碑）。
 * ⚠️ 判据必须再加一条「确实有 `__repo_prep__` 行」（五轮门 Codex 数据完整性面 F7）。
 *
 * 「空路径 + 无墓碑」在 G7 之前**也**是合法形态:那时物化失败会留下
 * `failed + worktreePath=''` 的任务行（且迁移 0034 给它回填了一条空路径的
 * `task_repos`、迁移 0085 新增墓碑列时不回填）。只凭这两个标量判，会把**存量**
 * 物化失败任务谎报成「repository preparation has not completed」并劝用户去重试准备
 * ——而它根本没有准备行，AC-11 的重试入口对它不存在，等于把人指向一扇不存在的门。
 * RFC-317 T50（LC-05）—— 判据收进 `taskWorkspacePhase`（shared，纯函数）。
 */
export async function assertWorktreePresentForResume(
  operations: TaskRecoveryOperations,
  task: Task,
  verb: string,
  worktreeExists: (path: string) => boolean = existsSync,
): Promise<void> {
  const gone = (msg: string): never => {
    throw new DomainError(
      'task-worktree-missing',
      `${msg}; cannot ${verb} — the worktree was likely reclaimed by worktree GC`,
      410,
    )
  }
  const phase = taskWorkspacePhase({
    worktreePath: task.worktreePath,
    workspacePruningAt: (task.workspaceState ?? 'available') === 'pruning' ? 1 : null,
    workspacePrunedAt: (task.workspaceState ?? 'available') === 'pruned' ? 1 : null,
    hasRepoPrepRow: (await operations.taskIdsWithRepoPrepRow([task.id])).has(task.id),
  })
  if (phase === 'preparing') {
    throw new ConflictError(
      'task-repo-prep-incomplete',
      `task '${task.id}' has no worktree yet — repository preparation has not completed; ` +
        `retry the preparation step instead of ${verb}`,
    )
  }
  // AR-15's concern is `worktreeAutoGc` REMOVING the worktree (removeWorktree
  // deletes the dir), so an existence check is the right gate — and it does not
  // false-fire on tasks whose worktree dir is present but not (yet) a git repo
  // (a per-repo "source moved" edge that the diff path handles separately).
  if (!worktreeExists(task.worktreePath)) {
    gone(`worktree '${task.worktreePath}' does not exist`)
  }
  // Multi-repo: the container survived but every per-repo worktree was reclaimed.
  if (
    task.repoCount > 1 &&
    task.repos.length > 0 &&
    !task.repos.some((r) => worktreeExists(r.worktreePath))
  ) {
    gone(`task '${task.id}' has no remaining repo worktree (all reclaimed by gc)`)
  }
}

/**
 * 房间的 `continuation.assertResumable` 契约：写任何一行之前撞一次上面的判据。
 *
 * 任务不存在不归这里管——房间的可见性判据已经先跑过，会给出 404/403。
 */
export function composeWorktreeResumePreflight(
  dependencies: WorktreeResumePreflightDependencies,
): (taskId: string, verb: string) => Promise<void> {
  return async (taskId, verb) => {
    const task = await dependencies.getTask(taskId)
    if (task === null) return
    await assertWorktreePresentForResume(
      dependencies.taskRecoveryOperations,
      task,
      verb,
      dependencies.worktreeExists,
    )
  }
}
