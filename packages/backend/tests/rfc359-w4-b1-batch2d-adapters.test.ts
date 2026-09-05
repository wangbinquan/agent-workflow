// RFC-359 W4-B1 批 2d —— 四对只差事务 / 围栏原语的适配器合到 `ownedTaskExecution.ts` 上，两个引擎各跑一遍：
// 运行时会话捕获（appendEvents 受围栏）、人工门 continuation pre-drive（inspect / releaseClarifyForRetry
// 按 token 精确围栏）、merge_state 迁移（读 + CAS 写同一事务）、TaskEngine drive 快照 + 工作区 profile 更新。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunEvents,
  nodeRuns,
  taskExecutionIntents,
  taskExecutionOwners,
  taskRepos,
  tasks,
  workflows,
} from '@/db/schema'
import type { TaskExecutionContextRef } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createOwnershipToken,
  createWorkerIdentity,
  type OwnershipToken,
} from '@/modules/task-execution/domain/ownership'
import { DrizzleGateContinuationPreDrivePersistence } from '@/modules/task-execution/infrastructure/gateContinuationPreDrivePersistence'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { createRuntimeSessionCapturePersistence } from '@/modules/task-execution/infrastructure/runtimeSessionCapturePersistence'
import { DrizzleTaskEngineApplicationPersistence } from '@/modules/task-execution/infrastructure/taskEngineApplicationPersistence'
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

async function seedClaimedOwner(
  db: ProviderNeutralDatabase,
  taskId: string,
  epoch = 1,
): Promise<{ token: OwnershipToken; context: TaskExecutionContextRef }> {
  const identity = createWorkerIdentity({ ownerId: `owner_${ulid()}`, daemonGeneration: 'gen-a' })
  await db.insert(taskExecutionOwners).values({
    taskId,
    ownerId: identity.ownerId,
    daemonGeneration: identity.daemonGeneration,
    epoch,
    state: 'claimed',
    leaseUntil: Date.now() + 60_000,
    revision: 1,
    lastHeartbeatAt: Date.now(),
    updatedAt: Date.now(),
  })
  const token = createOwnershipToken({
    taskId,
    identity,
    epoch,
    leaseUntil: Date.now() + 60_000,
    ownerRevision: 1,
  })
  const context = createTaskExecutionContext({
    intentId: `intent_${ulid()}`,
    token,
    persistence: createTaskExecutionPersistence(db),
  })
  return { token, context }
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
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    ...over,
  })
  return id
}

describeEachProvider('RFC-359 W4-B1 批 2d —— 运行时会话捕获持久化', (harness) => {
  test('resolveTaskId / 同任务其它 run 的会话 id / appendEvents 受围栏', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runA = await seedRun(db, taskId)
    const runB = await seedRun(db, taskId)
    const persistence = createRuntimeSessionCapturePersistence(db)
    expect(await persistence.resolveTaskId(runA)).toBe(taskId)
    expect(await persistence.resolveTaskId('missing')).toBeNull()

    const event = (sessionId: string) => ({
      ts: 1,
      kind: 'text' as const,
      payload: '{}',
      sessionId,
      parentSessionId: null,
    })
    // 无 owner 行：无主写入放行；空批次不落库。
    await persistence.appendEvents({ taskId, nodeRunId: runB, events: [] })
    await persistence.appendEvents({ taskId, nodeRunId: runB, events: [event('ses-b')] })
    expect(await persistence.listSiblingCapturedSessionIds({ taskId, nodeRunId: runA })).toEqual(
      new Set(['ses-b']),
    )
    expect(await persistence.listSiblingCapturedSessionIds({ taskId, nodeRunId: runB })).toEqual(
      new Set(),
    )

    const { context } = await seedClaimedOwner(db, taskId)
    await expect(
      persistence.appendEvents({ taskId, nodeRunId: runA, events: [event('ses-a')] }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    await runWithTaskExecutionContext(context, () =>
      persistence.appendEvents({ taskId, nodeRunId: runA, events: [event('ses-a')] }),
    )
    const rows = await db
      .select({ sessionId: nodeRunEvents.sessionId })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, runA))
    expect(rows.map((row) => row.sessionId)).toEqual(['ses-a'])
  })
})

describeEachProvider('RFC-359 W4-B1 批 2d —— 人工门 continuation pre-drive', (harness) => {
  async function seedIntent(
    db: ProviderNeutralDatabase,
    taskId: string,
    over: Partial<typeof taskExecutionIntents.$inferInsert> = {},
  ): Promise<string> {
    const intentId = `intent_${ulid()}`
    await db.insert(taskExecutionIntents).values({
      id: intentId,
      taskId,
      kind: 'gate-continuation',
      state: 'claimed',
      claimedEpoch: 1,
      claimedAt: 1,
      source: 'rest',
      requestHash: `h_${intentId}`,
      payloadJson: '{}',
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:${intentId}`,
      slotPathJson: '[]',
      expectedTaskRevision: 1,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    })
    return intentId
  }

  test('inspect：只有 claimed 且 epoch 匹配的 intent 可读；非 clarify 载荷 ⇒ ready', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const { token } = await seedClaimedOwner(db, taskId)
    const intentId = await seedIntent(db, taskId)
    const persistence = new DrizzleGateContinuationPreDrivePersistence(db)
    expect(await persistence.inspect({ taskId, intentId, token })).toEqual({ kind: 'ready' })
    // 一个任务同时只能有一个 claimed intent（idx_task_execution_intents_claimed_task），
    // epoch 不匹配的场景放到另一个任务上。
    const otherTask = await seedTask(db)
    const stale = await seedIntent(db, otherTask, { claimedEpoch: 2 })
    await expect(
      persistence.inspect({ taskId: otherTask, intentId: stale, token }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    await expect(persistence.inspect({ taskId, intentId: 'missing', token })).rejects.toMatchObject(
      { code: 'task-execution-stale-owner' },
    )
    expect(await persistence.hasUndispatchedClarifyWork({ taskId, originNodeRunId: 'r' })).toBe(
      false,
    )
  })

  test('releaseClarifyForRetry：按 token 围栏 + 精确 CAS 放回 pending；错 epoch 拒绝', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const { token } = await seedClaimedOwner(db, taskId)
    const intentId = await seedIntent(db, taskId)
    const persistence = new DrizzleGateContinuationPreDrivePersistence(db)
    await persistence.releaseClarifyForRetry({ taskId, intentId, token, now: 5 })
    const rows = await db
      .select({
        state: taskExecutionIntents.state,
        claimedEpoch: taskExecutionIntents.claimedEpoch,
        failureCode: taskExecutionIntents.failureCode,
      })
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.id, intentId))
    expect(rows[0]).toEqual({
      state: 'pending',
      claimedEpoch: null,
      failureCode: 'clarify-convergence-retry',
    })
    // 已经不是 claimed ⇒ CAS 失手 ⇒ stale-owner，且围栏推进的 revision 随事务回滚。
    await expect(
      persistence.releaseClarifyForRetry({ taskId, intentId, token, now: 6 }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    const owner = await db
      .select({ revision: taskExecutionOwners.revision })
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, taskId))
    expect(owner[0]?.revision).toBe(2)
  })
})

describeEachProvider('RFC-359 W4-B1 批 2d —— merge_state 迁移', (harness) => {
  test('transition 走状态机 CAS；tryTransition 把非法 / 缺行折成 false；围栏两侧同一规则', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    expect(
      await persistence.transition({
        nodeRunId: runId,
        event: { kind: 'begin-isolation' },
        extra: { isoWorktreePath: '/tmp/iso' },
      }),
    ).toEqual({ from: null, to: 'isolating' })
    const rows = await db
      .select({ mergeState: nodeRuns.mergeState, iso: nodeRuns.isoWorktreePath })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, runId))
    expect(rows[0]).toEqual({ mergeState: 'isolating', iso: '/tmp/iso' })
    // 非法迁移（isolating 上 mark-merged）/ 不存在的 run：tryTransition 折成 false，transition 抛错。
    expect(
      await persistence.tryTransition({ nodeRunId: runId, event: { kind: 'mark-merged' } }),
    ).toBe(false)
    expect(
      await persistence.tryTransition({ nodeRunId: 'missing', event: { kind: 'begin-isolation' } }),
    ).toBe(false)
    await expect(
      persistence.transition({ nodeRunId: 'missing', event: { kind: 'begin-isolation' } }),
    ).rejects.toMatchObject({ code: 'node-run-not-found' })
    const { context } = await seedClaimedOwner(db, taskId)
    await expect(
      persistence.transition({ nodeRunId: runId, event: { kind: 'mark-pending-merge' } }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    expect(
      await persistence.transition({
        nodeRunId: runId,
        event: { kind: 'mark-pending-merge' },
        executionContext: context,
        now: 9,
      }),
    ).toEqual({ from: 'isolating', to: 'pending-merge' })
  })
})

describeEachProvider('RFC-359 W4-B1 批 2d —— TaskEngine drive 持久化', (harness) => {
  test('load 拼任务 / 仓库 / 协作者快照；findStatus；updateWorkspaceProfile 受围栏且缺行 ⇒ false', async () => {
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
    const persistence = new DrizzleTaskEngineApplicationPersistence(db)
    const snapshot = await persistence.load(taskId)
    expect(snapshot?.task.id).toBe(taskId)
    expect(snapshot?.repositories.map((repo) => repo.repoIndex)).toEqual([0])
    expect(snapshot?.collaborators).toEqual([])
    expect(await persistence.load('missing')).toBeNull()
    expect(await persistence.findStatus(taskId)).toBe('running')
    expect(await persistence.findStatus('missing')).toBeNull()

    expect(
      await persistence.updateWorkspaceProfile({
        taskId,
        repoIndex: 0,
        version: 1,
        digest: 'd1',
        now: 1,
      }),
    ).toBe(true)
    expect(
      await persistence.updateWorkspaceProfile({
        taskId,
        repoIndex: 7,
        version: 1,
        digest: 'd1',
        now: 1,
      }),
    ).toBe(false)
    const { context } = await seedClaimedOwner(db, taskId)
    await expect(
      persistence.updateWorkspaceProfile({
        taskId,
        repoIndex: 0,
        version: 2,
        digest: 'd2',
        now: 2,
      }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    expect(
      await persistence.updateWorkspaceProfile({
        taskId,
        repoIndex: 0,
        version: 2,
        digest: 'd2',
        executionContext: context,
        now: 2,
      }),
    ).toBe(true)
    expect((await persistence.load(taskId))?.repositories[0]?.workspaceProfileDigest).toBe('d2')
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', 'infrastructure')
  for (const stem of [
    'RuntimeSessionCapturePersistence',
    'GateContinuationPreDrivePersistence',
    'MergeStateLifecyclePersistence',
    'TaskEngineApplicationPersistence',
  ]) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(infra, `${provider}${stem}.ts`))).toBe(false)
    }
  }
})
