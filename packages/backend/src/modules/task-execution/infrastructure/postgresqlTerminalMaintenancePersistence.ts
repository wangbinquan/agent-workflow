// RFC-349 — PostgreSQL terminal-maintenance claim/CAS adapter.

import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

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
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  RecoverableTerminalMaintenanceClaim,
  TerminalMaintenanceStore,
} from '../application/ports/terminalMaintenanceStore'
import { TaskExecutionError } from '../application/taskExecutionError'
import { sha256Hex } from '../domain/digest'
import { canonicalJson } from '../domain/executionIntent'
import {
  assertTerminalMaintenanceClaim,
  createTerminalMaintenanceClaim,
  type TerminalMaintenanceClaim,
  type TerminalMaintenanceOperation,
} from '../domain/ownership'
import {
  assertMaintenanceTransition,
  maintenanceMemberSetDigest,
  type MaintenanceMemberSnapshot,
  type TerminalMaintenanceState,
} from '../domain/terminalMaintenance'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

function sha256(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

function uniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    if ((current as { readonly code?: unknown }).code === '23505') return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

async function serializable<T>(
  db: PostgresqlDatabaseClient,
  body: (tx: PgTx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(tx)
      })
    } catch (error) {
      if (await retryPostgresqlSerialization(attempt, error)) continue
      throw error
    }
  }
}

async function ledgerDigestTx(tx: PgTx, taskId: string): Promise<string> {
  const effects = await tx
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
    .orderBy(asc(taskExecutionEffects.id))
  const records = await tx
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
    .orderBy(asc(taskExecutionLineageOperationRecords.id))
  return sha256({ effects, records })
}

async function assertSettledLedgerCoverageTx(tx: PgTx, taskId: string): Promise<void> {
  const effects = await tx
    .select()
    .from(taskExecutionEffects)
    .where(eq(taskExecutionEffects.taskId, taskId))
  for (const effect of effects) {
    if (effect.state === 'open') {
      throw new TaskExecutionError(
        'task-terminal-maintenance-conflict',
        `task '${taskId}' still has open execution effect '${effect.id}'`,
      )
    }
    const watermarks = await tx
      .select()
      .from(taskExecutionLineageOperationRecords)
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
          eq(taskExecutionLineageOperationRecords.executionLineageId, effect.executionLineageId),
          eq(taskExecutionLineageOperationRecords.operationFamilyKey, effect.operationFamilyKey),
        ),
      )
      .limit(1)
    const watermark = watermarks[0]
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
      const decisions = await tx
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
        .limit(1)
      if (decisions[0] === undefined) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          `task '${taskId}' unknown effect '${effect.id}' lacks a retained replay decision`,
        )
      }
    }
  }
}

async function assertMemberQuiescentTx(tx: PgTx, member: MaintenanceMemberSnapshot): Promise<void> {
  const taskRows = await tx
    .select({
      status: tasks.status,
      revision: tasks.lifecycleEventRevision,
      topologyRevision: tasks.branchStartedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, member.taskId))
    .limit(1)
  const task = taskRows[0]
  if (
    task === undefined ||
    !isTerminalTaskStatus(task.status as TaskStatus) ||
    task.revision !== member.taskRevision ||
    task.topologyRevision !== member.topologyRevision
  ) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${member.taskId}' changed before terminal maintenance claim`,
    )
  }
  const ownerRows = await tx
    .select({ state: taskExecutionOwners.state, revision: taskExecutionOwners.revision })
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, member.taskId))
    .limit(1)
  const owner = ownerRows[0]
  if (
    (owner?.revision ?? null) !== member.ownerRevision ||
    (owner !== undefined && owner.state !== 'released')
  ) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${member.taskId}' execution owner is not released`,
    )
  }
  const activeIntents = await tx
    .select({ id: taskExecutionIntents.id })
    .from(taskExecutionIntents)
    .where(
      and(
        eq(taskExecutionIntents.taskId, member.taskId),
        inArray(taskExecutionIntents.state, ['pending', 'claimed']),
      ),
    )
    .limit(1)
  const activeAttempts = await tx
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
    .limit(1)
  const activeHolds = await tx
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
    .limit(1)
  if (
    activeIntents[0] !== undefined ||
    activeAttempts[0] !== undefined ||
    activeHolds[0] !== undefined
  ) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${member.taskId}' execution plane is not quiescent`,
    )
  }
  await assertSettledLedgerCoverageTx(tx, member.taskId)
  if ((await ledgerDigestTx(tx, member.taskId)) !== member.ledgerDigest) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${member.taskId}' execution ledger changed before maintenance claim`,
    )
  }
}

async function snapshotMembersTx(
  tx: PgTx,
  taskIds: readonly string[],
): Promise<readonly MaintenanceMemberSnapshot[]> {
  const uniqueIds = [...new Set(taskIds)].sort()
  if (uniqueIds.length === 0) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      'terminal maintenance requires at least one task',
    )
  }
  const snapshots: MaintenanceMemberSnapshot[] = []
  for (const id of uniqueIds) {
    const rows = await tx
      .select({
        revision: tasks.lifecycleEventRevision,
        topologyRevision: tasks.branchStartedAt,
      })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1)
    const row = rows[0]
    if (row === undefined) {
      throw new TaskExecutionError(
        'task-terminal-maintenance-conflict',
        `task '${id}' does not exist`,
      )
    }
    const owners = await tx
      .select({ revision: taskExecutionOwners.revision })
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, id))
      .limit(1)
    snapshots.push({
      taskId: id,
      taskRevision: row.revision,
      ownerRevision: owners[0]?.revision ?? null,
      topologyRevision: row.topologyRevision,
      ledgerDigest: await ledgerDigestTx(tx, id),
    })
  }
  return snapshots
}

export class PostgresqlTerminalMaintenancePersistence implements TerminalMaintenanceStore {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async snapshotMembers(taskIds: readonly string[]): Promise<readonly MaintenanceMemberSnapshot[]> {
    return await serializable(this.db, async (tx) => await snapshotMembersTx(tx, taskIds))
  }

  async snapshotTree(rootTaskId: string): Promise<readonly MaintenanceMemberSnapshot[]> {
    return await serializable(this.db, async (tx) => {
      const roots = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, rootTaskId))
        .limit(1)
      if (roots[0] === undefined) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          `task '${rootTaskId}' does not exist`,
        )
      }
      const seen = new Set([rootTaskId])
      let frontier = [rootTaskId]
      while (frontier.length > 0) {
        const children = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(inArray(tasks.parentTaskId, frontier))
          .orderBy(asc(tasks.id))
        const next: string[] = []
        for (const child of children) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          next.push(child.id)
        }
        frontier = next
      }
      return await snapshotMembersTx(tx, [...seen])
    })
  }

  async claim(
    input: Parameters<TerminalMaintenanceStore['claim']>[0],
  ): Promise<TerminalMaintenanceClaim> {
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
    try {
      await serializable(this.db, async (tx) => {
        for (const member of input.members) await assertMemberQuiescentTx(tx, member)
        await tx
          .insert(taskExecutionMaintenanceClaims)
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
        await tx
          .insert(taskExecutionMaintenanceMembers)
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
    } catch (error) {
      if (uniqueViolation(error)) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          'one or more tasks are already claimed by terminal maintenance',
        )
      }
      throw error
    }
    return createTerminalMaintenanceClaim({
      claimId,
      operation: input.operation,
      revision: 1,
      memberSetDigest,
    })
  }

  async transition(
    input: Parameters<TerminalMaintenanceStore['transition']>[0],
  ): Promise<TerminalMaintenanceClaim> {
    assertTerminalMaintenanceClaim(input.claim)
    const now = input.now ?? Date.now()
    return await serializable(this.db, async (tx) => {
      const rows = await tx
        .select()
        .from(taskExecutionMaintenanceClaims)
        .where(eq(taskExecutionMaintenanceClaims.id, input.claim.claimId))
        .limit(1)
      const row = rows[0]
      if (
        row === undefined ||
        row.operation !== input.claim.operation ||
        row.memberSetDigest !== input.claim.memberSetDigest ||
        row.revision !== input.claim.revision
      ) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          `terminal maintenance claim '${input.claim.claimId}' changed`,
        )
      }
      assertMaintenanceTransition(row.state, input.to)
      const nextRevision = input.claim.revision + 1
      const updated = await tx
        .update(taskExecutionMaintenanceClaims)
        .set({
          state: input.to,
          revision: nextRevision,
          updatedAt: now,
          completedAt: input.to === 'completed' ? now : null,
        })
        .where(
          and(
            eq(taskExecutionMaintenanceClaims.id, input.claim.claimId),
            eq(taskExecutionMaintenanceClaims.revision, input.claim.revision),
            eq(taskExecutionMaintenanceClaims.state, row.state),
          ),
        )
        .returning({ id: taskExecutionMaintenanceClaims.id })
      if (updated[0] === undefined) {
        throw new TaskExecutionError(
          'task-terminal-maintenance-conflict',
          `terminal maintenance claim '${input.claim.claimId}' transition lost`,
        )
      }
      if (input.releaseMembers === true || input.to === 'completed') {
        await tx
          .update(taskExecutionMaintenanceMembers)
          .set({ releasedAt: now })
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
    })
  }

  async complete(input: Parameters<TerminalMaintenanceStore['complete']>[0]): Promise<void> {
    await this.transition({ ...input, to: 'completed' })
  }

  async listRecoverable(input: {
    readonly operation?: TerminalMaintenanceOperation
    readonly rootTaskId?: string
  }): Promise<readonly RecoverableTerminalMaintenanceClaim[]> {
    return await serializable(this.db, async (tx) => {
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
      const rows = await tx
        .select()
        .from(taskExecutionMaintenanceClaims)
        .where(and(...predicates))
        .orderBy(
          asc(taskExecutionMaintenanceClaims.createdAt),
          asc(taskExecutionMaintenanceClaims.id),
        )
      const recoverable: RecoverableTerminalMaintenanceClaim[] = []
      for (const row of rows) {
        const members = await tx
          .select()
          .from(taskExecutionMaintenanceMembers)
          .where(eq(taskExecutionMaintenanceMembers.claimId, row.id))
          .orderBy(asc(taskExecutionMaintenanceMembers.taskId))
        recoverable.push({
          claim: createTerminalMaintenanceClaim({
            claimId: row.id,
            operation: row.operation,
            revision: row.revision,
            memberSetDigest: row.memberSetDigest,
          }),
          rootTaskId: row.rootTaskId,
          state: row.state as Exclude<TerminalMaintenanceState, 'completed'>,
          cleanupPlanJson: row.cleanupPlanJson,
          members: members.map((member) => ({
            taskId: member.taskId,
            taskRevision: member.expectedTaskRevision,
            ownerRevision: member.expectedOwnerRevision,
            topologyRevision: member.expectedTopologyRevision,
            ledgerDigest: member.expectedLedgerDigest,
          })),
        })
      }
      return recoverable
    })
  }
}
