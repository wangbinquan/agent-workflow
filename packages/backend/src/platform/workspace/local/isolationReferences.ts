import { basename, join } from 'node:path'

/**
 * RFC-210 round 6 P2 —— the run id that KEYS the physical iso (worktree path +
 * ref namespaces), recovered from the persisted container path. A process-retry
 * keeps the original row's iso (D17) while its DB row is the retry mint;
 * RFC-356 additionally advances it to `{原键}-N` when a residual cannot be reclaimed.
 * Falling back to the row id preserves pre-column-era rows.
 *
 * RFC-356 T15 把它从 `modules/task-execution/composition/nodeMechanics.ts` 搬到这里：
 * `taskLifecycleRepair/options-S1.ts`（legacy 层）要用它，而从那里 import 模块
 * composition 是 RFC-317 R1 明令禁止的越界边（CI 实红）。这里才是它的**天然归属**
 * ——与 `isoWorktreePathFor` 同属 iso 键 / 路径原语，且 legacy 层本就依赖本模块。
 * 修法上选了「搬到合法位置」而不是「登记一条 R1 债」：RFC-294 的方向是消这类边，
 * 不是记账。
 */
export function isoKeyOf(isoWorktreePath: string | null, rowId: string): string {
  if (isoWorktreePath === null || isoWorktreePath === '') return rowId
  const base = basename(isoWorktreePath)
  return base === '' ? rowId : base
}

/** Absolute iso worktree path — always OUTSIDE any canonical worktree (D14). */
export function isoWorktreePathFor(
  appHome: string,
  taskId: string,
  nodeRunId: string,
  worktreeDirName: string,
): string {
  const root = join(appHome, 'iso', taskId, nodeRunId)
  return worktreeDirName === '' ? root : join(root, worktreeDirName)
}
