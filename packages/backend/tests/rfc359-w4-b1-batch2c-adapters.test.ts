// RFC-359 W4-B1 批 2c —— 四对适配器合一，两个引擎各跑一遍：wrapper run 持久化 / node run 冻结运行时 /
// 调度器收尾读写（三者此前 SQLite 走 dbTxSync + withOwnedTaskTx、PG 走 SERIALIZABLE + assertPostgresqlTaskOwnerTx，
// 现在同走 `ownedTaskExecution.ts` 的统一写事务 + 围栏）与不活跃超时持久化（两个具名工厂退为别名）。
// 围栏规则两引擎同一：显式上下文 > 环境上下文 > 无主围栏（仅 `claimed` 的活 owner 拒绝无主写入）。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionOwners, taskRepos, tasks, workflows } from '@/db/schema'
import type { TaskExecutionContextRef } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  createOwnershipToken,
  createWorkerIdentity,
  type OwnershipToken,
} from '@/modules/task-execution/domain/ownership'
import {
  createSqliteTaskIdleTimeoutPersistence,
  createPostgresqlTaskIdleTimeoutPersistence,
  createTaskIdleTimeoutPersistence,
} from '@/modules/task-execution/composition/taskIdleTimeout'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { DrizzleNodeRunRuntimePersistence } from '@/modules/task-execution/infrastructure/nodeRunRuntimePersistence'
import {
  assertTaskOwnerlessTx,
  assertTaskOwnerTx,
  withTaskExecutionWrite,
} from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { DrizzleSchedulerCompletionPersistence } from '@/modules/task-execution/infrastructure/schedulerCompletionPersistence'
import { DrizzleWrapperRunPersistence } from '@/modules/task-execution/infrastructure/wrapperRunPersistence'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
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
  })
  return id
}

/** 直接落一行 `claimed` 的 owner，并铸出与之匹配的 token（epoch 1 / revision 1）。 */
async function seedClaimedOwner(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<{ token: OwnershipToken; context: TaskExecutionContextRef }> {
  const identity = createWorkerIdentity({ ownerId: `owner_${ulid()}`, daemonGeneration: 'gen-a' })
  await db.insert(taskExecutionOwners).values({
    taskId,
    ownerId: identity.ownerId,
    daemonGeneration: identity.daemonGeneration,
    epoch: 1,
    state: 'claimed',
    leaseUntil: Date.now() + 60_000,
    revision: 1,
    lastHeartbeatAt: Date.now(),
    updatedAt: Date.now(),
  })
  const token = createOwnershipToken({
    taskId,
    identity,
    epoch: 1,
    leaseUntil: Date.now() + 60_000,
    ownerRevision: 1,
  })
  // 上下文对象必须由 createTaskExecutionContext 铸造（assertTaskExecutionContext 拒绝任何手拼对象）。
  const context = createTaskExecutionContext({
    intentId: `intent_${ulid()}`,
    token,
    persistence: createTaskExecutionPersistence(db),
  })
  return { token, context }
}

async function ownerRevision(db: ProviderNeutralDatabase, taskId: string): Promise<number | null> {
  const rows = await db
    .select({ revision: taskExecutionOwners.revision })
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, taskId))
  return rows[0]?.revision ?? null
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  over: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n',
    status: 'pending',
    retryIndex: 0,
    iteration: 0,
    ...over,
  })
  return id
}

describeEachProvider('RFC-359 W4-B1 批 2c —— 统一写事务 + owner 围栏', (harness) => {
  test('owner CAS：匹配 token 放行并推进 revision；不匹配 / 非 claimed 拒绝', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const { token } = await seedClaimedOwner(db, taskId)
    await withTaskExecutionWrite(db, (tx) => assertTaskOwnerTx(tx, token, 5))
    expect(await ownerRevision(db, taskId)).toBe(2)
    const stranger = createOwnershipToken({
      taskId,
      identity: createWorkerIdentity({ ownerId: 'someone-else', daemonGeneration: 'gen-a' }),
      epoch: 1,
      leaseUntil: Date.now() + 60_000,
      ownerRevision: 1,
    })
    await expect(
      withTaskExecutionWrite(db, (tx) => assertTaskOwnerTx(tx, stranger, 6)),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    await db
      .update(taskExecutionOwners)
      .set({ state: 'released' })
      .where(eq(taskExecutionOwners.taskId, taskId))
    await expect(
      withTaskExecutionWrite(db, (tx) => assertTaskOwnerTx(tx, token, 7)),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    // 围栏失败整笔回滚：revision 停在 2。
    expect(await ownerRevision(db, taskId)).toBe(2)
  })

  test('无主围栏：只有 claimed 的活 owner 拒绝；released / 无 owner 行放行', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    await withTaskExecutionWrite(db, (tx) => assertTaskOwnerlessTx(tx, taskId))
    await seedClaimedOwner(db, taskId)
    await expect(
      withTaskExecutionWrite(db, (tx) => assertTaskOwnerlessTx(tx, taskId)),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    await db
      .update(taskExecutionOwners)
      .set({ state: 'released' })
      .where(eq(taskExecutionOwners.taskId, taskId))
    await withTaskExecutionWrite(db, (tx) => assertTaskOwnerlessTx(tx, taskId))
  })
})

describeEachProvider('RFC-359 W4-B1 批 2c —— 调度器收尾读写', (harness) => {
  test('recordReadonlyDirty：显式上下文按 token 围栏；无上下文且 owner claimed ⇒ 拒绝', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    await db.insert(taskRepos).values({
      taskId,
      repoIndex: 0,
      repoPath: '/tmp/repo',
      worktreeDirName: 'repo',
      worktreePath: `/tmp/worktree/${taskId}/repo`,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
    })
    const persistence = new DrizzleSchedulerCompletionPersistence(db)
    // 无 owner 行：无主写入放行。
    await persistence.recordReadonlyDirty({ taskId, repoIndex: 0, changedCount: 2, now: 1 })
    const { context } = await seedClaimedOwner(db, taskId)
    await expect(
      persistence.recordReadonlyDirty({ taskId, repoIndex: 0, changedCount: 3, now: 2 }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    await persistence.recordReadonlyDirty({
      taskId,
      repoIndex: 0,
      changedCount: 3,
      execution: context,
      now: 3,
    })
    // 环境上下文同样放行（runner 不逐处传 executionContext）。
    await runWithTaskExecutionContext(context, () =>
      persistence.recordReadonlyDirty({ taskId, repoIndex: 0, changedCount: 4, now: 4 }),
    )
    const rows = await db
      .select({ dirty: taskRepos.readonlyDirtyCount })
      .from(taskRepos)
      .where(eq(taskRepos.taskId, taskId))
    expect(rows[0]?.dirty).toBe(4)
    expect(await ownerRevision(db, taskId)).toBe(3)
  })

  test('listDoneNodeRuns：只列该节点该轮 done 的 run', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const done = await seedRun(db, taskId, { status: 'done' })
    await seedRun(db, taskId, { status: 'failed' })
    await seedRun(db, taskId, { status: 'done', iteration: 1 })
    await seedRun(db, taskId, { status: 'done', nodeId: 'other' })
    const persistence = new DrizzleSchedulerCompletionPersistence(db)
    expect(await persistence.listDoneNodeRuns({ taskId, nodeId: 'n', iteration: 0 })).toEqual([
      { id: done, parentNodeRunId: null, status: 'done' },
    ])
  })
})

describeEachProvider('RFC-359 W4-B1 批 2c —— node run 冻结运行时', (harness) => {
  test('freeze 写三列并可按 run id / session id 读回；owner claimed 时无上下文写入被拒', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, { opencodeSessionId: `ses_${taskId}` })
    const persistence = new DrizzleNodeRunRuntimePersistence(db)
    expect(await persistence.load(runId)).toEqual({
      runtime: null,
      runtimeBinary: null,
      runtimeParamsJson: null,
    })
    await persistence.freeze({
      nodeRunId: runId,
      runtime: 'opencode',
      runtimeBinary: '/usr/local/bin/opencode',
      runtimeParamsJson: '{"model":"m"}',
    })
    const frozen = {
      runtime: 'opencode',
      runtimeBinary: '/usr/local/bin/opencode',
      runtimeParamsJson: '{"model":"m"}',
    }
    expect(await persistence.load(runId)).toEqual(frozen)
    expect(await persistence.findBySessionId(`ses_${taskId}`)).toEqual(frozen)
    expect(await persistence.load('missing')).toBeNull()
    expect(await persistence.findBySessionId('missing')).toBeNull()
    const { context } = await seedClaimedOwner(db, taskId)
    await expect(
      persistence.freeze({
        nodeRunId: runId,
        runtime: 'claude-code',
        runtimeBinary: null,
        runtimeParamsJson: '{}',
      }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    await runWithTaskExecutionContext(context, () =>
      persistence.freeze({
        nodeRunId: runId,
        runtime: 'claude-code',
        runtimeBinary: null,
        runtimeParamsJson: '{}',
      }),
    )
    expect((await persistence.load(runId))?.runtime).toBe('claude-code')
    // 不存在的 run：静默无事。
    await persistence.freeze({
      nodeRunId: 'missing',
      runtime: 'claude-code',
      runtimeBinary: null,
      runtimeParamsJson: '{}',
    })
  })
})

describeEachProvider('RFC-359 W4-B1 批 2c —— wrapper run 持久化', (harness) => {
  test('findResumable 按 frame 取最新未终态 run；readStatus；clearReuseDisabled 受围栏', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    await seedRun(db, taskId, { nodeId: 'w', status: 'done' })
    const running = await seedRun(db, taskId, {
      nodeId: 'w',
      status: 'running',
      wrapperProgressJson: JSON.stringify({
        kind: 'fanout',
        reuseDisabled: true,
        phase: 'inner-running',
      }),
    })
    const persistence = new DrizzleWrapperRunPersistence(db)
    const resumable = await persistence.findResumable({
      taskId,
      nodeId: 'w',
      containerRunId: null,
      iteration: 0,
    })
    expect(resumable?.id).toBe(running)
    expect(resumable?.status).toBe('running')
    expect(
      await persistence.findResumable({ taskId, nodeId: 'w', containerRunId: null, iteration: 9 }),
    ).toBeNull()
    expect(await persistence.readStatus(running)).toBe('running')
    expect(await persistence.readStatus('missing')).toBeNull()

    const { context } = await seedClaimedOwner(db, taskId)
    await expect(persistence.clearReuseDisabled({ nodeRunId: running })).rejects.toMatchObject({
      code: 'task-execution-stale-owner',
    })
    await persistence.clearReuseDisabled({ nodeRunId: running, executionContext: context })
    const rows = await db
      .select({ progress: nodeRuns.wrapperProgressJson })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, running))
    expect(JSON.parse(rows[0]?.progress ?? '{}')).toEqual({
      kind: 'fanout',
      phase: 'inner-running',
    })
    // 不存在的 run：静默无事。
    await persistence.clearReuseDisabled({ nodeRunId: 'missing' })
  })

  test('resolveConsumed：按 frame 为每个来源节点挑已结算的 run', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const src = await seedRun(db, taskId, { nodeId: 'src', status: 'done' })
    const persistence = new DrizzleWrapperRunPersistence(db)
    expect(
      await persistence.resolveConsumed({
        taskId,
        sources: [
          { nodeId: 'src', frame: { containerRunId: null, iteration: 0 } },
          { nodeId: 'absent', frame: { containerRunId: null, iteration: 0 } },
        ],
      }),
    ).toEqual({ src })
  })
})

describeEachProvider('RFC-359 W4-B1 批 2c —— 不活跃超时持久化', (harness) => {
  test('两个 provider 具名工厂就是同一份实现', async () => {
    const db = harness.db
    expect(createSqliteTaskIdleTimeoutPersistence).toBe(createTaskIdleTimeoutPersistence)
    expect(createPostgresqlTaskIdleTimeoutPersistence).toBe(createTaskIdleTimeoutPersistence)
    const persistence = createTaskIdleTimeoutPersistence(db)
    expect(await persistence.listIdleCandidateRoots(10)).toEqual([])
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', 'infrastructure')
  for (const stem of [
    'WrapperRunPersistence',
    'NodeRunRuntimePersistence',
    'SchedulerCompletionPersistence',
    'TaskIdleTimeoutPersistence',
  ]) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(infra, `${provider}${stem}.ts`))).toBe(false)
    }
  }
})
