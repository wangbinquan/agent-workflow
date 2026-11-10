// RFC-477: the node-run rollback outcome and its user-visible summary, moved unchanged from services/nodeRollback.ts
// (the rollback itself — target loading, git and the RFC-328 effect journal — is infrastructure/nodeRollback.ts).

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
