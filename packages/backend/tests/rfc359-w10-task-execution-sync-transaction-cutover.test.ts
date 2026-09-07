// RFC-359 W10 —— task-execution 剩余同步事务面（`dbTxSync` / `withOwnedTaskTx`）中立化之后的行为锁。
//
// # 本波转掉了什么
//
//   · `sqliteSourceTerminationParticipant.ts: 3 → 0` —— 源终止的三笔事务（重放对账 / 终态 CAS
//     输给别人后的补写 / 目标本就终态的直写）改走 `databaseSessionFor(db).transaction(...)`，
//     体内四个参与者各换成两个引擎共用的那一份（`cancelOpenNodeRunsInTx` /
//     `appendTaskNodeStatusesCommittedEvent` / `revokeExactOwnerInTx` /
//     `terminalizeTaskExecutionIntentsInTx`）；顺带把事务**外**那几条 bun:sqlite 专属的同步
//     读写（`.all()[0]` / 不 await 的 `.run()`）也补齐 await。
//   · `sqliteTaskOwnership.ts: 3 → 2` —— `revokeExact` 的事务**整个去掉**（单语句 CAS 本就原子），
//     并在中立侧新开 `revokeExactOwnerInTx` 供更大的原子在自己的事务里调用。
//   · `sqliteTaskExecutionIntentAdmission.ts: 1 → 0` —— 全仓零调用方的 `submitTaskContinuation` 删除。
//   · `sqliteTaskExecutionEffect.ts: 3 → 2` —— 生产零调用方的同步 `closeOutcomeUnknownAndRelease` 删除。
//   · `services/task.ts: 3 → 0` —— 准备重试前的纯围栏、延后准备的回填投影、以及任务铸行那笔
//     459 行大事务，全部改走 `withTaskExecutionWrite`。
//
// # 为什么这些用例存在（它们不是搬运的复读）
//
// `dbTxSync` 的事务体在类型层就不许 `await`（RFC-093 把 Promise 回调塌成 `never`），整笔写落在
// 同一个 tick 里；换成中立原语后事务体可以 `await`，于是「中间态会不会被别人看见」「体内某一步
// 抛了前面几步退不退得回去」都成了真问题。而漏一个 `await` 的三档失效**都不会让 SQLite 变红**：
//   ① 既不 `.run()` 也不 `await`（惰性 `QueryPromise`）—— 两个引擎都不发生；
//   ② `.all()` / `.get()` 不 await —— 只有 PG 红（拿到的是 Promise，`[0]` 恒 undefined）；
//   ③ `.run()` 不 await —— **只有 PG 红且静默**（语句可能落在事务外、也可能根本不发，两边都不抛）。
// 所以判据的一半是「同一份实现在 PostgreSQL 上照跑」，另一半是「体内抛错之后一行都不留」。
//
// # 三组判据
//
//   ①②③④ 源终止参与者：这个 **SQLite 命名**的参与者现在在 PostgreSQL 上跑得动，本身就是
//        事务中立化成功的判据（钉着 SQLite 的只剩取消分支里的 `setTaskStatus`，见账本）。
//   ⑤⑥   `revokeExactOwnerInTx`：新的中立事务内参与者。正向 / CAS 输了抛 stale-owner /
//        输了之后同事务里别的写一起回滚。
//   ⑦⑧⑨⑩ `services/task.ts` 两笔事务的**语句序列**在两个引擎上的原子性。PG 的 daemon 走的是
//        它自己那份任务路由启动适配器，`services/task.ts` 在 PG 上没有生产入口，
//        （此处刻意不写那个模块的文件名：`rfc359-w5-t19d-coverage-parity` 按「测试里提到模块名」
//        计覆盖，写一句注释就会把那一对的引用数顶高、把覆盖倒挂记深，而这里并没有新增任何断言。）
//        所以这里锁的是「这串语句配中立原语在两个引擎上都真的同生共死」，再由下面的源码层
//        `await` 完整性守卫兜住第 ③ 档（漏 await 不会让任何行为测试变红）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEvents,
  nodeRuns,
  taskExecutionIntents,
  taskExecutionOwners,
  taskRepos,
  taskSpaceNodes,
  tasks,
} from '@/db/schema'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import type { TaskSourceTerminationEffectInput } from '@/modules/task-execution/application/applySourceTerminationEffect'
import { createTaskSourceTerminationParticipant } from '@/modules/task-execution/infrastructure/sqliteSourceTerminationParticipant'
import { revokeExactOwnerInTx } from '@/modules/task-execution/infrastructure/taskOwnershipPersistence'
import {
  appendTaskCreatedCommittedEvent,
  setNodeRunStatusInTransaction,
} from '@/modules/task-execution/public/participants'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const BINDING = 'gitlab:group/proj!910'
const DELIVERY = 'dlv-rfc359-w10'
const SLOT_PATH = (taskId: string): string =>
  JSON.stringify([{ stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 }])

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

interface Seeded {
  readonly taskId: string
  readonly openRunId: string
  readonly doneRunId: string
  readonly intentId: string
}

async function seedTask(
  db: ProviderNeutralDatabase,
  overrides: {
    readonly status?: 'pending' | 'running' | 'done' | 'canceled'
    readonly launchRevision?: number | null
    readonly effectRevision?: number | null
    readonly binding?: string | null
    readonly openRunStatus?: 'running' | 'pending' | 'done'
  } = {},
): Promise<Seeded> {
  const taskId = `task-${ulid()}`
  const openRunId = `run-open-${ulid()}`
  const doneRunId = `run-done-${ulid()}`
  const intentId = `intent-${ulid()}`
  const status = overrides.status ?? 'done'
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: 'workflow-w10',
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${taskId}`,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt: 1,
    runningSince: status === 'running' ? 1 : null,
    runningMs: 0,
    finishedAt: status === 'done' ? 2 : null,
    spaceKind: 'remote',
    webhookTriggerId: 'trg-w10',
    sourceTerminationBinding: overrides.binding === undefined ? BINDING : overrides.binding,
    sourceTerminationLaunchRev:
      overrides.launchRevision === undefined ? 1 : overrides.launchRevision,
    sourceTerminationFence: null,
    sourceTerminationEffectRev: overrides.effectRevision ?? null,
    executionLineageId: taskId,
    lineageSlotPathJson: SLOT_PATH(taskId),
  })
  await db.insert(nodeRuns).values([
    {
      id: openRunId,
      taskId,
      nodeId: 'node-open',
      status: overrides.openRunStatus ?? 'running',
      retryIndex: 0,
      iteration: 0,
      startedAt: 1,
      continuationSlotKey: `${taskId}:node-open`,
      operationGeneration: 0,
    },
    {
      id: doneRunId,
      taskId,
      nodeId: 'node-done',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: 1,
      finishedAt: 2,
      continuationSlotKey: `${taskId}:node-done`,
      operationGeneration: 0,
    },
  ])
  await db.insert(taskExecutionIntents).values({
    id: intentId,
    taskId,
    kind: 'launch',
    state: 'pending',
    source: 'rest',
    requestHash: `hash-${intentId}`,
    payloadJson: '{}',
    executionLineageId: taskId,
    continuationSlotKey: `${taskId}:root`,
    slotPathJson: SLOT_PATH(taskId),
    operationGeneration: 0,
    expectedTaskRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  return { taskId, openRunId, doneRunId, intentId }
}

async function seedClaimedOwner(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<{ ownerId: string; daemonGeneration: string; epoch: number; revision: number }> {
  const owner = {
    ownerId: `owner-${ulid()}`,
    daemonGeneration: `dg-${ulid()}`,
    epoch: 1,
    revision: 3,
  }
  await db.insert(taskExecutionOwners).values({
    taskId,
    ownerId: owner.ownerId,
    daemonGeneration: owner.daemonGeneration,
    epoch: owner.epoch,
    state: 'claimed',
    leaseUntil: Date.now() + 60_000,
    revision: owner.revision,
    lastHeartbeatAt: Date.now(),
    recoveryCode: null,
    recoveryProofDigest: null,
    updatedAt: Date.now(),
  })
  return owner
}

function effect(
  kind: TaskSourceTerminationEffectInput['kind'],
  streamRevision: number,
): TaskSourceTerminationEffectInput {
  return {
    effectId: `eff-${kind}-${String(streamRevision)}`,
    binding: BINDING,
    streamRevision,
    kind,
    deliveryId: DELIVERY,
  }
}

async function applySourceTermination(
  h: ProviderHarness,
  input: TaskSourceTerminationEffectInput,
): Promise<void> {
  // **两个引擎上都构造这一个** SQLite 命名的参与者：它跑得动 PostgreSQL 正是本波的判据。
  const participant = createTaskSourceTerminationParticipant(h.db as unknown as DbClient)
  await participant.apply(mintSourceTerminationEffectCapability(input), input)
}

// ─────────────────────────────────────────────────────────────────────────────
// 双引擎判据
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W10 —— task-execution 同步事务面中立化', (h) => {
  test('① 目标本就终态：围栏 / owner 撤销 / intent 终态化 / node_run 取消 / committed event 落在同一笔事务里', async () => {
    const seeded = await seedTask(h.db, { status: 'done' })
    const owner = await seedClaimedOwner(h.db, seeded.taskId)

    await applySourceTermination(h, effect('fence-closed', 5))

    const task = (
      await h.db
        .select({
          fence: tasks.sourceTerminationFence,
          effectRev: tasks.sourceTerminationEffectRev,
          status: tasks.status,
        })
        .from(tasks)
        .where(eq(tasks.id, seeded.taskId))
        .limit(1)
    )[0]
    expect(task?.fence, '围栏必须落库——它是这笔事务的第一条语句').toBe('closed')
    expect(task?.effectRev).toBe(5)
    expect(task?.status, '目标本就终态：这一支不碰 tasks.status').toBe('done')

    const ownerRow = (
      await h.db
        .select({
          state: taskExecutionOwners.state,
          recoveryCode: taskExecutionOwners.recoveryCode,
        })
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, seeded.taskId))
        .limit(1)
    )[0]
    expect(ownerRow?.state, 'owner 必须被撤销（revokeExactOwnerInTx）').toBe('revoked')
    expect(ownerRow?.recoveryCode).toBe('terminal-control-source-terminal')

    const intent = (
      await h.db
        .select({ state: taskExecutionIntents.state })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, seeded.intentId))
        .limit(1)
    )[0]
    expect(intent?.state, 'pending intent 必须终态化（terminalizeTaskExecutionIntentsInTx）').toBe(
      'canceled',
    )

    const openRun = (
      await h.db
        .select({ status: nodeRuns.status, errorMessage: nodeRuns.errorMessage })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, seeded.openRunId))
        .limit(1)
    )[0]
    expect(openRun?.status, '还开着的 node_run 必须一起取消（cancelOpenNodeRunsInTx）').toBe(
      'canceled',
    )
    const doneRun = (
      await h.db
        .select({ status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, seeded.doneRunId))
        .limit(1)
    )[0]
    expect(doneRun?.status, '已经终态的 node_run 不许被改写').toBe('done')

    const events = await h.db
      .select({ type: committedEvents.eventType })
      .from(committedEvents)
      .where(eq(committedEvents.aggregateId, seeded.taskId))
    expect(
      events.map((row) => row.type),
      'node 状态变更必须落一条 committed event（appendTaskNodeStatusesCommittedEvent）',
    ).toContain('task.node-statuses-transitioned.v1')

    expect(owner.revision, '夹具自检：撤销的期望 revision 来自事务内那次读，不是这里的常量').toBe(3)
  })

  test('② 重放对账（effect_rev 已经不小于本次）：只补取消还开着的 node_run，围栏一格不动', async () => {
    const seeded = await seedTask(h.db, { status: 'done', effectRevision: 9 })

    await applySourceTermination(h, effect('fence-merged', 5))

    const task = (
      await h.db
        .select({
          fence: tasks.sourceTerminationFence,
          effectRev: tasks.sourceTerminationEffectRev,
        })
        .from(tasks)
        .where(eq(tasks.id, seeded.taskId))
        .limit(1)
    )[0]
    expect(task?.fence, '对账支不写围栏').toBeNull()
    expect(task?.effectRev).toBe(9)
    const openRun = (
      await h.db
        .select({ status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, seeded.openRunId))
        .limit(1)
    )[0]
    expect(openRun?.status, '对账支仍要把漏网的 node_run 收干净').toBe('canceled')
  })

  test('③ 源终止的整串参与者在同一笔事务里：体内抛错之后四张表一行都不留', async () => {
    const seeded = await seedTask(h.db, { status: 'done' })
    const owner = await seedClaimedOwner(h.db, seeded.taskId)
    const { terminalizeTaskExecutionIntentsInTx } =
      await import('@/modules/task-execution/infrastructure/taskExecutionIntentTerminalPersistence')
    const { transitionNodeRunStatusTx } =
      await import('@/modules/task-execution/infrastructure/nodeRunLifecycleTransition')

    const boom = new Error('rfc359-w10-rollback-probe')
    await expect(
      databaseSessionFor(h.db).transaction(async (tx) => {
        await tx
          .update(tasks)
          .set({ sourceTerminationFence: 'closed', sourceTerminationEffectRev: 5 })
          .where(eq(tasks.id, seeded.taskId))
          .run()
        await revokeExactOwnerInTx(tx, {
          owner: { taskId: seeded.taskId, ...owner },
          expectedRevision: owner.revision,
          now: Date.now(),
          recoveryCode: 'terminal-control-source-terminal',
        })
        await terminalizeTaskExecutionIntentsInTx(tx, {
          taskId: seeded.taskId,
          state: 'canceled',
          failureCode: 'task-source-terminal-closed',
          now: Date.now(),
        })
        await transitionNodeRunStatusTx({
          tx,
          nodeRunId: seeded.openRunId,
          event: { kind: 'mark-canceled', reason: 'probe' },
          extra: { finishedAt: Date.now(), errorMessage: 'probe' },
        })
        throw boom
      }),
    ).rejects.toThrow('rfc359-w10-rollback-probe')

    const task = (
      await h.db
        .select({
          fence: tasks.sourceTerminationFence,
          effectRev: tasks.sourceTerminationEffectRev,
        })
        .from(tasks)
        .where(eq(tasks.id, seeded.taskId))
        .limit(1)
    )[0]
    expect(task?.fence, '围栏必须回滚').toBeNull()
    expect(task?.effectRev).toBeNull()
    const ownerRow = (
      await h.db
        .select({ state: taskExecutionOwners.state, revision: taskExecutionOwners.revision })
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, seeded.taskId))
        .limit(1)
    )[0]
    expect(ownerRow?.state, 'owner 撤销必须回滚').toBe('claimed')
    expect(ownerRow?.revision).toBe(owner.revision)
    const intent = (
      await h.db
        .select({ state: taskExecutionIntents.state })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, seeded.intentId))
        .limit(1)
    )[0]
    expect(intent?.state, 'intent 终态化必须回滚').toBe('pending')
    const openRun = (
      await h.db
        .select({ status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, seeded.openRunId))
        .limit(1)
    )[0]
    expect(openRun?.status, 'node_run 取消必须回滚').toBe('running')
  })

  test('④ revokeExactOwnerInTx 的 CAS 输了：抛 stale-owner，且同一笔事务里先落的写一起回滚', async () => {
    const seeded = await seedTask(h.db, { status: 'done' })
    const owner = await seedClaimedOwner(h.db, seeded.taskId)

    await expect(
      databaseSessionFor(h.db).transaction(async (tx) => {
        await tx
          .update(tasks)
          .set({ sourceTerminationFence: 'merged' })
          .where(eq(tasks.id, seeded.taskId))
          .run()
        // 期望 revision 比库里的老一格 —— 精确 owner CAS 必须不命中。
        await revokeExactOwnerInTx(tx, {
          owner: { taskId: seeded.taskId, ...owner },
          expectedRevision: owner.revision - 1,
          now: Date.now(),
          recoveryCode: 'terminal-control-source-terminal',
        })
      }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })

    const task = (
      await h.db
        .select({ fence: tasks.sourceTerminationFence })
        .from(tasks)
        .where(eq(tasks.id, seeded.taskId))
        .limit(1)
    )[0]
    expect(task?.fence, 'CAS 输了要把这一笔整个退回去，围栏不许留下').toBeNull()
    const ownerRow = (
      await h.db
        .select({ state: taskExecutionOwners.state })
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, seeded.taskId))
        .limit(1)
    )[0]
    expect(ownerRow?.state).toBe('claimed')
  })

  test('⑤ revokeExactOwnerInTx 不在事务里也能用：单语句 CAS 本就原子（`revokeExact` 去掉事务的依据）', async () => {
    const seeded = await seedTask(h.db, { status: 'done' })
    const owner = await seedClaimedOwner(h.db, seeded.taskId)

    const snapshot = await revokeExactOwnerInTx(h.db, {
      owner: { taskId: seeded.taskId, ...owner },
      expectedRevision: owner.revision,
      now: 12_345,
      recoveryCode: 'daemon-shutdown-survivor',
    })
    expect(snapshot.state).toBe('revoked')
    expect(snapshot.revision, 'revision 由 CAS 自己推进').toBe(owner.revision + 1)

    // 同一份期望 revision 再来一次必须输 —— 判据完全落在那条 WHERE 上。
    await expect(
      revokeExactOwnerInTx(h.db, {
        owner: { taskId: seeded.taskId, ...owner },
        expectedRevision: owner.revision,
        now: 12_346,
      }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
  })

  test('⑥ 延后准备的回填投影：tasks 回写 + task_repos + task_space_nodes + prep 行置 done 同生共死', async () => {
    const seeded = await seedTask(h.db, { status: 'running', openRunStatus: 'running' })

    await databaseSessionFor(h.db).transaction(async (tx) => {
      await tx
        .update(tasks)
        .set({ worktreePath: '/tmp/prepared', branch: 'prepared', repoCount: 1 })
        .where(eq(tasks.id, seeded.taskId))
        .run()
      await tx
        .insert(taskRepos)
        .values({
          taskId: seeded.taskId,
          repoIndex: 0,
          repoPath: '/tmp/prepared/repo',
          baseBranch: 'main',
          branch: 'prepared',
          worktreePath: '/tmp/prepared/repo',
        })
        .run()
      await tx
        .insert(taskSpaceNodes)
        .values({ taskId: seeded.taskId, nodePath: 'docs', schemaVersion: 1 })
        .run()
      await setNodeRunStatusInTransaction({
        tx,
        nodeRunId: seeded.openRunId,
        to: 'done',
        allowedFrom: ['running'],
        reason: 'repo-prep-done',
        extra: { finishedAt: 42 },
      })
    })

    expect(
      (
        await h.db
          .select({ worktreePath: tasks.worktreePath })
          .from(tasks)
          .where(eq(tasks.id, seeded.taskId))
          .limit(1)
      )[0]?.worktreePath,
    ).toBe('/tmp/prepared')
    expect(
      (await h.db.select().from(taskRepos).where(eq(taskRepos.taskId, seeded.taskId))).length,
    ).toBe(1)
    expect(
      (await h.db.select().from(taskSpaceNodes).where(eq(taskSpaceNodes.taskId, seeded.taskId)))
        .length,
    ).toBe(1)
    expect(
      (
        await h.db
          .select({ status: nodeRuns.status })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, seeded.openRunId))
          .limit(1)
      )[0]?.status,
    ).toBe('done')
  })

  test('⑦ 回填投影的最后一步失败（prep 行已经不是 running）：前三张表的写全部回滚', async () => {
    // 这是**生产可达**的失败：`setNodeRunStatusTx` 的 allowedFrom 只认 'running'，
    // 崩溃重跑 / 并发写把 prep 行推到别的状态时它抛 ConflictError。合一前这一笔在
    // `dbTxSync` 里，抛出即整笔回滚；中立原语必须保住同一条语义。
    const seeded = await seedTask(h.db, { status: 'running', openRunStatus: 'pending' })

    await expect(
      databaseSessionFor(h.db).transaction(async (tx) => {
        await tx
          .update(tasks)
          .set({ worktreePath: '/tmp/prepared', branch: 'prepared', repoCount: 1 })
          .where(eq(tasks.id, seeded.taskId))
          .run()
        await tx
          .insert(taskRepos)
          .values({
            taskId: seeded.taskId,
            repoIndex: 0,
            repoPath: '/tmp/prepared/repo',
            baseBranch: 'main',
            branch: 'prepared',
            worktreePath: '/tmp/prepared/repo',
          })
          .run()
        await tx
          .insert(taskSpaceNodes)
          .values({ taskId: seeded.taskId, nodePath: 'docs', schemaVersion: 1 })
          .run()
        await setNodeRunStatusInTransaction({
          tx,
          nodeRunId: seeded.openRunId,
          to: 'done',
          allowedFrom: ['running'],
          reason: 'repo-prep-done',
          extra: { finishedAt: 42 },
        })
      }),
    ).rejects.toMatchObject({ code: 'illegal-node-run-transition' })

    expect(
      (
        await h.db
          .select({ worktreePath: tasks.worktreePath })
          .from(tasks)
          .where(eq(tasks.id, seeded.taskId))
          .limit(1)
      )[0]?.worktreePath,
      'tasks 的路径回写必须回滚——否则「有工作树但没有成员仓」这种不存在的状态会落库',
    ).toBe(`/tmp/worktree/${seeded.taskId}`)
    expect(
      (await h.db.select().from(taskRepos).where(eq(taskRepos.taskId, seeded.taskId))).length,
      'task_repos 必须回滚',
    ).toBe(0)
    expect(
      (await h.db.select().from(taskSpaceNodes).where(eq(taskSpaceNodes.taskId, seeded.taskId)))
        .length,
      'task_space_nodes 必须回滚',
    ).toBe(0)
  })

  test('⑧ 任务铸行事务：tasks 行 + launch intent + created 事件同生共死', async () => {
    const taskId = `task-${ulid()}`
    const intentId = `intent-${ulid()}`
    await databaseSessionFor(h.db).transaction(async (tx) => {
      await tx.insert(tasks).values({
        id: taskId,
        name: taskId,
        workflowId: 'workflow-w10',
        workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
        workflowVersion: 1,
        repoPath: '/tmp/repo',
        worktreePath: `/tmp/worktree/${taskId}`,
        baseBranch: 'main',
        branch: `agent-workflow/${taskId}`,
        status: 'pending',
        inputs: '{}',
        startedAt: 1,
        runningMs: 0,
        spaceKind: 'remote',
        executionLineageId: taskId,
        lineageSlotPathJson: SLOT_PATH(taskId),
      })
      await tx.insert(taskExecutionIntents).values({
        id: intentId,
        taskId,
        kind: 'launch',
        state: 'pending',
        source: 'rest',
        requestHash: `hash-${intentId}`,
        payloadJson: '{}',
        executionLineageId: taskId,
        continuationSlotKey: `${taskId}:root`,
        slotPathJson: SLOT_PATH(taskId),
        operationGeneration: 0,
        expectedTaskRevision: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      await appendTaskCreatedCommittedEvent(tx, {
        taskId,
        status: 'pending',
        errorSummary: null,
        occurredAt: 1,
      })
    })

    expect(
      (await h.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length,
    ).toBe(1)
    expect(
      (
        await h.db
          .select({ id: taskExecutionIntents.id })
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, intentId))
      ).length,
    ).toBe(1)
    expect(
      (
        await h.db
          .select({ type: committedEvents.eventType })
          .from(committedEvents)
          .where(
            and(
              eq(committedEvents.aggregateId, taskId),
              eq(committedEvents.eventType, 'task.created.v1'),
            ),
          )
      ).length,
    ).toBe(1)
  })

  test('⑨ 任务铸行事务体内抛错：tasks / intents / committed event 一行都不留', async () => {
    const taskId = `task-${ulid()}`
    const intentId = `intent-${ulid()}`
    await expect(
      databaseSessionFor(h.db).transaction(async (tx) => {
        await tx.insert(tasks).values({
          id: taskId,
          name: taskId,
          workflowId: 'workflow-w10',
          workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
          workflowVersion: 1,
          repoPath: '/tmp/repo',
          worktreePath: `/tmp/worktree/${taskId}`,
          baseBranch: 'main',
          branch: `agent-workflow/${taskId}`,
          status: 'pending',
          inputs: '{}',
          startedAt: 1,
          runningMs: 0,
          spaceKind: 'remote',
          executionLineageId: taskId,
          lineageSlotPathJson: SLOT_PATH(taskId),
        })
        await tx.insert(taskExecutionIntents).values({
          id: intentId,
          taskId,
          kind: 'launch',
          state: 'pending',
          source: 'rest',
          requestHash: `hash-${intentId}`,
          payloadJson: '{}',
          executionLineageId: taskId,
          continuationSlotKey: `${taskId}:root`,
          slotPathJson: SLOT_PATH(taskId),
          operationGeneration: 0,
          expectedTaskRevision: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        await appendTaskCreatedCommittedEvent(tx, {
          taskId,
          status: 'pending',
          errorSummary: null,
          occurredAt: 1,
        })
        // 生产里这一步是「协作者里混了停用用户」这类校验抛错（RFC-036/099 明写要整笔回滚）。
        throw new Error('rfc359-w10-launch-rollback-probe')
      }),
    ).rejects.toThrow('rfc359-w10-launch-rollback-probe')

    expect(
      (await h.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length,
      '任务行必须回滚——合一前这条原子性正是「手工回滚可能删掉一条既存任务」的替代品',
    ).toBe(0)
    expect(
      (
        await h.db
          .select({ id: taskExecutionIntents.id })
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, intentId))
      ).length,
    ).toBe(0)
    expect(
      (
        await h.db
          .select({ type: committedEvents.eventType })
          .from(committedEvents)
          .where(eq(committedEvents.aggregateId, taskId))
      ).length,
      'committed event 必须和它描述的那行一起回滚',
    ).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 源码层：中立事务体内的每一条 `.run()` / `.get()` / `.all()` 都必须在 `await` 之下
//
// 这一条挡的是上面头注释里的第 ③ 档：`.run()` 漏 await 在 SQLite 上照样落库、在 PostgreSQL 上
// 静默不落，而**没有任何行为测试会红**。`bun run lint:promises` 挡得住裸的浮动 Promise，挡不住
// 写在事务体里、恰好被 ESLint 的 no-floating-promises 放过的形态（表达式语句以外的位置）。
// ─────────────────────────────────────────────────────────────────────────────

const NEUTRAL_TX_OPENERS = new Set(['withTaskExecutionWrite', 'transaction', 'serializable'])
const TERMINALS = new Set(['run', 'get', 'all'])

const AUDITED = [
  'services/task.ts',
  'modules/task-execution/infrastructure/sqliteSourceTerminationParticipant.ts',
] as const

interface Unawaited {
  readonly file: string
  readonly line: number
  readonly text: string
}

function auditFile(rel: string): { readonly terminals: number; readonly unawaited: Unawaited[] } {
  const path = resolve(import.meta.dir, '..', 'src', rel)
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
  const unawaited: Unawaited[] = []
  let terminals = 0

  /** 从一个节点往上走，看它是否落在某个 `await …` 表达式里（同一个函数体内）。 */
  const underAwait = (node: ts.Node): boolean => {
    for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
      if (ts.isAwaitExpression(cur)) return true
      if (ts.isFunctionLike(cur)) return false
    }
    return false
  }

  const inNeutralTransaction = (node: ts.Node): boolean => {
    for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
      if (!ts.isCallExpression(cur)) continue
      const callee = cur.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null
      if (name !== null && NEUTRAL_TX_OPENERS.has(name)) return true
    }
    return false
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      TERMINALS.has(node.expression.name.text) &&
      node.arguments.length === 0 &&
      inNeutralTransaction(node)
    ) {
      terminals += 1
      if (!underAwait(node)) {
        unawaited.push({
          file: rel,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          text: node.getText(source).replace(/\s+/g, ' ').slice(0, 100),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { terminals, unawaited }
}

describe('RFC-359 W10 —— 中立事务体内没有漏 await 的语句', () => {
  test('语料非空：确实扫到了中立事务体内的终止调用（扫成 0 就是零预言力）', () => {
    const total = AUDITED.reduce((sum, rel) => sum + auditFile(rel).terminals, 0)
    expect(
      total,
      '扫描根失效：中立事务体里一条 `.run()`/`.get()`/`.all()` 都没扫到',
    ).toBeGreaterThanOrEqual(12)
  })

  for (const rel of AUDITED) {
    test(`${rel}：每一条 .run()/.get()/.all() 都在 await 之下`, () => {
      expect(
        auditFile(rel).unawaited,
        '中立事务体里出现了没被 await 的语句。`.run()` 漏 await 在 SQLite 上照样落库、在 ' +
          'PostgreSQL 上是一个没人等的 Promise（语句可能落在事务外、也可能根本不发），两边都不抛；' +
          '`.all()`/`.get()` 漏 await 只有 PostgreSQL 红。两种都不会被行为测试照出来。',
      ).toEqual([])
    })
  }
})
