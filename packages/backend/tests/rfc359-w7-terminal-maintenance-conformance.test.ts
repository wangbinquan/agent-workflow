// RFC-359 W7 —— 终态维护认领（RFC-328 terminal maintenance claim）合一后的双引擎一致性。
//
// 合一前是一对逐行同构的适配器：`sqliteTerminalMaintenancePersistence.ts`（薄壳 → `sqliteTerminalMaintenance.ts`
// 的 `dbTxSync` 同步 store）与 `postgresqlTerminalMaintenancePersistence.ts`（SERIALIZABLE）。三个 assert*
// 的判据两侧逐条等价，但 PG 侧有两处**更强**；合一按强侧抬齐，这份用例就是那两条的锁：
//
//   1. **并发认领撞唯一索引时的错误分类**。成员表上的 `idx_task_execution_maintenance_members_active_task`
//      （`task_id where released_at is null`）会在第二个维护流程认领同一任务时冲突。PG 侧一直捕获它并翻译成
//      `task-terminal-maintenance-conflict`（调用方按「暂时冲突」跳过 / 重试，见 terminal-maintenance-watermark-coverage
//      锁住的 workspace-GC「conflict 是 busy 不是 failed」）；SQLite 侧此前让裸 `SQLITE_CONSTRAINT_UNIQUE` 冒泡，
//      于是同一次并发在 SQLite 上被当成硬故障。现在两个引擎必须给出同一个闭合错误码。
//   2. **`snapshotTree` 的原子性**。PG 侧一直把「根存在性 + 子树枚举 + 逐成员快照」放在**同一笔**事务里；
//      SQLite 侧此前分两笔（递归 CTE 一笔、`snapshotMembers` 另一笔），枚举与快照之间能插进一次子任务删除，
//      于是「枚举到了、快照时没了」会把一次正常的并发变成 `task '<child>' does not exist`。
//
// 其余用例覆盖三个 assert* 的主要判据（open effect / 水位覆盖 / replay 决策 / owner 必须 released /
// intents-attempts-holds 三查 / ledger digest 比对）与认领行的 CAS，两个引擎各跑一遍。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionMaintenanceClaims,
  taskExecutionMaintenanceMembers,
  taskExecutionOwners,
  tasks,
  workflows,
} from '@/db/schema'
import { TaskExecutionError } from '@/modules/task-execution/application/taskExecutionError'
import type { MaintenanceMemberSnapshot } from '@/modules/task-execution/domain/terminalMaintenance'
import { DrizzleTerminalMaintenancePersistence } from '@/modules/task-execution/infrastructure/terminalMaintenancePersistence'
import type { DatabaseSession } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_278_400_000
const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

function id(prefix: string): string {
  return `${prefix}_${ulid()}`
}

async function seedWorkflow(db: ProviderNeutralDatabase, workflowId: string): Promise<void> {
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
}

/** 一个「可认领」的终态任务：终态状态、无 owner、无 intent、账本为空。 */
async function seedTask(
  db: ProviderNeutralDatabase,
  taskId: string,
  workflowId: string,
  over: Partial<typeof tasks.$inferInsert> = {},
): Promise<void> {
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: NOW - 10_000,
    finishedAt: NOW - 5_000,
    executionLineageId: taskId,
    ...over,
  })
}

/** 终态 intent —— effect 行的外键需要它，而 `completed` 不算「执行面未静止」。 */
async function seedSettledIntent(
  db: ProviderNeutralDatabase,
  taskId: string,
  intentId: string,
): Promise<void> {
  await db.insert(taskExecutionIntents).values({
    id: intentId,
    taskId,
    kind: 'launch',
    state: 'completed',
    source: 'rest',
    requestHash: `req_${intentId}`,
    payloadJson: '{}',
    executionLineageId: taskId,
    continuationSlotKey: `${taskId}:root`,
    slotPathJson: '[]',
    operationGeneration: 0,
    expectedTaskRevision: 1,
    createdAt: NOW - 9_000,
    updatedAt: NOW - 9_000,
  })
}

interface EffectSeed {
  readonly taskId: string
  readonly intentId: string
  readonly state: 'open' | 'succeeded' | 'failed' | 'outcome-unknown'
  readonly family?: string
  readonly generation?: number
}

async function seedEffect(db: ProviderNeutralDatabase, seed: EffectSeed): Promise<string> {
  const effectId = id('eff')
  const family = seed.family ?? `family_${seed.taskId}`
  await db.insert(taskExecutionEffects).values({
    id: effectId,
    taskId: seed.taskId,
    originIntentId: seed.intentId,
    currentIntentId: seed.intentId,
    operationKey: `root:${effectId}`,
    executionLineageId: seed.taskId,
    operationFamilyKey: family,
    operationGeneration: seed.generation ?? 0,
    kind: 'repository',
    requestHash: `hash_${effectId}`,
    slotPathJson: '[]',
    slotPathDigest: `slot_${seed.taskId}`,
    state: seed.state,
    lastAttemptNo: 1,
    preparedAt: NOW - 8_000,
    settledAt: seed.state === 'open' ? null : NOW - 7_000,
    updatedAt: NOW - 7_000,
  })
  return effectId
}

/** 留存的世代水位：账本里唯一能在任务行被删之后仍解释那次外部效果的行。 */
async function seedWatermark(
  db: ProviderNeutralDatabase,
  input: {
    readonly taskId: string
    readonly family: string
    readonly highestSettledGeneration: number
    readonly requestHash: string
  },
): Promise<void> {
  await db.insert(taskExecutionLineageOperationRecords).values({
    id: id('rec'),
    recordKind: 'generation-watermark',
    executionLineageId: input.taskId,
    operationFamilyKey: input.family,
    highestSettledGeneration: input.highestSettledGeneration,
    requestHash: input.requestHash,
    slotPathJson: '[]',
    slotPathDigest: `slot_${input.taskId}`,
    rootAnchorTaskId: input.taskId,
    recordRevision: 1,
    createdAt: NOW - 7_000,
    updatedAt: NOW - 7_000,
  })
}

async function claimableTask(db: ProviderNeutralDatabase): Promise<string> {
  const workflowId = id('wf')
  const taskId = id('task')
  await seedWorkflow(db, workflowId)
  await seedTask(db, taskId, workflowId)
  return taskId
}

function store(db: ProviderNeutralDatabase): DrizzleTerminalMaintenancePersistence {
  return new DrizzleTerminalMaintenancePersistence(db)
}

async function conflictCode(body: () => Promise<unknown>): Promise<TaskExecutionError> {
  let caught: unknown
  try {
    await body()
  } catch (error) {
    caught = error
  }
  expect(caught, '期望一次终态维护冲突，实际没有抛错').toBeInstanceOf(TaskExecutionError)
  return caught as TaskExecutionError
}

async function claimWorkspaceGc(
  db: ProviderNeutralDatabase,
  taskId: string,
  members: readonly MaintenanceMemberSnapshot[],
) {
  return await store(db).claim({
    rootTaskId: taskId,
    operation: 'workspace-gc',
    members,
    cleanupPlanJson: JSON.stringify({ v: 1, kind: 'workspace-prune', taskId }),
    now: NOW,
  })
}

describeEachProvider('RFC-359 W7 —— 终态维护认领：并发冲突按闭合错误码收口', (harness) => {
  test('同一任务被第二次认领：撞活动成员唯一索引 ⇒ task-terminal-maintenance-conflict，不是裸驱动错误', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const members = await store(db).snapshotMembers([taskId])

    const first = await claimWorkspaceGc(db, taskId, members)
    expect(first.claimId).not.toBe('')

    const error = await conflictCode(async () => await claimWorkspaceGc(db, taskId, members))
    expect(error.code).toBe('task-terminal-maintenance-conflict')
    expect(error.message).toMatch(/already claimed by terminal maintenance/)
    expect(error.status).toBe(409)

    // 冲突的那一笔整笔回滚：只留下第一次认领的行。
    const claims = await db
      .select({ id: taskExecutionMaintenanceClaims.id })
      .from(taskExecutionMaintenanceClaims)
    expect(claims.map((row) => row.id)).toEqual([first.claimId])
  })

  test('成员释放之后同一任务可以再次认领——唯一索引只挡活动成员', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const members = await store(db).snapshotMembers([taskId])
    const first = await claimWorkspaceGc(db, taskId, members)
    await store(db).transition({
      claim: first,
      to: 'io-complete',
      now: NOW + 1,
      releaseMembers: true,
    })

    const again = await claimWorkspaceGc(db, taskId, members)
    expect(again.claimId).not.toBe(first.claimId)
  })
})

describeEachProvider('RFC-359 W7 —— snapshotTree：枚举与快照在同一笔事务里', (harness) => {
  test('并发删掉子任务不会撞上「枚举到了、快照时没了」的半态', async () => {
    const db = harness.db
    const session: DatabaseSession = harness.session
    const workflowId = id('wf')
    await seedWorkflow(db, workflowId)

    // 每轮换一棵新树，并把并发删除的起跑点往后挪，覆盖「两笔事务之间」那个窗口：
    // 分两笔的实现会在某一轮让 snapshotMembers 撞上 `task '<child>' does not exist`。
    for (let round = 0; round < 6; round += 1) {
      const rootId = id('root')
      const childId = id('child')
      await seedTask(db, rootId, workflowId)
      await seedTask(db, childId, workflowId, { parentTaskId: rootId })

      const prune = (async () => {
        for (let tick = 0; tick < round; tick += 1) await Promise.resolve()
        // 走统一事务原语：SQLite 上它排在写者租约后面，PG 上它是另一条连接——
        // 两边都是「一次正常的并发写」，而不是绕过事务边界的旁观者语句。
        await session.transaction(async (tx) => {
          await tx.delete(tasks).where(eq(tasks.id, childId)).run()
        })
      })()

      const [members] = await Promise.all([store(db).snapshotTree(rootId), prune])
      const ids = members.map((member) => member.taskId).sort()
      expect(ids, '子树枚举与逐成员快照必须看到同一个时间点：要么整棵树，要么已剪枝的树').toEqual(
        ids.length === 1 ? [rootId] : [childId, rootId].sort(),
      )
    }
  })

  test('子树按成员集合逐个快照；根不存在时整笔拒绝', async () => {
    const db = harness.db
    const workflowId = id('wf')
    await seedWorkflow(db, workflowId)
    const rootId = id('root')
    const childId = id('child')
    const grandChildId = id('grandchild')
    await seedTask(db, rootId, workflowId)
    await seedTask(db, childId, workflowId, { parentTaskId: rootId })
    await seedTask(db, grandChildId, workflowId, { parentTaskId: childId })

    const members = await store(db).snapshotTree(rootId)
    expect(members.map((member) => member.taskId).sort()).toEqual(
      [rootId, childId, grandChildId].sort(),
    )
    for (const member of members) {
      expect(member.taskRevision).toBe(1)
      expect(member.ownerRevision).toBeNull()
      expect(member.ledgerDigest).toMatch(/^[a-f0-9]{64}$/)
    }

    const missing = await conflictCode(async () => await store(db).snapshotTree(id('nope')))
    expect(missing.code).toBe('task-terminal-maintenance-conflict')
    expect(missing.message).toMatch(/does not exist/)
  })

  test('snapshotMembers 去重排序，空集合直接拒绝', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const members = await store(db).snapshotMembers([taskId, taskId])
    expect(members.map((member) => member.taskId)).toEqual([taskId])

    const empty = await conflictCode(async () => await store(db).snapshotMembers([]))
    expect(empty.message).toMatch(/requires at least one task/)
  })
})

describeEachProvider('RFC-359 W7 —— 认领前的静止判据', (harness) => {
  test('执行面还有活着的 intent ⇒ 不静止', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const members = await store(db).snapshotMembers([taskId])
    await db.insert(taskExecutionIntents).values({
      id: id('intent'),
      taskId,
      kind: 'launch',
      state: 'pending',
      source: 'rest',
      requestHash: `req_${taskId}`,
      payloadJson: '{}',
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPathJson: '[]',
      operationGeneration: 0,
      expectedTaskRevision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })

    const error = await conflictCode(async () => await claimWorkspaceGc(db, taskId, members))
    expect(error.message).toMatch(/execution plane is not quiescent/)
  })

  test('执行 owner 还没 released ⇒ 拒绝', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    await db.insert(taskExecutionOwners).values({
      taskId,
      ownerId: id('owner'),
      daemonGeneration: 'dbg_w7',
      epoch: 1,
      state: 'claimed',
      leaseUntil: NOW + 60_000,
      revision: 1,
      lastHeartbeatAt: NOW,
      updatedAt: NOW,
    })
    const members = await store(db).snapshotMembers([taskId])

    const error = await conflictCode(async () => await claimWorkspaceGc(db, taskId, members))
    expect(error.message).toMatch(/execution owner is not released/)
  })

  test('任务在快照之后又动了（状态 / revision）⇒ 拒绝', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const members = await store(db).snapshotMembers([taskId])
    await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId)).run()

    const error = await conflictCode(async () => await claimWorkspaceGc(db, taskId, members))
    expect(error.message).toMatch(/changed before terminal maintenance claim/)
  })

  test('账本在快照之后又动了 ⇒ digest 比对拒绝', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const members = await store(db).snapshotMembers([taskId])
    // 只加留存记录、不加 effect：覆盖检查那一关是空的，唯一能挡下它的就是 digest 比对。
    await seedWatermark(db, {
      taskId,
      family: `family_${taskId}`,
      highestSettledGeneration: 0,
      requestHash: `hash_${taskId}`,
    })

    const error = await conflictCode(async () => await claimWorkspaceGc(db, taskId, members))
    expect(error.message).toMatch(/execution ledger changed before maintenance claim/)
  })
})

describeEachProvider('RFC-359 W7 —— 已结算账本的覆盖判据', (harness) => {
  test('还有 open effect ⇒ 拒绝', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const intentId = id('intent')
    await seedSettledIntent(db, taskId, intentId)
    const effectId = await seedEffect(db, { taskId, intentId, state: 'open' })
    const members = await store(db).snapshotMembers([taskId])

    const error = await conflictCode(async () => await claimWorkspaceGc(db, taskId, members))
    expect(error.message).toMatch(new RegExp(`still has open execution effect '${effectId}'`))
  })

  test('已结算 effect 没有留存水位 ⇒ 拒绝；补上水位后放行', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const intentId = id('intent')
    await seedSettledIntent(db, taskId, intentId)
    const family = `family_${taskId}`
    const effectId = await seedEffect(db, { taskId, intentId, state: 'succeeded', family })
    const withoutWatermark = await store(db).snapshotMembers([taskId])

    const error = await conflictCode(
      async () => await claimWorkspaceGc(db, taskId, withoutWatermark),
    )
    expect(error.message).toMatch(/lacks a complete retained watermark/)

    const effectRow = (
      await db
        .select({ requestHash: taskExecutionEffects.requestHash })
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, effectId))
    )[0]!
    await seedWatermark(db, {
      taskId,
      family,
      highestSettledGeneration: 0,
      requestHash: effectRow.requestHash,
    })
    const covered = await store(db).snapshotMembers([taskId])
    const claim = await claimWorkspaceGc(db, taskId, covered)
    expect(claim.operation).toBe('workspace-gc')
  })

  test('outcome-unknown 的 effect 还要有留存的 replay 决策 ⇒ 缺了就拒绝', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const intentId = id('intent')
    await seedSettledIntent(db, taskId, intentId)
    const family = `family_${taskId}`
    const effectId = await seedEffect(db, {
      taskId,
      intentId,
      state: 'outcome-unknown',
      family,
    })
    const effectRow = (
      await db
        .select({ requestHash: taskExecutionEffects.requestHash })
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, effectId))
    )[0]!
    await seedWatermark(db, {
      taskId,
      family,
      highestSettledGeneration: 0,
      requestHash: effectRow.requestHash,
    })
    const members = await store(db).snapshotMembers([taskId])

    const error = await conflictCode(async () => await claimWorkspaceGc(db, taskId, members))
    expect(error.message).toMatch(/lacks a retained replay decision/)

    await db.insert(taskExecutionLineageOperationRecords).values({
      id: id('rec'),
      recordKind: 'replay-decision',
      executionLineageId: taskId,
      operationFamilyKey: family,
      operationGeneration: 0,
      decisionState: 'consumed',
      requestHash: effectRow.requestHash,
      slotPathJson: '[]',
      slotPathDigest: `slot_${taskId}`,
      rootAnchorTaskId: taskId,
      recordRevision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const decided = await store(db).snapshotMembers([taskId])
    expect((await claimWorkspaceGc(db, taskId, decided)).revision).toBe(1)
  })
})

describeEachProvider('RFC-359 W7 —— 认领行的 CAS 与恢复面', (harness) => {
  test('按转移表推进；completed 释放成员并从 listRecoverable 消失', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const members = await store(db).snapshotMembers([taskId])
    let claim = await claimWorkspaceGc(db, taskId, members)
    expect(claim.revision).toBe(1)

    const recoverable = await store(db).listRecoverable({ operation: 'workspace-gc' })
    expect(recoverable).toHaveLength(1)
    expect(recoverable[0]!.rootTaskId).toBe(taskId)
    expect(recoverable[0]!.state).toBe('claimed')
    expect(recoverable[0]!.members.map((member) => member.taskId)).toEqual([taskId])
    expect(recoverable[0]!.cleanupPlanJson).toContain('workspace-prune')

    claim = await store(db).transition({ claim, to: 'io-complete', now: NOW + 1 })
    expect(claim.revision).toBe(2)
    claim = await store(db).transition({ claim, to: 'db-finalized', now: NOW + 2 })
    await store(db).complete({ claim, now: NOW + 3 })

    const row = (
      await db
        .select()
        .from(taskExecutionMaintenanceClaims)
        .where(eq(taskExecutionMaintenanceClaims.id, claim.claimId))
    )[0]!
    expect(row.state).toBe('completed')
    expect(row.completedAt).toBe(NOW + 3)
    const memberRows = await db
      .select({ releasedAt: taskExecutionMaintenanceMembers.releasedAt })
      .from(taskExecutionMaintenanceMembers)
      .where(eq(taskExecutionMaintenanceMembers.claimId, claim.claimId))
    expect(memberRows.map((member) => member.releasedAt)).toEqual([NOW + 3])
    expect(await store(db).listRecoverable({ operation: 'workspace-gc' })).toEqual([])
  })

  test('过期的认领 capability（revision 落后）推不动；非法转移直接抛', async () => {
    const db = harness.db
    const taskId = await claimableTask(db)
    const members = await store(db).snapshotMembers([taskId])
    const claim = await claimWorkspaceGc(db, taskId, members)
    const advanced = await store(db).transition({ claim, to: 'io-complete', now: NOW + 1 })

    const stale = await conflictCode(
      async () => await store(db).transition({ claim, to: 'io-complete', now: NOW + 2 }),
    )
    expect(stale.code).toBe('task-terminal-maintenance-conflict')

    await expect(
      store(db).transition({ claim: advanced, to: 'claimed', now: NOW + 3 }),
    ).rejects.toThrow(/illegal-maintenance-transition/)
  })

  test('listRecoverable 按 operation / rootTaskId 过滤', async () => {
    const db = harness.db
    const gcTask = await claimableTask(db)
    const deleteTask = await claimableTask(db)
    await claimWorkspaceGc(db, gcTask, await store(db).snapshotMembers([gcTask]))
    await store(db).claim({
      rootTaskId: deleteTask,
      operation: 'delete',
      members: await store(db).snapshotMembers([deleteTask]),
      cleanupPlanJson: JSON.stringify({ v: 1, rootTaskId: deleteTask }),
      now: NOW,
    })

    expect(
      (await store(db).listRecoverable({ operation: 'delete' })).map((item) => item.rootTaskId),
    ).toEqual([deleteTask])
    expect(
      (await store(db).listRecoverable({ rootTaskId: gcTask })).map((item) => item.rootTaskId),
    ).toEqual([gcTask])
    expect(await store(db).listRecoverable({})).toHaveLength(2)
  })
})
