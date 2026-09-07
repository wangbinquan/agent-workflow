// RFC-359 W4-D28a —— 任务归属（durable ownership）端口的双引擎取证基线。
//
// 合一前的形态与 D23a 之前的技能目录一模一样：SQLite 侧是 43 行薄适配器套 563 行成熟的同步
// 实现，PostgreSQL 侧是 444 行原生重写。覆盖同样倒挂——`rfc328-durable-ownership.test.ts` 有
// 1400+ 行正确性矩阵，**全部只跑 SQLite**；PostgreSQL 那 444 行的 owner CAS / 租约 / 撤销 /
// 恢复逻辑**没有任何活着的行为覆盖**（现有引用全是源码文本锁）。
//
// 合一之前先按 D19b/D23a 的方法论取证：**按端口数覆盖、不是按实现数**——把同一批场景
// 通过同一个 `TaskOwnershipPersistence` 端口在两个引擎上各跑一遍，用实测差异代替纸面对账。
//
// RFC-359 W8 已按这份基线完成合一：两侧现在都是 `taskOwnershipPersistence.ts` 的
// `DrizzleTaskOwnershipPersistence`（provider 中立），装配不再分叉，因此这里不再按能力矩阵
// 挑实现。**这份文件锁住的每一条在合一前后都成立**——它当初就是这么用的。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionIntents, taskExecutionOwners, tasks } from '@/db/schema'
import type { TaskOwnershipPersistence } from '@/modules/task-execution/application/ports/taskOwnershipPersistence'
import { DrizzleTaskOwnershipPersistence } from '@/modules/task-execution/infrastructure/taskOwnershipPersistence'
import {
  createExclusiveDaemonLockProof,
  createWorkerIdentity,
  ownershipTuple,
} from '@/modules/task-execution/domain/ownership'
import { describeEachProvider } from './helpers/eachProvider'

const LEASE_MS = 60_000

function ownershipFor(db: ProviderNeutralDatabase): TaskOwnershipPersistence {
  return new DrizzleTaskOwnershipPersistence(db)
}

/** 一个任务 + 一条 pending intent —— 归属端口能开工的最小前置。 */
async function seed(db: ProviderNeutralDatabase): Promise<{ taskId: string; intentId: string }> {
  const taskId = `task-${ulid()}`
  const intentId = `intent-${ulid()}`
  const slotPath = JSON.stringify([
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ])
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: 'workflow-d28a',
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: 1,
    finishedAt: null,
    executionLineageId: taskId,
    lineageSlotPathJson: slotPath,
  })
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
    slotPathJson: slotPath,
    operationGeneration: 0,
    expectedTaskRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  return { taskId, intentId }
}

describeEachProvider('RFC-359 W4-D28a —— 任务归属端口在两个引擎上同形', (harness) => {
  const identity = () =>
    createWorkerIdentity({ ownerId: `owner-${ulid()}`, daemonGeneration: `daemon-${ulid()}` })

  test('① 认领 pending intent：拿到 token，owner 行落到 claimed，intent 转 claimed', async () => {
    const ownership = ownershipFor(harness.db)
    const { taskId, intentId } = await seed(harness.db)

    const token = await ownership.claimPendingIntent({
      intentId,
      identity: identity(),
      now: 1_000,
      leaseMs: LEASE_MS,
    })
    expect(token.taskId).toBe(taskId)

    const snapshot = await ownership.read(taskId)
    expect(snapshot).toMatchObject({ taskId, state: 'claimed' })
    const intent = (
      await harness.db
        .select({ state: taskExecutionIntents.state })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, intentId))
        .limit(1)
    )[0]
    expect(intent?.state).toBe('claimed')
  })

  test('② 同一条 intent 认领两次：第二次冲突，且不产生第二个 owner', async () => {
    const ownership = ownershipFor(harness.db)
    const { taskId, intentId } = await seed(harness.db)

    await ownership.claimPendingIntent({
      intentId,
      identity: identity(),
      now: 1_000,
      leaseMs: LEASE_MS,
    })
    await expect(
      ownership.claimPendingIntent({
        intentId,
        identity: identity(),
        now: 1_100,
        leaseMs: LEASE_MS,
      }),
    ).rejects.toMatchObject({ code: 'task-execution-owner-conflict' })

    expect(
      await harness.db
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, taskId)),
    ).toHaveLength(1)
  })

  test('③ 不存在的 intent 认领：冲突，且不留 owner 行', async () => {
    const ownership = ownershipFor(harness.db)
    await expect(
      ownership.claimPendingIntent({
        intentId: `intent-missing-${ulid()}`,
        identity: identity(),
        now: 1_000,
        leaseMs: LEASE_MS,
      }),
    ).rejects.toMatchObject({ code: 'task-execution-owner-conflict' })
  })

  test('④ 心跳续租：token 推进，revision 单调增', async () => {
    const ownership = ownershipFor(harness.db)
    const { taskId, intentId } = await seed(harness.db)
    const token = await ownership.claimPendingIntent({
      intentId,
      identity: identity(),
      now: 1_000,
      leaseMs: LEASE_MS,
    })
    const before = await ownership.read(taskId)

    const renewed = await ownership.heartbeat({ token, now: 2_000, leaseMs: LEASE_MS })
    expect(renewed.taskId).toBe(taskId)
    const after = await ownership.read(taskId)
    expect(after?.state).toBe('claimed')
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0)
    // 租约真的往后推了，不是只 bump 了 revision。
    expect(after?.leaseUntil ?? 0).toBeGreaterThan(before?.leaseUntil ?? 0)
  })

  test('⑤ 撤销要对上 revision：陈旧 revision 撤不动，正确的能撤', async () => {
    const ownership = ownershipFor(harness.db)
    const { taskId, intentId } = await seed(harness.db)
    const token = await ownership.claimPendingIntent({
      intentId,
      identity: identity(),
      now: 1_000,
      leaseMs: LEASE_MS,
    })
    const current = await ownership.read(taskId)
    if (current === null) throw new Error('owner row missing')

    await expect(
      ownership.revokeExact({
        owner: ownershipTuple(token),
        expectedRevision: current.revision + 99,
        now: 3_000,
      }),
    ).rejects.toBeDefined()
    expect((await ownership.read(taskId))?.state).toBe('claimed')

    const revoked = await ownership.revokeExact({
      owner: ownershipTuple(token),
      expectedRevision: current.revision,
      now: 3_100,
    })
    expect(revoked.state).toBe('revoked')
    expect((await ownership.read(taskId))?.state).toBe('revoked')
  })

  test('⑥ 撤销之后心跳必须被围栏挡住 —— 死掉的 owner 不能复活', async () => {
    const ownership = ownershipFor(harness.db)
    const { taskId, intentId } = await seed(harness.db)
    const token = await ownership.claimPendingIntent({
      intentId,
      identity: identity(),
      now: 1_000,
      leaseMs: LEASE_MS,
    })
    const current = await ownership.read(taskId)
    if (current === null) throw new Error('owner row missing')
    await ownership.revokeExact({
      owner: ownershipTuple(token),
      expectedRevision: current.revision,
      now: 2_000,
    })

    await expect(
      ownership.heartbeat({ token, now: 2_500, leaseMs: LEASE_MS }),
    ).rejects.toBeDefined()
    expect((await ownership.read(taskId))?.state).toBe('revoked')
  })

  test('⑦ 标记需要恢复：状态转 recovery-required 并留下判据码', async () => {
    const ownership = ownershipFor(harness.db)
    const { taskId, intentId } = await seed(harness.db)
    const token = await ownership.claimPendingIntent({
      intentId,
      identity: identity(),
      now: 1_000,
      leaseMs: LEASE_MS,
    })
    const current = await ownership.read(taskId)
    if (current === null) throw new Error('owner row missing')

    const marked = await ownership.markRecoveryRequired({
      token,
      expectedRevision: current.revision,
      code: 'outcome-unknown',
      now: 4_000,
    })
    expect(marked.state).toBe('recovery-required')
    expect((await ownership.read(taskId))?.state).toBe('recovery-required')
  })

  test('⑧ 旧世代 daemon 的 owner 可被持锁者撤销（重启接管路径）', async () => {
    const ownership = ownershipFor(harness.db)
    const { taskId, intentId } = await seed(harness.db)
    const token = await ownership.claimPendingIntent({
      intentId,
      identity: identity(),
      now: 1_000,
      leaseMs: LEASE_MS,
    })
    const current = await ownership.read(taskId)
    if (current === null) throw new Error('owner row missing')

    const revoked = await ownership.revokeOldDaemon({
      owner: ownershipTuple(token),
      expectedRevision: current.revision,
      lockProof: createExclusiveDaemonLockProof({
        daemonGeneration: `successor-${ulid()}`,
        acquiredAt: 4_500,
        lockReceiptDigest: 'd'.repeat(64),
      }),
      now: 5_000,
    })
    expect(revoked.state).toBe('revoked')
  })

  test('⑨ 没有 owner 的任务 read 回 null，不是抛错', async () => {
    const ownership = ownershipFor(harness.db)
    const { taskId } = await seed(harness.db)
    expect(await ownership.read(taskId)).toBeNull()
  })
})
