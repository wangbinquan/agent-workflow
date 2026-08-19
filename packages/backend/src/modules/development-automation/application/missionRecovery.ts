// RFC-310 PR-2 T30 —— daemon 启动恢复扫描（design.md §11.4 的 PR-2 覆盖面）。
//
// 三类悬挂状态的收束，全部走与正常路径**相同**的机制（定时/恢复没有专用
// 逻辑，design §2.6）：
//   1. fence 悬挂（cancel/handoff-pending）→ 重跑 reconcile 的 settle 路径；
//   2. epoch 过期的 prepared effect → invalidate（fence/upgrade 已把旧
//      continuation 摘除，它们准备的副作用不得再派发）；
//   3. 到期的 deferred wake → fireWake（ordinal 语义由 domain/deferredWake
//      保证：early/重启都不清零）→ reconcile。
// Agent attempt 的 interrupted 结算属 task-execution 联动，归 PR-4 T51。

import { runMissionReconcile, type ReconcileDeps } from './missionReconciler'
import { driveMission } from './missionDriver'

export interface RecoveryReaders {
  listFencedMissionIds(): string[]
  listPreparedEffectRows(): {
    readonly id: string
    readonly missionId: string
    readonly epoch: number
  }[]
  missionEpochsOf(missionIds: readonly string[]): Map<string, number>
}

export interface RecoveryReport {
  readonly settledFences: number
  readonly pendingFences: number
  readonly invalidatedEffects: number
  readonly firedWakes: number
}

export async function recoverMissions(
  deps: ReconcileDeps,
  readers: RecoveryReaders,
): Promise<RecoveryReport> {
  const now = deps.now()
  let settledFences = 0
  let pendingFences = 0
  let invalidatedEffects = 0
  let firedWakes = 0

  // 1) epoch 过期的 prepared effects（先于 fence settle——settle 会重扫剩余行）。
  const prepared = readers.listPreparedEffectRows()
  const epochs = readers.missionEpochsOf(prepared.map((row) => row.missionId))
  for (const row of prepared) {
    const currentEpoch = epochs.get(row.missionId)
    if (currentEpoch !== undefined && row.epoch < currentEpoch) {
      deps.store.invalidateEffect(row.id, now)
      invalidatedEffects += 1
    }
  }

  // 2) fence 悬挂：同一 reconcile settle 路径收束。
  for (const missionId of readers.listFencedMissionIds()) {
    const outcome = await runMissionReconcile(deps, missionId)
    if (outcome.kind === 'fence-settled') {
      settledFences += 1
      await driveMission(deps, missionId)
    } else if (outcome.kind === 'fence-pending') pendingFences += 1
  }

  // 3) 到期 wake：fire（ordinal 不清零）后走正常 reconcile。
  for (const wake of deps.store.listDueWakes(now)) {
    if (deps.store.fireWake(wake.id, now)) {
      firedWakes += 1
      await driveMission(deps, wake.missionId)
    }
  }

  return { settledFences, pendingFences, invalidatedEffects, firedWakes }
}
