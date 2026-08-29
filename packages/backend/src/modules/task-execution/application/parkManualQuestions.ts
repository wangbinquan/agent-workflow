// RFC-333 T7 — the active task owner consumes durable manual-question park obligations.

import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import { withExistingSQLiteTransactionScope } from '@/platform/persistence/sqlite/existingTransactionScope'
import type { OwnershipToken } from '../domain/ownership'
import type { HumanGateOpenParticipant } from './ports/humanGateOpenParticipant'
import type { HumanGateTaskLifecycle } from './ports/humanGateTaskLifecycle'
import type { TaskOwnershipStore } from './ports/taskOwnershipStore'

export interface ManualQuestionParkSettleResult {
  readonly consumed: number
  readonly parked: boolean
}

type ManualQuestionParkInternalResult = ManualQuestionParkSettleResult &
  Readonly<{ eventRefs: readonly CommittedEventRef[] }>

export class ManualQuestionParkRequired extends Error {
  constructor(readonly taskId: string) {
    super(`task '${taskId}' has a durable manual-question park obligation`)
    this.name = 'ManualQuestionParkRequired'
  }
}

export class ManualQuestionParkTransaction {
  constructor(
    private readonly ownership: TaskOwnershipStore,
    private readonly humanGates: HumanGateOpenParticipant,
    private readonly lifecycle: HumanGateTaskLifecycle,
  ) {}

  settle(input: {
    readonly db: DbClient
    readonly taskId: string
    readonly token?: OwnershipToken
    readonly now: number
  }): ManualQuestionParkSettleResult {
    const run = (tx: DbTxSync): ManualQuestionParkInternalResult =>
      this.settleTx(tx, input.taskId, input.now)
    let result: ManualQuestionParkInternalResult
    if (input.token !== undefined) {
      result = this.ownership.withOwnedTaskTx({
        db: input.db,
        token: input.token,
        now: input.now,
        run,
      })
    } else {
      const owner = this.ownership.read(input.db, input.taskId)
      if (owner !== null && owner.state !== 'released') {
        throw new Error('ownerless-manual-question-park-refuses-durable-owner')
      }
      result = dbTxSync(input.db, run)
    }
    if (result.parked) {
      this.lifecycle.publishAfterCommit(result.eventRefs)
    }
    const { eventRefs: _eventRefs, ...publicResult } = result
    return publicResult
  }

  private settleTx(tx: DbTxSync, taskId: string, now: number): ManualQuestionParkInternalResult {
    const task = this.lifecycle.readManualParkCandidateTx(tx, taskId)
    if (task === null) return { consumed: 0, parked: false, eventRefs: [] }
    let result: ManualQuestionParkInternalResult | undefined
    withExistingSQLiteTransactionScope(tx, (transactionScope): undefined => {
      const operationIds = this.humanGates.listPreparedManualQuestionParksTx({
        transactionScope,
        taskId,
      })
      if (operationIds.length === 0) {
        result = { consumed: 0, parked: false, eventRefs: [] }
        return
      }
      let outstanding = false
      for (const operationId of operationIds) {
        const consumed = this.humanGates.consumeManualQuestionParkTx({
          transactionScope,
          operationId,
          taskId,
          now,
        })
        outstanding ||= consumed.outstanding
      }
      if (!outstanding) {
        result = { consumed: operationIds.length, parked: false, eventRefs: [] }
        return
      }
      const parked = this.lifecycle.transitionTx({
        tx,
        taskId,
        expectedTaskRevision: task.taskRevision,
        transition: 'park-human',
        now,
      })
      result = { consumed: operationIds.length, parked: true, eventRefs: parked.eventRefs }
      return undefined
    })
    if (result === undefined) throw new Error('manual-question park returned no result')
    return result
  }
}

/** Called inside the final task-status CAS; throwing rolls that terminal write back. */
export function assertNoManualQuestionParkObligationTx(
  tx: DbTxSync,
  taskId: string,
  humanGates: HumanGateOpenParticipant,
): void {
  withExistingSQLiteTransactionScope(tx, (transactionScope): undefined => {
    if (humanGates.listPreparedManualQuestionParksTx({ transactionScope, taskId }).length > 0) {
      throw new ManualQuestionParkRequired(taskId)
    }
    return undefined
  })
}
