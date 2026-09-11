// RFC-333 — module-internal composition helpers. Public participants expose
// only the bound purpose-specific interface, never the raw SQLite transaction.
//
// RFC-359 W4-D25：停靠原子不再有 provider 分叉，也不再有「legacy 同步一份 / RFC-349 一份」两条路。
// `parkPreparedHumanGate` / `settleManualQuestionParkObligations` 直接落到中立的
// `DatabaseHumanGateTaskLifecyclePersistence`——它与此前 SQLite 的 `TaskParkTransaction` /
// `ManualQuestionParkTransaction` 逐条同判据（同一个 owner 围栏、同一条 `transitionHumanGateTask`、
// 同样提交后发事件），只是两个引擎共用同一份。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { PreparedHumanGateRef } from '@/modules/collaboration/public/types'
import {
  parkTaskAtHumanGate,
  type ParkTaskAtHumanGateResult,
} from '../application/parkTaskAtHumanGate'
import {
  ManualQuestionParkRequired,
  settleManualQuestionParkObligations as settleManualQuestionParkObligationsInternal,
  type ManualQuestionParkSettleResult,
} from '../application/parkManualQuestions'
import type { TaskExecutionContextRef } from '../application/ports/taskExecutionTopology'
import { assertTaskExecutionContext } from '../application/taskExecutionContext'
import { DatabaseHumanGateTaskLifecyclePersistence } from '../infrastructure/humanGateTaskLifecyclePersistence'

// RFC-359：同步的决定接受参与者（`bindTaskDecisionParticipantInTx` →
// `LegacyHumanGateTaskLifecycle` → `transitionHumanGateTaskTx` → `writeTaskStatusTx`）整条链退役。
// 它生产侧一直零消费者——`humanGateComposition` 上那个同名包装也没人调；决定接受走的是中立的
// `acceptHumanGateDecisionTx`（`infrastructure/taskDecisionParticipant.ts`）。
export async function parkPreparedHumanGate(input: {
  // RFC-359 W7：停靠原子本来就跑在中立的 `DatabaseHumanGateTaskLifecyclePersistence` 上
  // （W4-D25），这里的 `DbClient` 只是没跟着放宽的类型标注。
  readonly db: ProviderNeutralDatabase
  readonly prepared: PreparedHumanGateRef
  readonly executionContext?: TaskExecutionContextRef
  readonly now?: number
}): Promise<ParkTaskAtHumanGateResult> {
  if (input.executionContext !== undefined) {
    assertTaskExecutionContext(input.executionContext, input.prepared.taskId)
  }
  return await parkTaskAtHumanGate(new DatabaseHumanGateTaskLifecyclePersistence(input.db), {
    prepared: input.prepared,
    ...(input.executionContext === undefined ? {} : { token: input.executionContext.token }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}

export async function settleManualQuestionParkObligations(input: {
  readonly db: ProviderNeutralDatabase
  readonly taskId: string
  readonly executionContext?: TaskExecutionContextRef
  readonly now?: number
}): Promise<ManualQuestionParkSettleResult> {
  if (input.executionContext !== undefined) {
    assertTaskExecutionContext(input.executionContext, input.taskId)
  }
  return await settleManualQuestionParkObligationsInternal(
    new DatabaseHumanGateTaskLifecyclePersistence(input.db),
    {
      taskId: input.taskId,
      ...(input.executionContext === undefined ? {} : { token: input.executionContext.token }),
      ...(input.now === undefined ? {} : { now: input.now }),
    },
  )
}

export { ManualQuestionParkRequired }
