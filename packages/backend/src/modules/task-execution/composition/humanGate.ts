// RFC-333 — module-internal composition helpers. Public participants expose
// only the bound purpose-specific interface, never the raw SQLite transaction.

import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type { PreparedHumanGateRef } from '@/modules/collaboration/public/types'
import {
  bindTaskDecisionParticipantInTx as bindTaskDecisionParticipantInTxInternal,
  type TaskDecisionParticipantInTx,
} from '../infrastructure/sqliteTaskDecisionParticipant'
import {
  TaskParkTransaction,
  type ParkTaskAtHumanGateResult,
} from '../infrastructure/sqliteTaskParkTransaction'
import {
  ManualQuestionParkRequired,
  ManualQuestionParkTransaction,
  assertNoManualQuestionParkObligationTx as assertNoManualQuestionParkObligationTxInternal,
  type ManualQuestionParkSettleResult,
} from '../infrastructure/sqliteManualQuestionParkTransaction'
import type { TaskExecutionEffectStore } from '../infrastructure/taskExecutionEffectTransactionStore'
import type { HumanGateOpenParticipant } from '../application/ports/humanGateOpenParticipant'
import type { TaskExecutionContextRef } from '../application/ports/taskExecutionTopology'
import { assertTaskExecutionContext } from '../application/taskExecutionContext'
import { taskExecutionModule } from '../composition'
import { LegacyHumanGateTaskLifecycle } from '../infrastructure/legacyHumanGateTaskLifecycle'

const humanGateTaskLifecycle = new LegacyHumanGateTaskLifecycle()

export function bindTaskDecisionParticipantInTx(
  tx: DbTxSync,
  effects?: TaskExecutionEffectStore,
): TaskDecisionParticipantInTx {
  return bindTaskDecisionParticipantInTxInternal(tx, humanGateTaskLifecycle, effects)
}

export async function parkPreparedHumanGate(input: {
  readonly db: DbClient
  readonly humanGates: HumanGateOpenParticipant
  readonly prepared: PreparedHumanGateRef
  readonly executionContext?: TaskExecutionContextRef
  readonly now?: number
}): Promise<ParkTaskAtHumanGateResult> {
  const transaction = new TaskParkTransaction(
    taskExecutionModule.ownership,
    input.humanGates,
    humanGateTaskLifecycle,
  )
  const now = input.now ?? Date.now()
  if (input.executionContext === undefined) {
    return await transaction.parkOwnerless({ db: input.db, prepared: input.prepared, now })
  }
  assertTaskExecutionContext(input.executionContext, input.prepared.taskId)
  return await transaction.park({
    db: input.db,
    token: input.executionContext.token,
    prepared: input.prepared,
    now,
  })
}

export async function settleManualQuestionParkObligations(input: {
  readonly db: DbClient
  readonly humanGates: HumanGateOpenParticipant
  readonly taskId: string
  readonly executionContext?: TaskExecutionContextRef
  readonly now?: number
}): Promise<ManualQuestionParkSettleResult> {
  if (input.executionContext !== undefined) {
    assertTaskExecutionContext(input.executionContext, input.taskId)
  }
  return await new ManualQuestionParkTransaction(
    taskExecutionModule.ownership,
    input.humanGates,
    humanGateTaskLifecycle,
  ).settle({
    db: input.db,
    taskId: input.taskId,
    ...(input.executionContext === undefined ? {} : { token: input.executionContext.token }),
    now: input.now ?? Date.now(),
  })
}

export function assertNoManualQuestionParkObligationTx(
  tx: DbTxSync,
  taskId: string,
  humanGates: HumanGateOpenParticipant,
): void {
  assertNoManualQuestionParkObligationTxInternal(tx, taskId, humanGates)
}

export { ManualQuestionParkRequired }
