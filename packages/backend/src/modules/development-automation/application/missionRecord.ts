// 「把刚产出的东西记到 mission 行上」的 OCC 写回——**一份实现**，reconcile 路径共用。
//
// 由来（2026-09-07，`rfc310-pr3-journey` 停顿的真因）：这类写此前是 13 处
// 「`getMission` 读一行 → 直接 `occUpdate` → **不看返回值**」的复制粘贴。两步之间只要有并发
// 写手 bump 了 revision（路由的 fire-and-forget reconcile、定时器、另一轮泵都会），补丁就
// **静默丢失**。丢的偏偏是 `repositoryFactsRef` / `requirementBundleRef` / `mrClaimId` /
// `deliverySourceBranch` / 状态这类**决策依据**：丢掉之后 mission 看起来仍处在「还没做那件事」，
// 而决策的 `decisionInputDigest` 一个字节都没变 ⇒ 下一轮被去重 ⇒ handler 再也不跑 ⇒
// mission 永久停在 `working`（无错误、无 blockCode，把任何预算耗光）。
//
// 它单独成文件而不是挂在 `missionReconciler` 上，是因为 orchestrator 与 actionInvalidation
// 都要用，而它们本来就被 reconciler 依赖——挂在那边会成环（depcheck no-circular 实测拦下）。
// 论归属它也确实是持久化关注点，只依赖 mission store 端口，不认识 reconcile 的任何东西。

import type { MissionPersistence, MissionRow } from './ports/missionStore'

/** 这个 helper 真正用到的最小写面——调用方不必凑出整个 `ReconcileDeps`。 */
export interface MissionRecordDeps {
  readonly store: Pick<MissionPersistence, 'getMission' | 'occUpdate'>
}

/**
 * 按最新一行重算补丁并写回；修订漂移就重读重试。
 *
 * - `build` 每次都拿**重读到的**那一行，守卫条件（`status !== 'blocked'`、
 *   `currentActionRunId === x`、`checkMissionTransition`）要写在里面，不能拿旧快照判；
 *   返回 `null` 表示「按当前状态不该写」，直接收工。
 * - **epoch 冲突不重试**：epoch+1 是 cancel/handover/resume 有意让在途 continuation 过期，
 *   那时候把旧产物记回去才是错的。
 */
export async function recordOnMission(
  deps: MissionRecordDeps,
  missionId: string,
  build: (fresh: MissionRow) => Parameters<MissionPersistence['occUpdate']>[3] | null,
  attempts = 8,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const fresh = await deps.store.getMission(missionId)
    if (fresh === null) return false
    const patch = build(fresh)
    if (patch === null) return false
    const result = await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, patch)
    if (result.ok) return true
    if (result.code !== 'revision-conflict') return false
  }
  return false
}
