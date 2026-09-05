// RFC-359 W4-B1 批 2h —— 优雅停机幸存者处置（TaskExecutionShutdownOperations）两份合一，两个引擎各跑一遍：
// running 幸存者的控制面 CAS（不过 owner 围栏）+ intent 终态化 + revision 推进；owner 行按精确元组 CAS 进 recovery-required。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { DAEMON_RESTART_ERROR_SUMMARY } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionIntents, taskExecutionOwners, tasks, workflows } from '@/db/schema'
import { DrizzleTaskExecutionShutdownOperations } from '@/modules/task-execution/infrastructure/taskExecutionShutdownOperations'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedTask(
  db: ProviderNeutralDatabase,
  over: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const id = `t_${ulid()}`
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    ...over,
  })
  return id
}

async function seedOwner(
  db: ProviderNeutralDatabase,
  taskId: string,
  state: 'claimed' | 'revoked' | 'released',
): Promise<void> {
  await db.insert(taskExecutionOwners).values({
    taskId,
    ownerId: `owner_${taskId}`,
    daemonGeneration: 'gen-a',
    epoch: 1,
    state,
    leaseUntil: Date.now() + 60_000,
    revision: 4,
    lastHeartbeatAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function ownerRow(db: ProviderNeutralDatabase, taskId: string) {
  const rows = await db
    .select({
      state: taskExecutionOwners.state,
      revision: taskExecutionOwners.revision,
      recoveryCode: taskExecutionOwners.recoveryCode,
    })
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, taskId))
  return rows[0]
}

describeEachProvider('RFC-359 W4-B1 批 2h —— 停机幸存者处置', (harness) => {
  test('interruptSurvivor：running 才赢；赢一次推进 revision、终态化 intent、写下 daemon-restart 摘要', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    // 幸存者的 owner 仍是 claimed：控制面越权收场，不过围栏。
    await seedOwner(db, taskId, 'claimed')
    const intentId = `intent_${ulid()}`
    await db.insert(taskExecutionIntents).values({
      id: intentId,
      taskId,
      kind: 'launch',
      state: 'claimed',
      claimedEpoch: 1,
      claimedAt: 1,
      source: 'rest',
      requestHash: `h_${intentId}`,
      payloadJson: '{}',
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPathJson: '[]',
      expectedTaskRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    const ops = new DrizzleTaskExecutionShutdownOperations(db)
    expect(await ops.listRunningTaskIds()).toContain(taskId)
    const before = (
      await db
        .select({ revision: tasks.lifecycleEventRevision })
        .from(tasks)
        .where(eq(tasks.id, taskId))
    )[0]!.revision
    expect(await ops.interruptSurvivor({ taskId, now: 9, errorMessage: 'budget exceeded' })).toBe(
      true,
    )
    const after = (
      await db
        .select({
          status: tasks.status,
          revision: tasks.lifecycleEventRevision,
          errorSummary: tasks.errorSummary,
          errorMessage: tasks.errorMessage,
          finishedAt: tasks.finishedAt,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
    )[0]!
    expect(after).toEqual({
      status: 'interrupted',
      revision: before + 1,
      errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
      errorMessage: 'budget exceeded',
      finishedAt: 9,
    })
    const intent = (
      await db
        .select({
          state: taskExecutionIntents.state,
          failureCode: taskExecutionIntents.failureCode,
        })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, intentId))
    )[0]
    expect(intent).toEqual({ state: 'failed', failureCode: 'daemon-shutdown-survivor' })
    expect(await ops.listRunningTaskIds()).not.toContain(taskId)
    // 已经不是 running ⇒ 输掉 CAS；不存在的任务同样 false。
    expect(await ops.interruptSurvivor({ taskId, now: 10, errorMessage: 'again' })).toBe(false)
    expect(await ops.interruptSurvivor({ taskId: 'missing', now: 10, errorMessage: 'x' })).toBe(
      false,
    )
    const done = await seedTask(db, { status: 'done', finishedAt: 2 })
    expect(await ops.interruptSurvivor({ taskId: done, now: 10, errorMessage: 'x' })).toBe(false)
  })

  test('markRecoveryRequired：claimed / revoked 的 owner 按精确元组 CAS 进 recovery-required；released 与缺行不动', async () => {
    const db = harness.db
    const claimed = await seedTask(db)
    await seedOwner(db, claimed, 'claimed')
    const revoked = await seedTask(db)
    await seedOwner(db, revoked, 'revoked')
    const released = await seedTask(db)
    await seedOwner(db, released, 'released')
    const ops = new DrizzleTaskExecutionShutdownOperations(db)
    for (const taskId of [claimed, revoked, released, 'missing']) {
      await ops.markRecoveryRequired({ taskId, now: 7, recoveryCode: 'daemon-shutdown-survivor' })
    }
    expect(await ownerRow(db, claimed)).toEqual({
      state: 'recovery-required',
      revision: 5,
      recoveryCode: 'daemon-shutdown-survivor',
    })
    expect(await ownerRow(db, revoked)).toEqual({
      state: 'recovery-required',
      revision: 5,
      recoveryCode: 'daemon-shutdown-survivor',
    })
    expect(await ownerRow(db, released)).toEqual({
      state: 'released',
      revision: 4,
      recoveryCode: null,
    })
    // 幂等：已是 recovery-required 的行不再动。
    await ops.markRecoveryRequired({ taskId: claimed, now: 8, recoveryCode: 'other' })
    expect((await ownerRow(db, claimed))?.revision).toBe(5)
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', 'infrastructure')
  for (const provider of ['sqlite', 'postgresql']) {
    expect(existsSync(resolve(infra, `${provider}TaskExecutionShutdownOperations.ts`))).toBe(false)
  }
})
