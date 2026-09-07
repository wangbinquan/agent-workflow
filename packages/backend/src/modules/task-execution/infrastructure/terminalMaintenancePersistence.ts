// RFC-359 —— 终态维护认领（RFC-328 terminal maintenance claim）：一份实现，两个 provider 共用。
//
// 此前是一对逐行同构的适配器：`sqliteTerminalMaintenancePersistence.ts`（33 行薄壳，逐方法转发给
// `sqliteTerminalMaintenance.ts` 的 519 行 `dbTxSync` 同步 store）与 `postgresqlTerminalMaintenancePersistence.ts`
// （543 行 SERIALIZABLE）。三个 assert*（open effect 拒绝 / 水位覆盖 / outcome-unknown 需 replay 决策 /
// owner 必须 released / intents-attempts-holds 三查 / ledger digest 比对）两侧逐条等价，但 PG 侧有两处**更强**，
// 合一按强侧抬齐：
//
//   1. **并发认领的错误分类**。成员表上有 `idx_task_execution_maintenance_members_active_task`
//      （`task_id where released_at is null` 的偏唯一索引）：同一任务被第二个维护流程认领时撞唯一冲突。
//      PG 侧捕获 SQLSTATE 23505 → `task-terminal-maintenance-conflict`（调用方按「暂时冲突」重试 / 跳过）；
//      SQLite 侧让裸 `SQLITE_CONSTRAINT_UNIQUE` 冒泡，于是 workspace-GC / 归档在 SQLite 上把一次正常的
//      并发认领当成硬故障。这里改按能力矩阵的 `classifyError` 判，两个引擎同一个闭合错误合同。
//   2. **`snapshotTree` 的原子性**。PG 把「根存在性检查 + 递归 BFS + 逐成员快照」放在**同一笔**事务里；
//      SQLite 侧分两笔（递归 CTE 一笔，`snapshotMembers` 又开一笔），枚举与快照之间可以插进一次子任务
//      增删，认领据以成立的成员集合与树的真实形状就此不一致。这里只留 PG 的单事务形态；子树枚举改成
//      迭代 BFS（`inArray(parentTaskId, frontier)`），因为 SQLite 的 `WITH RECURSIVE` 与 PG 的写法不通用。
//
// 隔离级别逐方法保留合一前 PG 侧的取值——五个方法都是「先查后写」的跨行判据，全部走
// `DatabaseSession.serializable`（PG：SET TRANSACTION ISOLATION LEVEL SERIALIZABLE + 40001 重放整笔；
// SQLite：`BEGIN IMMEDIATE` 本就全库独占，与合一前 `dbTxSync` 是同一条边界）。
//
// 认领行本身的 CAS 不在这里重写：事务内参与者 `terminalMaintenanceClaim.ts` 已经是中立的一份实现
// （删除恢复 / 归档都挂在它上面），`transition` / `complete` 直接复用它，同一张状态转移表只此一份。

import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
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
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
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
  maintenanceMemberSetDigest,
  retainedWatermarkCoversSettledEffect,
  type MaintenanceMemberSnapshot,
  type TerminalMaintenanceState,
} from '../domain/terminalMaintenance'
import { transitionTerminalMaintenanceClaimTx } from './terminalMaintenanceClaim'

function sha256(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/**
 * 任务在执行账本上留下的全部行的摘要。认领时快照一次、认领落库前再比一次：中间只要有一条
 * effect / lineage 记录动过，认领就作废。
 */
async function ledgerDigestTx(tx: DatabaseTransaction, taskId: string): Promise<string> {
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

/**
 * 任务的行被删掉之后，留存的账本是否还能解释它做过的每一次外部效果：
 * 不能有 open effect；每条已结算 effect 都要被留存的世代水位覆盖；outcome-unknown 还要有 replay 决策。
 */
async function assertSettledLedgerCoverageTx(
  tx: DatabaseTransaction,
  taskId: string,
): Promise<void> {
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
    if (!retainedWatermarkCoversSettledEffect(effect, watermark)) {
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

/** 成员任务在认领落库这一刻仍与快照一致，且执行面确实已经静止。 */
async function assertMemberQuiescentTx(
  tx: DatabaseTransaction,
  member: MaintenanceMemberSnapshot,
): Promise<void> {
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
  tx: DatabaseTransaction,
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

/** 破坏性终态维护（归档 / 删除 / 保留期清理 / workspace-GC）的认领与 CAS 边界。 */
export class DrizzleTerminalMaintenancePersistence implements TerminalMaintenanceStore {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async snapshotMembers(taskIds: readonly string[]): Promise<readonly MaintenanceMemberSnapshot[]> {
    return await databaseSessionFor(this.db).serializable(
      async (tx) => await snapshotMembersTx(tx, taskIds),
    )
  }

  /**
   * 子树枚举与逐成员快照在**同一笔**事务里：认领的成员集合与树当时的真实形状必须一致，
   * 否则中途新增 / 删除的子任务会落在认领之外。
   */
  async snapshotTree(rootTaskId: string): Promise<readonly MaintenanceMemberSnapshot[]> {
    return await databaseSessionFor(this.db).serializable(async (tx) => {
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
    const session = databaseSessionFor(this.db)
    try {
      await session.serializable(async (tx) => {
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
      // 活动成员的偏唯一索引：同一任务已被另一个维护流程认领。两个引擎上都是一次**暂时**冲突，
      // 不是硬故障——判据走能力矩阵，不看驱动错误的具体形状。
      if (session.engine.classifyError(error) === 'unique-violation') {
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
    return await databaseSessionFor(this.db).serializable(
      async (tx) =>
        await transitionTerminalMaintenanceClaimTx(tx, {
          claim: input.claim,
          to: input.to,
          now,
          releaseMembers: input.releaseMembers,
        }),
    )
  }

  async complete(input: Parameters<TerminalMaintenanceStore['complete']>[0]): Promise<void> {
    await this.transition({ ...input, to: 'completed' })
  }

  async listRecoverable(input: {
    readonly operation?: TerminalMaintenanceOperation
    readonly rootTaskId?: string
  }): Promise<readonly RecoverableTerminalMaintenanceClaim[]> {
    return await databaseSessionFor(this.db).serializable(async (tx) => {
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
