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
import {
  assertTaskExecutionContext,
  currentTaskExecutionContext,
  runWithTaskExecutionContext,
} from '../application/taskExecutionContext'
import type { HumanGateTaskWritePurposes } from '../application/ports/humanGateTaskLifecycle'
import { selectHumanGateTaskWrites } from '../application/humanGateTaskWriteSelection'
import { taskHostWorkForToken } from '../application/taskHostAdmission'
import { DatabaseHumanGateTaskLifecyclePersistence } from '../infrastructure/humanGateTaskLifecyclePersistence'
import { createSelectedHumanGateTaskWritePurposes } from '../infrastructure/taskHostHumanGateWritePurposes'
import { taskOwnershipHostBinding } from '../infrastructure/taskOwnershipPersistence'
import { createTaskRuntimeLifecyclePersistence } from './taskExecutionPersistence'
import type { TaskExecutionPersistenceDependencies } from './taskExecutionPersistence'

/** Resolve the original context and its ownership binding before a durable await.
 * Caller dependencies retain precedence over context-derived dependencies. */
function resolveHumanGateTaskWrites(
  input: {
    readonly db: ProviderNeutralDatabase
    readonly executionContext?: TaskExecutionContextRef
    readonly writePurpose?: keyof HumanGateTaskWritePurposes
  } & TaskExecutionPersistenceDependencies,
  taskId: string,
) {
  const context = input.executionContext ?? currentTaskExecutionContext(taskId)
  const selectedContext =
    context !== undefined &&
    (context.persistence.humanGateWriteMode !== undefined ||
      context.persistence.humanGateWritePurposes !== undefined ||
      taskHostWorkForToken(context.token) !== undefined)
  const binding =
    input.hostWrites ??
    (context === undefined ? undefined : taskOwnershipHostBinding(context.persistence.ownership))
  if (selectedContext && binding === undefined) {
    throw new Error('human-gate-task-host-binding-not-composed')
  }
  const native = new DatabaseHumanGateTaskLifecyclePersistence(
    input.db,
    createTaskRuntimeLifecyclePersistence(input.db, input),
  )
  if (binding === undefined) return { lifecycle: native, context, selected: false }
  const purpose = input.writePurpose
  if (purpose === undefined) throw new Error('human-gate-task-write-purpose-required')
  if (
    context !== undefined &&
    (context.persistence.humanGateWriteMode !== undefined ||
      context.persistence.humanGateWritePurposes !== undefined)
  ) {
    selectHumanGateTaskWrites(context.persistence, purpose)
  }
  const views = createSelectedHumanGateTaskWritePurposes({
    humanGateLifecycle: native,
    hostWrites: binding,
  })
  return { lifecycle: views[purpose], context, selected: true }
}

// RFC-359：同步的决定接受参与者（`bindTaskDecisionParticipantInTx` →
// `LegacyHumanGateTaskLifecycle` → `transitionHumanGateTaskTx` → `writeTaskStatusTx`）整条链退役。
// 它生产侧一直零消费者——`humanGateComposition` 上那个同名包装也没人调；决定接受走的是中立的
// `acceptHumanGateDecisionTx`（`infrastructure/taskDecisionParticipant.ts`）。
export async function parkPreparedHumanGate(
  input: {
    // RFC-359 W7：停靠原子本来就跑在中立的 `DatabaseHumanGateTaskLifecyclePersistence` 上
    // （W4-D25），这里的 `DbClient` 只是没跟着放宽的类型标注。
    readonly db: ProviderNeutralDatabase
    readonly prepared: PreparedHumanGateRef
    readonly executionContext?: TaskExecutionContextRef
    readonly writePurpose?: keyof HumanGateTaskWritePurposes
    readonly now?: number
  } & TaskExecutionPersistenceDependencies,
): Promise<ParkTaskAtHumanGateResult> {
  if (input.executionContext !== undefined) {
    assertTaskExecutionContext(input.executionContext, input.prepared.taskId)
  }
  const selection = resolveHumanGateTaskWrites(input, input.prepared.taskId)
  const run = () =>
    parkTaskAtHumanGate(selection.lifecycle, {
      prepared: input.prepared,
      ...(input.executionContext === undefined ? {} : { token: input.executionContext.token }),
      ...(input.now === undefined ? {} : { now: input.now }),
    })
  return await (selection.selected && selection.context !== undefined
    ? runWithTaskExecutionContext(selection.context, run)
    : run())
}

export async function settleManualQuestionParkObligations(
  input: {
    readonly db: ProviderNeutralDatabase
    readonly taskId: string
    readonly executionContext?: TaskExecutionContextRef
    readonly writePurpose?: keyof HumanGateTaskWritePurposes
    readonly now?: number
  } & TaskExecutionPersistenceDependencies,
): Promise<ManualQuestionParkSettleResult> {
  if (input.executionContext !== undefined) {
    assertTaskExecutionContext(input.executionContext, input.taskId)
  }
  const selection = resolveHumanGateTaskWrites(input, input.taskId)
  const run = () =>
    settleManualQuestionParkObligationsInternal(selection.lifecycle, {
      taskId: input.taskId,
      ...(input.executionContext === undefined ? {} : { token: input.executionContext.token }),
      ...(input.now === undefined ? {} : { now: input.now }),
    })
  return await (selection.selected && selection.context !== undefined
    ? runWithTaskExecutionContext(selection.context, run)
    : run())
}

export { ManualQuestionParkRequired }
