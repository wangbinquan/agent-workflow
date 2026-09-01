// RFC-310 PR-5 T55 —— answers 回流对 in-flight action 的失效收束。
//
// 新 answer revision 提交（平台渠道 submitMissionAnswers / 原渠道
// collect-requirement-answers 收齐）意味着 in-flight Agent 动作的输入已过期：
// 继续等它完成再采信，等于让 Agent 基于旧需求语境交付。收束语义：
//   launcher.cancel（尽力；本地台账是权威）→ attempt settle 'discarded'
//   （rejection {code:reason}）→ run settle failed(reason) →
//   currentActionRunId 清。**不计 fresh 预算**：失效后规则会开新 ActionRun
//   （rerunSeq 从 0 重计），旧 run 的预算台账随 run 终结。
//
// 幂等：无 in-flight attempt 时是 no-op（返回 false）。

import type { MissionRow, MissionPersistence } from './ports/missionStore'
import type { ReconcilerPorts } from './ports/reconcilerPorts'

export interface InvalidateActionDeps {
  readonly store: MissionPersistence
  readonly ports?: ReconcilerPorts
  readonly now: () => number
}

export async function invalidateInFlightAction(
  deps: InvalidateActionDeps,
  mission: MissionRow,
  reason: 'input-invalidated',
): Promise<boolean> {
  const actionRunId = mission.currentActionRunId
  if (actionRunId === null) return false
  const attempts = await deps.store.listAttempts(actionRunId)
  const attempt = attempts[attempts.length - 1]
  const now = deps.now()
  if (attempt !== undefined && (attempt.status === 'claimed' || attempt.status === 'running')) {
    if (attempt.executionRef !== null && deps.ports?.agentLauncher !== undefined) {
      try {
        await deps.ports!.agentLauncher!.cancel(attempt.executionRef)
      } catch {
        // cancel 是尽力而为：进程侧由 task-execution 的孤儿收敛兜底。
      }
    }
    await deps.store.settleAttempt({
      id: attempt.id,
      status: 'discarded',
      rejectionJson: JSON.stringify({ code: reason }),
      outcomeRef: null,
      now,
    })
  }
  await deps.store.settleActionRun({
    id: actionRunId,
    status: 'failed',
    resultRef: null,
    failureJson: JSON.stringify({
      category: 'stale-input',
      code: reason,
      retryability: 'same-input',
      attemptOrdinal: attempt?.attemptSeq ?? 0,
      remediation: 'a newer answer revision superseded this action input',
      evidenceRef: null,
    }),
    now,
  })
  const fresh = await deps.store.getMission(mission.id)
  if (fresh !== null && fresh.currentActionRunId === actionRunId) {
    await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, { currentActionRunId: null })
  }
  return true
}
