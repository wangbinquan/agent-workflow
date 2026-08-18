// RFC-310 PR-3 —— 30s 级 wake sweep（daemon 定时面）。
//
// 与 missionRecovery 第 3 步同一机制（定时/恢复没有专用逻辑，design §2.6）：
//   1. 到期 durable wake：fireWake 的 armed→fired CAS 即认领——重复 sweep /
//      并发 sweeper 不重触发；
//   2. 未消费 wake hint（外部事件提示）：逐 mission reconcile 一轮，hint 由
//      reconcile 顶部 consumeWakeHints 消费。
// resumeAt NULL 的 wake 永不因时间 due（listDueWakes 语义），平台渠道
// awaiting-answers 的 wait-wake 不会被这里空转。

import { runMissionReconcile, type ReconcileDeps } from './missionReconciler'

export interface WakeSweepReaders {
  listUnconsumedWakeHintMissionIds(): string[]
}

export async function sweepMissionWakes(
  deps: ReconcileDeps,
  readers: WakeSweepReaders,
): Promise<{ reconciled: number }> {
  const now = deps.now()
  let reconciled = 0
  for (const wake of deps.store.listDueWakes(now)) {
    if (deps.store.fireWake(wake.id, now)) {
      await runMissionReconcile(deps, wake.missionId)
      reconciled += 1
    }
  }
  for (const missionId of readers.listUnconsumedWakeHintMissionIds()) {
    const outcome = await runMissionReconcile(deps, missionId)
    if (outcome.kind !== 'not-found') reconciled += 1
  }
  return { reconciled }
}
