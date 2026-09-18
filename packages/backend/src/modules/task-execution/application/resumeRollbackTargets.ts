/**
 * RFC-359 AC-1（第 10 刀）—— resume 的回滚目标选择器，**全仓唯一一份**。
 *
 * 在这之前它有两份**逐字相同**的副本：`services/task.ts` 的 `selectResumeRollbackTargets`
 * （resume / sync / gate-continuation 三条路共用）与
 * `childTaskLifecycleParticipant.ts` 里的同名私有函数。两份都在做同一件事，
 * 谁也没跟谁比过——正是本 RFC 反复在收的那类分叉。
 *
 * 它是纯函数、零 provider 依赖，所以落在 `application/`：两个引擎的 resume 都从这里取。
 *
 * # 判据
 *
 * 「每个节点**最新的顶层行**，且它处在 failed / interrupted，且它不是调用行」：
 *
 *   · **最新**按 ULID id 序（`r.id > prev.id`）——与调度器的取新权威同口径
 *     （`isFresherNodeRun`）。retryIndex 序是错的：clarify 驱动的重跑铸出来的行
 *     retryIndex 是 0 但 id 更新，按 retryIndex 排会让一条更旧的高 retryIndex 失败行盖住它。
 *   · **顶层**（`parentNodeRunId === null`）——扇出子行不是回滚单位。
 *   · **不是调用行**（`childTaskId === null`）：RFC-243 §4.2——调用行在 canonical 工作树上
 *     没有写（子任务在调用节点的 iso 里干活），它的 interrupted 行由调度器的领养路径处理
 *     （重新挂上 / merge_state 暂存重放），**永远不走 pre_snapshot 回滚 + 重铸**。
 */
export function selectResumeRollbackTargets<
  R extends {
    id: string
    nodeId: string
    parentNodeRunId: string | null
    status: string
    childTaskId?: string | null
  },
>(runs: readonly R[]): R[] {
  const latestPerNode = new Map<string, R>()
  for (const run of runs) {
    if (run.parentNodeRunId !== null) continue
    const previous = latestPerNode.get(run.nodeId)
    if (previous === undefined || run.id > previous.id) latestPerNode.set(run.nodeId, run)
  }
  return [...latestPerNode.values()].filter(
    (run) =>
      (run.status === 'failed' || run.status === 'interrupted') &&
      (run.childTaskId ?? null) === null,
  )
}
