// RFC-359 W4-B1 批 2g —— lifecycle 内核四对合一，两个引擎各跑一遍：任务运行时状态迁移（CAS + revision +
// 复活门 + owner 围栏）、node run 生命周期（mint / transition / set / 事务内参与者）、执行 intent 准入
// （提交 / continuation / 待处理 gate successor）、intent 终态化（按 epoch 过滤 + replay 授权释放）。
// 此前 SQLite 侧四个薄壳套 `platform/persistence/sqlite/taskLifecycle.ts` 等同步内核，PG 侧各自整份实现。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunOutputs,
  nodeRuns,
  taskExecutionIntents,
  taskExecutionOwners,
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
  canonicalJson,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import {
  createOwnershipToken,
  createWorkerIdentity,
  type OwnershipToken,
} from '@/modules/task-execution/domain/ownership'
import {
  createNodeRunLifecycleParticipantInTx,
  DrizzleNodeRunLifecyclePersistence,
} from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { withTaskExecutionWrite } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { DrizzleTaskExecutionIntentPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'
import {
  DrizzleTaskExecutionIntentTerminalPersistence,
  terminalizeTaskExecutionIntentsInTx,
} from '@/modules/task-execution/infrastructure/taskExecutionIntentTerminalPersistence'
import { DrizzleTaskRuntimeLifecyclePersistence } from '@/modules/task-execution/infrastructure/taskRuntimeLifecyclePersistence'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

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
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    executionLineageId: id,
    lineageSlotPathJson: canonicalJson(rootPath(id)),
    ...over,
  })
  return id
}

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
  const context = createTaskExecutionContext({
    intentId: `intent_${ulid()}`,
    token,
    persistence: createTaskExecutionPersistence(db),
  })
  return { token, context }
}

async function taskRow(db: ProviderNeutralDatabase, taskId: string) {
  const rows = await db
    .select({
      status: tasks.status,
      revision: tasks.lifecycleEventRevision,
      errorSummary: tasks.errorSummary,
      runningSince: tasks.runningSince,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
  return rows[0]
}

function continuation(taskId: string): CanonicalContinuationRequest {
  return {
    taskId,
    kind: 'launch',
    source: 'rest',
    actorUserId: 'actor-1',
    expectedTaskRevision: 1,
    scope: {
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPath: rootPath(taskId),
      operationGeneration: 0,
    },
    payload: { v: 1 },
  }
}

describeEachProvider('RFC-359 W4-B1 批 2g —— 任务运行时状态迁移', (harness) => {
  test('CAS 推进 revision；非法来源 / 终态覆盖 ⇒ false；复活门与 owner 围栏', async () => {
    const db = harness.db
    const taskId = await seedTask(db, { status: 'pending' })
    const lifecycle = new DrizzleTaskRuntimeLifecyclePersistence(db)
    const before = (await taskRow(db, taskId))!.revision
    expect(
      await lifecycle.trySet({
        taskId,
        to: 'running',
        allowedFrom: ['pending'],
        now: 10,
        reason: 'test-start',
      }),
    ).toBe(true)
    let row = (await taskRow(db, taskId))!
    expect(row.status).toBe('running')
    expect(row.revision).toBe(before + 1)
    expect(row.runningSince).toBe(10)
    // 来源不在 allowedFrom ⇒ false（不抛）。
    expect(
      await lifecycle.trySet({
        taskId,
        to: 'done',
        allowedFrom: ['pending'],
        now: 11,
        reason: 'x',
      }),
    ).toBe(false)
    expect(
      await lifecycle.trySet({
        taskId,
        to: 'failed',
        allowedFrom: ['running'],
        extra: { finishedAt: 12, errorSummary: 'boom' },
        now: 12,
        reason: 'test-fail',
      }),
    ).toBe(true)
    row = (await taskRow(db, taskId))!
    expect(row.status).toBe('failed')
    expect(row.errorSummary).toBe('boom')
    // 终态不带 allowTerminal 不可覆盖；带上就是复活，且不存在的任务 ⇒ false。
    expect(
      await lifecycle.trySet({
        taskId,
        to: 'running',
        allowedFrom: ['failed'],
        now: 13,
        reason: 'x',
      }),
    ).toBe(false)
    expect(
      await lifecycle.trySet({
        taskId: 'missing',
        to: 'running',
        allowedFrom: ['failed'],
        now: 13,
        reason: 'x',
      }),
    ).toBe(false)
    expect(
      await lifecycle.trySet({
        taskId,
        to: 'running',
        allowedFrom: ['failed'],
        allowTerminal: true,
        now: 14,
        reason: 'resume',
      }),
    ).toBe(true)
    // 工作区已被 GC 回收 ⇒ 复活 410（DomainError，不折成 false）。
    await lifecycle.trySet({
      taskId,
      to: 'failed',
      allowedFrom: ['running'],
      now: 15,
      reason: 'fail-again',
    })
    await db.update(tasks).set({ workspacePrunedAt: 15 }).where(eq(tasks.id, taskId))
    await expect(
      lifecycle.trySet({
        taskId,
        to: 'running',
        allowedFrom: ['failed'],
        allowTerminal: true,
        now: 16,
        reason: 'resume',
      }),
    ).rejects.toMatchObject({ code: 'workspace-pruned' })

    const live = await seedTask(db)
    const { context } = await seedClaimedOwner(db, live)
    await expect(
      lifecycle.trySet({ taskId: live, to: 'done', allowedFrom: ['running'], now: 1, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    expect(
      await lifecycle.trySet({
        taskId: live,
        to: 'done',
        allowedFrom: ['running'],
        executionContext: context,
        now: 2,
        reason: 'finish',
      }),
    ).toBe(true)
    expect((await taskRow(db, live))?.status).toBe('done')
  })
})

describeEachProvider('RFC-359 W4-B1 批 2g —— node run 生命周期', (harness) => {
  test('mint / transition / set / envelope nonce；围栏与并发 CAS', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const lifecycle = new DrizzleNodeRunLifecyclePersistence(db)
    const runId = await lifecycle.mint({
      taskId,
      nodeId: 'n',
      status: 'pending',
      cause: 'initial',
    })
    expect(await lifecycle.loadEnvelopeNonce(runId)).toEqual(expect.any(String))
    expect(await lifecycle.loadEnvelopeNonce('missing')).toBe('')
    expect(
      await lifecycle.transition({
        nodeRunId: runId,
        event: { kind: 'mark-running' },
        extra: { startedAt: 1 },
      }),
    ).toEqual({ from: 'pending', to: 'running' })
    // 非法事件（running 上再 mark-running）抛 IllegalNodeRunTransition；缺行 ⇒ node-run-not-found。
    await expect(
      lifecycle.transition({ nodeRunId: runId, event: { kind: 'mark-running' } }),
    ).rejects.toBeDefined()
    await expect(
      lifecycle.transition({ nodeRunId: 'missing', event: { kind: 'mark-running' } }),
    ).rejects.toMatchObject({ code: 'node-run-not-found' })
    expect(
      await lifecycle.set({
        nodeRunId: runId,
        to: 'done',
        allowedFrom: ['running'],
        extra: { finishedAt: 2 },
        reason: 'test',
      }),
    ).toEqual({ from: 'running', to: 'done' })
    // 事务内参与者：同一份 CAS。
    await expect(
      withTaskExecutionWrite(db, (tx) =>
        createNodeRunLifecycleParticipantInTx(tx).set({
          nodeRunId: runId,
          to: 'failed',
          allowedFrom: ['running'],
          reason: 'stale',
        }),
      ),
    ).rejects.toBeDefined()

    const { context } = await seedClaimedOwner(db, taskId)
    await expect(
      lifecycle.mint({ taskId, nodeId: 'm', status: 'pending', cause: 'initial' }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    const minted = await runWithTaskExecutionContext(context, () =>
      lifecycle.mint({ taskId, nodeId: 'm', status: 'pending', cause: 'initial' }),
    )
    const rows = await db
      .select({ nodeId: nodeRuns.nodeId, status: nodeRuns.status })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, minted))
    expect(rows[0]).toEqual({ nodeId: 'm', status: 'pending' })
  })
})

describeEachProvider('RFC-359 W4-B1 批 2g —— born-done 行与初始输出同一事务', (harness) => {
  test('mint 带 outputs：行与输出一起可见；输出落库失败 ⇒ 整笔回滚、行也不存在', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const lifecycle = new DrizzleNodeRunLifecyclePersistence(db)
    const runId = await lifecycle.mint({
      taskId,
      nodeId: 'in1',
      status: 'done',
      cause: 'io-virtual',
      outputs: [{ portName: 'k1', content: 'AAA' }],
    })
    const outputs = await db
      .select({ portName: nodeRunOutputs.portName, content: nodeRunOutputs.content })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, runId))
    expect(outputs).toEqual([{ portName: 'k1', content: 'AAA' }])
    // 同一端口重复 ⇒ 唯一键冲突 ⇒ 行随输出一起回滚。
    await expect(
      lifecycle.mint({
        taskId,
        nodeId: 'in2',
        status: 'done',
        cause: 'io-virtual',
        outputs: [
          { portName: 'k2', content: 'B' },
          { portName: 'k2', content: 'B-dup' },
        ],
      }),
    ).rejects.toBeDefined()
    const rows = await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(eq(nodeRuns.nodeId, 'in2'))
    expect(rows.filter((row) => row.id !== runId)).toEqual([])
  })
})

describeEachProvider('RFC-359 W4-B1 批 2g —— 执行 intent 准入与终态化', (harness) => {
  test('submit / hasPendingGateSuccessor / terminalize（按 epoch 过滤）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const intents = new DrizzleTaskExecutionIntentPersistence(db)
    const submitted = await intents.submit({
      request: continuation(taskId),
      intentId: `intent_${ulid()}`,
    })
    expect(submitted.intentId).toEqual(expect.any(String))
    expect(await intents.hasPendingGateSuccessor(taskId)).toBe(false)
    const gate = `intent_${ulid()}`
    await db.insert(taskExecutionIntents).values({
      id: gate,
      taskId,
      kind: 'gate-continuation',
      state: 'claimed',
      claimedEpoch: 3,
      claimedAt: 1,
      source: 'rest',
      requestHash: `h_${gate}`,
      payloadJson: '{}',
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:gate`,
      slotPathJson: '[]',
      expectedTaskRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    const terminal = new DrizzleTaskExecutionIntentTerminalPersistence(db)
    // 只终态化 epoch 3 的 claimed intent；pending 的提交不受影响。
    await terminal.terminalize({
      taskId,
      state: 'failed',
      failureCode: 'epoch-3',
      now: 5,
      claimedOwnerEpoch: 3,
    })
    const states = async () =>
      (
        await db
          .select({ id: taskExecutionIntents.id, state: taskExecutionIntents.state })
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.taskId, taskId))
      ).map((row) => [row.id, row.state] as const)
    expect(new Map(await states()).get(gate)).toBe('failed')
    expect(new Map(await states()).get(submitted.intentId)).toBe('pending')
    // 不带 epoch：pending + claimed 全部终态化；事务内参与者形态同一份。
    await withTaskExecutionWrite(db, (tx) =>
      terminalizeTaskExecutionIntentsInTx(tx, {
        taskId,
        state: 'failed',
        failureCode: 'all',
        now: 6,
      }),
    )
    expect(new Map(await states()).get(submitted.intentId)).toBe('failed')
    // 没有活跃 intent：无事。
    await terminal.terminalize({ taskId, state: 'failed', failureCode: 'none', now: 7 })
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', 'infrastructure')
  for (const stem of [
    'TaskRuntimeLifecyclePersistence',
    'NodeRunLifecyclePersistence',
    'TaskExecutionIntentPersistence',
    'TaskExecutionIntentTerminalPersistence',
  ]) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(infra, `${provider}${stem}.ts`))).toBe(false)
    }
  }
})
