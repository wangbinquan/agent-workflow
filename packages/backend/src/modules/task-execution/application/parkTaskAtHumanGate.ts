// RFC-333 — one owned TaskParkTx consuming a prepared collaboration gate.

import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type { PreparedHumanGateRef } from '@/modules/collaboration/public/types'
import { withExistingSQLiteTransactionScope } from '@/platform/persistence/sqlite/existingTransactionScope'
import type { OwnershipToken } from '../domain/ownership'
import type { HumanGateOpenParticipant } from './ports/humanGateOpenParticipant'
import type { HumanGateTaskLifecycle } from './ports/humanGateTaskLifecycle'
import type { TaskOwnershipStore } from './ports/taskOwnershipStore'

export interface ParkTaskAtHumanGateResult {
  readonly taskRevision: number
  readonly gateRevision: number
  readonly nodeProjectionDigest: string
  readonly committedEventRef: string
}

type ParkTaskAtHumanGateInternalResult = ParkTaskAtHumanGateResult &
  Readonly<{ eventRefs: readonly import('@/platform/events/committed/types').CommittedEventRef[] }>

export class TaskParkTransaction {
  constructor(
    private readonly ownership: TaskOwnershipStore,
    private readonly humanGates: HumanGateOpenParticipant,
    private readonly lifecycle: HumanGateTaskLifecycle,
  ) {}

  park(input: {
    readonly db: DbClient
    readonly token: OwnershipToken
    readonly prepared: PreparedHumanGateRef
    readonly now: number
  }): ParkTaskAtHumanGateResult {
    this.assertInput(input.token.taskId, input.prepared)
    const result = this.ownership.withOwnedTaskTx({
      db: input.db,
      token: input.token,
      now: input.now,
      run: (tx) => this.parkInTx(tx, input.prepared, input.now),
    })
    this.lifecycle.publishAfterCommit(result.eventRefs)
    const { eventRefs: _eventRefs, ...publicResult } = result
    return publicResult
  }

  /**
   * Compatibility seam for direct ownerless scheduler fixtures. A durable
   * owner can never enter here; production-owned drives use {@link park}.
   */
  parkOwnerless(input: {
    readonly db: DbClient
    readonly prepared: PreparedHumanGateRef
    readonly now: number
  }): ParkTaskAtHumanGateResult {
    this.assertInput(input.prepared.taskId, input.prepared)
    const owner = this.ownership.read(input.db, input.prepared.taskId)
    if (owner !== null && owner.state !== 'released') {
      throw new Error('ownerless-human-gate-park-refuses-durable-owner')
    }
    const result = dbTxSync(input.db, (tx) => this.parkInTx(tx, input.prepared, input.now))
    this.lifecycle.publishAfterCommit(result.eventRefs)
    const { eventRefs: _eventRefs, ...publicResult } = result
    return publicResult
  }

  private assertInput(taskId: string, prepared: PreparedHumanGateRef): void {
    if (
      prepared.taskId !== taskId ||
      prepared.expectedTaskRevision < 0 ||
      prepared.manifestDigest.length === 0
    ) {
      throw new Error('prepared-human-gate-task-or-manifest-mismatch')
    }
  }

  private parkInTx(
    tx: DbTxSync,
    prepared: PreparedHumanGateRef,
    now: number,
  ): ParkTaskAtHumanGateInternalResult {
    let result: ParkTaskAtHumanGateInternalResult | undefined
    withExistingSQLiteTransactionScope(tx, (transactionScope): undefined => {
      const consumed = this.humanGates.consumePreparedGateTx({
        transactionScope,
        prepared,
        taskRevision: prepared.expectedTaskRevision,
        now,
      })
      if (consumed.gate.kind !== prepared.gateKind) {
        throw new Error('prepared-human-gate-kind-mismatch')
      }
      const parked = this.lifecycle.transitionTx({
        tx,
        taskId: prepared.taskId,
        expectedTaskRevision: prepared.expectedTaskRevision,
        transition: consumed.gate.kind === 'review' ? 'park-review' : 'park-human',
        now,
      })
      result = {
        taskRevision: parked.taskRevision,
        gateRevision: consumed.gateRevision,
        nodeProjectionDigest: consumed.nodeProjectionDigest,
        committedEventRef: consumed.committedEventRef,
        eventRefs: parked.eventRefs,
      }
      return undefined
    })
    if (result === undefined) throw new Error('human-gate park returned no result')
    return result
  }
}
