// RFC-359 W4-B1 批 2e —— 任务恢复读 / 写（TaskRecoveryOperations）两份约千行的 provider 实现合成一份，两个引擎各跑一遍：
// 恢复事件簿、自动恢复窗口 / 熔断、repo-prep 行、运行时会话租约的孤儿修复（复用 / 作废两支）、
// 四条注入的状态迁移只做转发（周期性收割先看有无活 run）。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, runtimeSessionLeases, tasks, workflows } from '@/db/schema'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import {
  createTaskRecoveryOperations,
  repairRuntimeSessionLeaseAfterOrphanReapTx,
  type TaskRecoveryMutationOperations,
} from '@/modules/task-execution/infrastructure/taskRecoveryOperations'
import { REPO_PREP_NODE_ID } from '@agent-workflow/shared'
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

function recordingMutations(): {
  mutations: TaskRecoveryMutationOperations
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    mutations: {
      async interruptBootOrphanTask(input) {
        calls.push(`boot:${input.taskId}`)
        return true
      },
      async interruptNodeRun(input) {
        calls.push(`run:${input.nodeRunId}`)
        return true
      },
      async repairRuntimeSessionLeaseAfterOrphanReap(nodeRunId) {
        calls.push(`lease:${nodeRunId}`)
        return 7
      },
      async interruptPeriodicTaskIfIdle(input) {
        calls.push(`periodic:${input.taskId}`)
        return true
      },
    },
  }
}

function operationsFor(db: ProviderNeutralDatabase): {
  operations: TaskRecoveryOperations
  calls: string[]
} {
  const { mutations, calls } = recordingMutations()
  return { operations: createTaskRecoveryOperations(db, mutations), calls }
}

describeEachProvider('RFC-359 W4-B1 批 2e —— 恢复事件簿与自动恢复窗口', (harness) => {
  test('recordEvent / listEventsForTask 按时间倒序取最近 N 条', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const { operations } = operationsFor(db)
    for (const [index, createdAt] of [10, 30, 20].entries()) {
      await operations.recordEvent({
        id: `rev_${taskId}_${index}`,
        taskId,
        nodeRunId: null,
        actor: 'system',
        kind: 'boot-reap',
        reason: `r${index}`,
        beforeJson: null,
        afterJson: null,
        createdAt,
      })
    }
    const events = await operations.listEventsForTask(taskId, 2)
    expect(events.map((event) => event.createdAt)).toEqual([30, 20])
    expect(events[0]?.reason).toBe('r1')
    expect(await operations.listEventsForTask('missing', 5)).toEqual([])
  })

  test('recordAutoRecoveryAttempt：窗口内累计、超阈值熔断、窗口过期重置、clear 解除', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const { operations } = operationsFor(db)
    const config = { windowMs: 1_000, maxPerWindow: 2 }
    expect(await operations.isAutoRecoverySuspended(taskId)).toBe(false)
    expect(await operations.recordAutoRecoveryAttempt({ taskId, now: 100, config })).toEqual({
      suspended: false,
      attempts: 1,
    })
    expect(await operations.recordAutoRecoveryAttempt({ taskId, now: 200, config })).toEqual({
      suspended: false,
      attempts: 2,
    })
    expect(await operations.recordAutoRecoveryAttempt({ taskId, now: 300, config })).toEqual({
      suspended: true,
      attempts: 3,
    })
    expect(await operations.isAutoRecoverySuspended(taskId)).toBe(true)
    // 已熔断：后续尝试只回报状态，不再累计。
    expect(await operations.recordAutoRecoveryAttempt({ taskId, now: 400, config })).toEqual({
      suspended: true,
      attempts: 3,
    })
    await operations.clearAutoRecoverySuspension(taskId)
    expect(await operations.isAutoRecoverySuspended(taskId)).toBe(false)
    // 窗口过期 ⇒ 从 1 重新计。
    expect(await operations.recordAutoRecoveryAttempt({ taskId, now: 5_000, config })).toEqual({
      suspended: false,
      attempts: 1,
    })
    // 不存在的任务：无事。
    expect(
      await operations.recordAutoRecoveryAttempt({ taskId: 'missing', now: 1, config }),
    ).toEqual({ suspended: false, attempts: 0 })
    expect(await operations.isAutoRecoverySuspended('missing')).toBe(false)
  })

  test('taskIdsWithRepoPrepRow 只认 repo-prep 节点的 run', async () => {
    const db = harness.db
    const withPrep = await seedTask(db)
    const without = await seedTask(db)
    await seedRun(db, withPrep, { nodeId: REPO_PREP_NODE_ID, status: 'done' })
    await seedRun(db, without)
    const { operations } = operationsFor(db)
    expect(await operations.taskIdsWithRepoPrepRow([withPrep, without, 'missing'])).toEqual(
      new Set([withPrep]),
    )
    expect(await operations.taskIdsWithRepoPrepRow([])).toEqual(new Set())
  })
})

describeEachProvider('RFC-359 W4-B1 批 2e —— 运行时会话租约的孤儿修复', (harness) => {
  async function seedLease(
    db: ProviderNeutralDatabase,
    input: { taskId: string; runId: string; sessionId: string; resetPending?: boolean },
  ) {
    await db.insert(runtimeSessionLeases).values({
      protocol: 'opencode',
      sessionId: input.sessionId,
      taskId: input.taskId,
      nodeId: 'n',
      createdNodeRunId: input.runId,
      leaseNodeRunId: input.runId,
      leaseNonceDigest: 'nonce',
      leasedAt: 1,
      resetPending: input.resetPending ?? false,
    })
  }

  test('终态 run 且会话身份完好 ⇒ 释放租约可复用；身份失效 ⇒ 作废租约并清掉 run 的会话 id', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const reusable = await seedRun(db, taskId, { status: 'done', opencodeSessionId: 'ses-ok' })
    await seedLease(db, { taskId, runId: reusable, sessionId: 'ses-ok' })
    const { operations } = operationsFor(db)
    expect(await operations.findHeldRuntimeSessionId(reusable)).toBe('ses-ok')
    expect(await repairRuntimeSessionLeaseAfterOrphanReapTx(db, reusable)).toBe(1)
    const released = await db
      .select({ leaseNodeRunId: runtimeSessionLeases.leaseNodeRunId })
      .from(runtimeSessionLeases)
      .where(eq(runtimeSessionLeases.sessionId, 'ses-ok'))
    expect(released[0]?.leaseNodeRunId).toBeNull()
    expect(await operations.findHeldRuntimeSessionId(reusable)).toBeNull()

    const invalid = await seedRun(db, taskId, {
      status: 'failed',
      opencodeSessionId: 'ses-bad',
      failureCode: 'runtime-session-identity-invalid',
    })
    await seedLease(db, { taskId, runId: invalid, sessionId: 'ses-bad' })
    expect(await repairRuntimeSessionLeaseAfterOrphanReapTx(db, invalid)).toBe(1)
    expect(
      await db
        .select({ sessionId: runtimeSessionLeases.sessionId })
        .from(runtimeSessionLeases)
        .where(eq(runtimeSessionLeases.sessionId, 'ses-bad')),
    ).toEqual([])
    const run = await db
      .select({ sessionId: nodeRuns.opencodeSessionId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, invalid))
    expect(run[0]?.sessionId).toBeNull()
  })

  test('run 未终态 / 没有租约 ⇒ 不动，返回 0', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const running = await seedRun(db, taskId, { status: 'running', opencodeSessionId: 'ses-live' })
    await seedLease(db, { taskId, runId: running, sessionId: 'ses-live' })
    expect(await repairRuntimeSessionLeaseAfterOrphanReapTx(db, running)).toBe(0)
    expect(await repairRuntimeSessionLeaseAfterOrphanReapTx(db, 'missing')).toBe(0)
    const { operations } = operationsFor(db)
    expect(await operations.findHeldRuntimeSessionId(running)).toBe('ses-live')
  })
})

describeEachProvider('RFC-359 W4-B1 批 2e —— 注入的状态迁移只做转发', (harness) => {
  test('boot 孤儿 / node run / 租约修复直接转发；周期性收割先看有无活 run', async () => {
    const db = harness.db
    const busy = await seedTask(db)
    await seedRun(db, busy, { status: 'pending' })
    const idle = await seedTask(db)
    await seedRun(db, idle, { status: 'done' })
    const { operations, calls } = operationsFor(db)
    expect(
      await operations.interruptBootOrphanTask({
        taskId: busy,
        from: 'running',
        failureCode: 'daemon-restart',
        errorMessage: 'daemon restarted',
        now: 1,
      }),
    ).toBe(true)
    expect(await operations.interruptNodeRun({ nodeRunId: 'run-1', now: 1 })).toBe(true)
    expect(await operations.repairRuntimeSessionLeaseAfterOrphanReap('run-1')).toBe(7)
    expect(
      await operations.interruptPeriodicTaskIfIdle({ taskId: busy, failureCode: 'x', now: 1 }),
    ).toBe(false)
    expect(
      await operations.interruptPeriodicTaskIfIdle({ taskId: idle, failureCode: 'x', now: 1 }),
    ).toBe(true)
    expect(calls).toEqual([`boot:${busy}`, 'run:run-1', 'lease:run-1', `periodic:${idle}`])
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', 'infrastructure')
  for (const provider of ['sqlite', 'postgresql']) {
    expect(existsSync(resolve(infra, `${provider}TaskRecoveryOperations.ts`))).toBe(false)
  }
})
