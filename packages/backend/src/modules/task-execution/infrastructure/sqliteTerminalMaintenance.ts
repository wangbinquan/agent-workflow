import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { dbTxSync } from '@/db/txSync'
import {
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionMaintenanceClaims,
  taskExecutionMaintenanceMembers,
  taskExecutionOwners,
  tasks,
} from '@/db/schema'
import type {
  RecoverableTerminalMaintenanceClaim,
  TerminalMaintenanceStore,
} from '../application/ports/terminalMaintenanceStore'
import { TaskExecutionError } from '../application/taskExecutionError'
import { canonicalJson } from '../domain/executionIntent'
import {
  assertMaintenanceTransition,
  maintenanceMemberSetDigest,
  type MaintenanceMemberSnapshot,
  type TerminalMaintenanceState,
} from '../domain/terminalMaintenance'
import {
  assertTerminalMaintenanceClaim,
  createTerminalMaintenanceClaim,
  type TerminalMaintenanceClaim,
  type TerminalMaintenanceOperation,
} from '../domain/ownership'

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function ledgerDigestTx(tx: DbTxSync, taskId: string): string {
  const effects = tx
    .select({
      id: taskExecutionEffects.id,
      lineage: taskExecutionEffects.executionLineageId,
      family: taskExecutionEffects.operationFamilyKey,
      generation: taskExecutionEffects.operationGeneration,
      state: taskExecutionEffects.state,
      requestHash: taskExecutionEffects.requestHash,
      slotPathDigest: taskExecutionEffects.slotPathDigest,
    })
    .from(taskExecutionEffects)
    .where(eq(taskExecutionEffects.taskId, taskId))
    .orderBy(taskExecutionEffects.id)
    .all()
  const records = tx
    .select({
      id: taskExecutionLineageOperationRecords.id,
      kind: taskExecutionLineageOperationRecords.recordKind,
      lineage: taskExecutionLineageOperationRecords.executionLineageId,
      family: taskExecutionLineageOperationRecords.operationFamilyKey,
      generation: taskExecutionLineageOperationRecords.operationGeneration,
      watermark: taskExecutionLineageOperationRecords.highestSettledGeneration,
      decision: taskExecutionLineageOperationRecords.decisionState,
      revision: taskExecutionLineageOperationRecords.recordRevision,
      requestHash: taskExecutionLineageOperationRecords.requestHash,
      slotPathDigest: taskExecutionLineageOperationRecords.slotPathDigest,
    })
    .from(taskExecutionLineageOperationRecords)
    .where(
      or(
        eq(taskExecutionLineageOperationRecords.rootAnchorTaskId, taskId),
        eq(taskExecutionLineageOperationRecords.ancestorAnchorTaskId, taskId),
        eq(taskExecutionLineageOperationRecords.currentAnchorTaskId, taskId),
        eq(taskExecutionLineageOperationRecords.sourceTaskId, taskId),
      ),
    )
    .orderBy(taskExecutionLineageOperationRecords.id)
    .all()
  return sha256({ effects, records })
}

function assertSettledLedgerCoverageTx(tx: DbTxSync, taskId: string): void {
  const effects = tx
    .select()
    .from(taskExecutionEffects)
    .where(eq(taskExecutionEffects.taskId, taskId))
    .all()
  for (const effect of effects) {
    if (effect.state === 'open') {
      throw new TaskExecutionError(
        'task-terminal-maintenance-conflict',
        `task '${taskId}' still has open execution effect '${effect.id}'`,
      )
    }
    const watermark = tx
      .select()
      .from(taskExecutionLineageOperationRecords)
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
          eq(taskExecutionLineageOperationRecords.executionLineageId, effect.executionLineageId),
          eq(taskExecutionLineageOperationRecords.operationFamilyKey, effect.operationFamilyKey),
        ),
      )
      .get()
    if (
      watermark === undefined ||
      (watermark.highestSettledGeneration ?? -1) < effect.operationGeneration ||
      watermark.requestHash !== effect.requestHash ||
      watermark.slotPathDigest !== effect.slotPathDigest
    ) {
      throw new TaskExecutionError(
        'task-terminal-maintenance-conflict',
        `task '${taskId}' effect '${effect.id}' lacks a complete retained watermark`,
      )
    }
    if (effect.state === 'outcome-unknown') {
      const decision = tx
        .select({ id: taskExecutionLineageOperationRecords.id })
        .from(taskExecutionLineageOperationRecords)
        .where(
          and(
            eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
            eq(taskExecutionLineageOperationRecords.executionLineageId, effect.executionLineageId),
            eq(taskExecutionLineageOperationRecords.operationFamilyKey, effect.operationFamilyKey),
            eq(
              taskExecutionLineageOperationRecords.operationGeneration,
              effect.operationGeneration,
            ),
          ),
        )
        .get()
      if (decision === undefined) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          `task '${taskId}' unknown effect '${effect.id}' lacks a retained replay decision`,
        )
      }
    }
  }
}

function assertMemberQuiescentTx(tx: DbTxSync, member: MaintenanceMemberSnapshot): void {
  const task = tx
    .select({
      status: tasks.status,
      revision: tasks.lifecycleEventRevision,
      topologyRevision: tasks.branchStartedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, member.taskId))
    .get()
  if (
    task === undefined ||
    !['done', 'failed', 'canceled', 'interrupted'].includes(task.status) ||
    task.revision !== member.taskRevision ||
    task.topologyRevision !== member.topologyRevision
  ) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${member.taskId}' changed before terminal maintenance claim`,
    )
  }
  const owner = tx
    .select({ state: taskExecutionOwners.state, revision: taskExecutionOwners.revision })
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, member.taskId))
    .get()
  if (
    (owner?.revision ?? null) !== member.ownerRevision ||
    (owner !== undefined && owner.state !== 'released')
  ) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${member.taskId}' execution owner is not released`,
    )
  }
  const activeIntent = tx
    .select({ id: taskExecutionIntents.id })
    .from(taskExecutionIntents)
    .where(
      and(
        eq(taskExecutionIntents.taskId, member.taskId),
        inArray(taskExecutionIntents.state, ['pending', 'claimed']),
      ),
    )
    .get()
  const activeAttempt = tx
    .select({ id: taskExecutionEffectAttempts.id })
    .from(taskExecutionEffectAttempts)
    .innerJoin(
      taskExecutionEffects,
      eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
    )
    .where(
      and(
        eq(taskExecutionEffects.taskId, member.taskId),
        inArray(taskExecutionEffectAttempts.state, ['prepared', 'acting', 'recovery-required']),
      ),
    )
    .get()
  const activeHold = tx
    .select({ id: taskExecutionEffectFences.effectAttemptId })
    .from(taskExecutionEffectFences)
    .innerJoin(
      taskExecutionEffectAttempts,
      eq(taskExecutionEffectAttempts.id, taskExecutionEffectFences.effectAttemptId),
    )
    .innerJoin(
      taskExecutionEffects,
      eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
    )
    .where(
      and(
        eq(taskExecutionEffects.taskId, member.taskId),
        isNull(taskExecutionEffectFences.releasedAt),
      ),
    )
    .get()
  if (activeIntent !== undefined || activeAttempt !== undefined || activeHold !== undefined) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${member.taskId}' execution plane is not quiescent`,
    )
  }
  assertSettledLedgerCoverageTx(tx, member.taskId)
  if (ledgerDigestTx(tx, member.taskId) !== member.ledgerDigest) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${member.taskId}' execution ledger changed before maintenance claim`,
    )
  }
}

export class SqliteTerminalMaintenanceStore implements TerminalMaintenanceStore {
  listRecoverable(input: {
    db: DbClient
    operation?: TerminalMaintenanceOperation
    rootTaskId?: string
  }): readonly RecoverableTerminalMaintenanceClaim[] {
    return dbTxSync(input.db, (tx) => {
      const predicates = [
        inArray(taskExecutionMaintenanceClaims.state, [
          'claimed',
          'io-complete',
          'db-finalized',
          'cleanup-pending',
          'recovery-required',
        ]),
      ]
      if (input.operation !== undefined) {
        predicates.push(eq(taskExecutionMaintenanceClaims.operation, input.operation))
      }
      if (input.rootTaskId !== undefined) {
        predicates.push(eq(taskExecutionMaintenanceClaims.rootTaskId, input.rootTaskId))
      }
      const rows = tx
        .select()
        .from(taskExecutionMaintenanceClaims)
        .where(and(...predicates))
        .orderBy(taskExecutionMaintenanceClaims.createdAt, taskExecutionMaintenanceClaims.id)
        .all()
      return rows.map((row) => {
        const members = tx
          .select()
          .from(taskExecutionMaintenanceMembers)
          .where(eq(taskExecutionMaintenanceMembers.claimId, row.id))
          .orderBy(taskExecutionMaintenanceMembers.taskId)
          .all()
          .map((member) => ({
            taskId: member.taskId,
            taskRevision: member.expectedTaskRevision,
            ownerRevision: member.expectedOwnerRevision,
            topologyRevision: member.expectedTopologyRevision,
            ledgerDigest: member.expectedLedgerDigest,
          }))
        return {
          claim: createTerminalMaintenanceClaim({
            claimId: row.id,
            operation: row.operation,
            revision: row.revision,
            memberSetDigest: row.memberSetDigest,
          }),
          rootTaskId: row.rootTaskId,
          state: row.state as Exclude<TerminalMaintenanceState, 'completed'>,
          cleanupPlanJson: row.cleanupPlanJson,
          members,
        }
      })
    })
  }

  snapshotMembers(db: DbClient, taskIds: readonly string[]): readonly MaintenanceMemberSnapshot[] {
    const uniqueIds = [...new Set(taskIds)].sort()
    if (uniqueIds.length === 0) {
      throw new TaskExecutionError(
        'task-terminal-maintenance-conflict',
        'terminal maintenance requires at least one task',
      )
    }
    return dbTxSync(db, (tx) =>
      uniqueIds.map((id) => {
        const row = tx
          .select({
            revision: tasks.lifecycleEventRevision,
            topologyRevision: tasks.branchStartedAt,
          })
          .from(tasks)
          .where(eq(tasks.id, id))
          .get()
        if (row === undefined) {
          throw new TaskExecutionError(
            'task-terminal-maintenance-conflict',
            `task '${id}' does not exist`,
          )
        }
        const owner = tx
          .select({ revision: taskExecutionOwners.revision })
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, id))
          .get()
        return {
          taskId: id,
          taskRevision: row.revision,
          ownerRevision: owner?.revision ?? null,
          topologyRevision: row.topologyRevision,
          ledgerDigest: ledgerDigestTx(tx, id),
        }
      }),
    )
  }

  snapshotTree(db: DbClient, rootTaskId: string): readonly MaintenanceMemberSnapshot[] {
    const ids = dbTxSync(db, (tx) => {
      const rows = tx.all(sql`
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM tasks WHERE id = ${rootTaskId}
          UNION
          SELECT child.id FROM tasks child JOIN tree parent ON child.parent_task_id = parent.id
        )
        SELECT id FROM tree ORDER BY id
      `) as Array<{ id: string }>
      if (rows.length === 0) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          `task '${rootTaskId}' does not exist`,
        )
      }
      return rows.map((row) => row.id)
    })
    return this.snapshotMembers(db, ids)
  }

  claim(input: {
    db: DbClient
    rootTaskId: string
    operation: TerminalMaintenanceOperation
    members: readonly MaintenanceMemberSnapshot[]
    cleanupPlanJson: string
    now?: number
  }): TerminalMaintenanceClaim {
    JSON.parse(input.cleanupPlanJson)
    const now = input.now ?? Date.now()
    const memberSetDigest = maintenanceMemberSetDigest(input.operation, input.members)
    const expectedTreeDigest = sha256(
      input.members.map((member) => ({
        taskId: member.taskId,
        taskRevision: member.taskRevision,
        topologyRevision: member.topologyRevision,
      })),
    )
    const claimId = ulid()
    dbTxSync(input.db, (tx) => {
      for (const member of input.members) assertMemberQuiescentTx(tx, member)
      tx.insert(taskExecutionMaintenanceClaims)
        .values({
          id: claimId,
          rootTaskId: input.rootTaskId,
          operation: input.operation,
          state: 'claimed',
          memberSetDigest,
          expectedTreeDigest,
          revision: 1,
          cleanupPlanJson: input.cleanupPlanJson,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      tx.insert(taskExecutionMaintenanceMembers)
        .values(
          input.members.map((member) => ({
            claimId,
            taskId: member.taskId,
            expectedTaskRevision: member.taskRevision,
            expectedOwnerRevision: member.ownerRevision,
            expectedTopologyRevision: member.topologyRevision,
            expectedLedgerDigest: member.ledgerDigest,
          })),
        )
        .run()
    })
    return createTerminalMaintenanceClaim({
      claimId,
      operation: input.operation,
      revision: 1,
      memberSetDigest,
    })
  }

  assertClaimTx(input: {
    tx: DbTxSync
    claim: TerminalMaintenanceClaim
    expectedState: TerminalMaintenanceState
  }): void {
    assertTerminalMaintenanceClaim(input.claim)
    const row = input.tx
      .select()
      .from(taskExecutionMaintenanceClaims)
      .where(eq(taskExecutionMaintenanceClaims.id, input.claim.claimId))
      .get()
    if (
      row === undefined ||
      row.operation !== input.claim.operation ||
      row.memberSetDigest !== input.claim.memberSetDigest ||
      row.revision !== input.claim.revision ||
      row.state !== input.expectedState
    ) {
      throw new TaskExecutionError(
        'task-terminal-maintenance-conflict',
        `terminal maintenance claim '${input.claim.claimId}' changed`,
      )
    }
  }

  transition(input: {
    db: DbClient
    claim: TerminalMaintenanceClaim
    to: TerminalMaintenanceState
    now?: number
    releaseMembers?: boolean
  }): TerminalMaintenanceClaim {
    const now = input.now ?? Date.now()
    return dbTxSync(input.db, (tx) =>
      this.transitionTx({
        tx,
        claim: input.claim,
        to: input.to,
        now,
        releaseMembers: input.releaseMembers ?? false,
      }),
    )
  }

  transitionTx(input: {
    tx: DbTxSync
    claim: TerminalMaintenanceClaim
    to: TerminalMaintenanceState
    now: number
    releaseMembers?: boolean
  }): TerminalMaintenanceClaim {
    const row = input.tx
      .select({ state: taskExecutionMaintenanceClaims.state })
      .from(taskExecutionMaintenanceClaims)
      .where(eq(taskExecutionMaintenanceClaims.id, input.claim.claimId))
      .get()
    if (row === undefined) {
      throw new TaskExecutionError(
        'task-terminal-maintenance-conflict',
        `terminal maintenance claim '${input.claim.claimId}' does not exist`,
      )
    }
    this.assertClaimTx({ tx: input.tx, claim: input.claim, expectedState: row.state })
    assertMaintenanceTransition(row.state, input.to)
    const nextRevision = input.claim.revision + 1
    const updated = input.tx
      .update(taskExecutionMaintenanceClaims)
      .set({
        state: input.to,
        revision: nextRevision,
        updatedAt: input.now,
        completedAt: input.to === 'completed' ? input.now : null,
      })
      .where(
        and(
          eq(taskExecutionMaintenanceClaims.id, input.claim.claimId),
          eq(taskExecutionMaintenanceClaims.revision, input.claim.revision),
          eq(taskExecutionMaintenanceClaims.state, row.state),
        ),
      )
      .returning({ id: taskExecutionMaintenanceClaims.id })
      .get()
    if (updated === undefined) {
      throw new TaskExecutionError(
        'task-terminal-maintenance-conflict',
        `terminal maintenance claim '${input.claim.claimId}' transition lost`,
      )
    }
    if (input.releaseMembers === true || input.to === 'completed') {
      input.tx
        .update(taskExecutionMaintenanceMembers)
        .set({ releasedAt: input.now })
        .where(
          and(
            eq(taskExecutionMaintenanceMembers.claimId, input.claim.claimId),
            isNull(taskExecutionMaintenanceMembers.releasedAt),
          ),
        )
        .run()
    }
    return createTerminalMaintenanceClaim({
      claimId: input.claim.claimId,
      operation: input.claim.operation,
      revision: nextRevision,
      memberSetDigest: input.claim.memberSetDigest,
    })
  }

  complete(input: { db: DbClient; claim: TerminalMaintenanceClaim; now?: number }): void {
    this.transition({ db: input.db, claim: input.claim, to: 'completed', now: input.now })
  }
}
