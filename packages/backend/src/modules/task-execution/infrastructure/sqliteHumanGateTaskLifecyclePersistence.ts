// RFC-349 — Promise-shaped SQLite implementation of the human-gate park atom.

import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { SqliteHumanGateOpenParticipantInTx } from '@/modules/collaboration/infrastructure/sqliteHumanGateOpenParticipant'
import { SqliteHumanGateOperationStore } from '@/modules/collaboration/infrastructure/sqliteHumanGateOperationStore'
import { committedEventGroupId } from '@/platform/events/committed/types'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type {
  HumanGateTaskLifecycle,
  HumanGateTaskParkResult,
} from '../application/ports/humanGateTaskLifecycle'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import { LegacyHumanGateTaskLifecycle } from './legacyHumanGateTaskLifecycle'
import { createSqliteNodeRunMintParticipantInTx } from './sqliteNodeRunMintParticipant'
import { SqliteTaskOwnershipStore } from './sqliteTaskOwnership'
import { trySetTaskStatus } from '@/services/lifecycle'

class ManualQuestionPending extends Error {}

export class SqliteHumanGateTaskLifecyclePersistence implements HumanGateTaskLifecycle {
  private readonly ownership = new SqliteTaskOwnershipStore()
  private readonly operations = new SqliteHumanGateOperationStore()
  private readonly lifecycle = new LegacyHumanGateTaskLifecycle()

  constructor(private readonly db: DbClient) {}

  async parkPrepared(
    input: Parameters<HumanGateTaskLifecycle['parkPrepared']>[0],
  ): Promise<HumanGateTaskParkResult> {
    if (
      input.prepared.taskId.length === 0 ||
      input.prepared.expectedTaskRevision < 0 ||
      input.prepared.manifestDigest.length === 0 ||
      (input.token !== undefined && input.token.taskId !== input.prepared.taskId)
    ) {
      throw new Error('prepared-human-gate-task-or-manifest-mismatch')
    }
    const run = (tx: DbTxSync): HumanGateTaskParkResult => {
      const consumed = new SqliteHumanGateOpenParticipantInTx(
        tx,
        this.operations,
        createSqliteNodeRunMintParticipantInTx(tx),
      ).consumePreparedGateTx({
        prepared: input.prepared,
        taskRevision: input.prepared.expectedTaskRevision,
        now: input.now,
      })
      if (consumed.gate.kind !== input.prepared.gateKind) {
        throw new Error('prepared-human-gate-kind-mismatch')
      }
      const parked = this.lifecycle.transitionTx({
        tx,
        taskId: input.prepared.taskId,
        expectedTaskRevision: input.prepared.expectedTaskRevision,
        transition: consumed.gate.kind === 'review' ? 'park-review' : 'park-human',
        now: input.now,
        committedEventIdentity: {
          operationRef: input.prepared.operationId,
          eventGroupId: committedEventGroupId('collaboration', input.prepared.operationId),
          eventGroupOrdinal: 0,
        },
      })
      return {
        taskRevision: parked.taskRevision,
        gateRevision: consumed.gateRevision,
        nodeProjectionDigest: consumed.nodeProjectionDigest,
        committedEventRef: consumed.committedEventRef,
        eventRefs: [...parked.eventRefs, ...consumed.eventRefs],
      }
    }
    let result: HumanGateTaskParkResult
    if (input.token !== undefined) {
      result = this.ownership.withOwnedTaskTx({
        db: this.db,
        token: input.token,
        now: input.now,
        run,
      })
    } else {
      const owner = this.ownership.read(this.db, input.prepared.taskId)
      if (owner !== null && owner.state !== 'released') {
        throw new Error('ownerless-human-gate-park-refuses-durable-owner')
      }
      result = dbTxSync(this.db, run)
    }
    await publishCommittedEventsAfterCommit(result.eventRefs)
    return result
  }

  async settleManualQuestionParks(
    input: Parameters<HumanGateTaskLifecycle['settleManualQuestionParks']>[0],
  ): ReturnType<HumanGateTaskLifecycle['settleManualQuestionParks']> {
    const run = (
      tx: DbTxSync,
    ): Readonly<{
      parked: boolean
      taskRevision: number | null
      operationIds: readonly string[]
      eventRefs: readonly TaskExecutionPostCommitEventRef[]
    }> => {
      const task = this.lifecycle.readManualParkCandidateTx(tx, input.taskId)
      if (task === null) {
        return { parked: false, taskRevision: null, operationIds: [], eventRefs: [] }
      }
      const gates = new SqliteHumanGateOpenParticipantInTx(
        tx,
        this.operations,
        createSqliteNodeRunMintParticipantInTx(tx),
      )
      const operationIds = gates.listPreparedManualQuestionParksTx(input.taskId)
      if (operationIds.length === 0) {
        return {
          parked: false,
          taskRevision: task.taskRevision,
          operationIds,
          eventRefs: [],
        }
      }
      let outstanding = false
      for (const operationId of operationIds) {
        outstanding ||= gates.consumeManualQuestionParkTx({
          operationId,
          taskId: input.taskId,
          now: input.now,
        }).outstanding
      }
      if (!outstanding) {
        return {
          parked: false,
          taskRevision: task.taskRevision,
          operationIds,
          eventRefs: [],
        }
      }
      const parked = this.lifecycle.transitionTx({
        tx,
        taskId: input.taskId,
        expectedTaskRevision: task.taskRevision,
        transition: 'park-human',
        now: input.now,
      })
      return {
        parked: true,
        taskRevision: parked.taskRevision,
        operationIds,
        eventRefs: parked.eventRefs,
      }
    }
    let result: ReturnType<typeof run>
    if (input.token !== undefined) {
      result = this.ownership.withOwnedTaskTx({
        db: this.db,
        token: input.token,
        now: input.now,
        run,
      })
    } else {
      const owner = this.ownership.read(this.db, input.taskId)
      if (owner !== null && owner.state !== 'released') {
        throw new Error('ownerless-manual-question-park-refuses-durable-owner')
      }
      result = dbTxSync(this.db, run)
    }
    if (result.eventRefs.length > 0) await publishCommittedEventsAfterCommit(result.eventRefs)
    return result
  }

  async trySetWhenNoManualQuestionParks(
    input: Parameters<HumanGateTaskLifecycle['trySetWhenNoManualQuestionParks']>[0],
  ): ReturnType<HumanGateTaskLifecycle['trySetWhenNoManualQuestionParks']> {
    try {
      const won = await trySetTaskStatus({
        db: this.db,
        ...input,
        onTransitionTx: (tx) => {
          if (
            new SqliteHumanGateOpenParticipantInTx(
              tx,
              this.operations,
              createSqliteNodeRunMintParticipantInTx(tx),
            ).listPreparedManualQuestionParksTx(input.taskId).length > 0
          ) {
            throw new ManualQuestionPending()
          }
        },
      })
      return { kind: 'settled', won }
    } catch (error) {
      if (error instanceof ManualQuestionPending) return { kind: 'manual-question-pending' }
      throw error
    }
  }
}
