// RFC-350 —— 活动口径与候选面的持久化锁（真库，in-memory SQLite）。
//
// 为什么这些测试存在：「最后一次动作」是本功能唯一的输入。少算一个数据源，正在被
// 人推进的任务就会被当成僵尸取消掉；多算一个（比如评论），一个没人管的任务就能被
// 无限续命。所以四类数据源逐个单独立案，另加：
//   - 候选面只含**仍有非终态成员**的树、按最老优先、遵守单拍上限；
//   - 软删除任务整棵树不参与（AC-14）；
//   - 覆盖原因只认「我们取消的那一行」，绝不重绘别人的终态原因；
//   - 审计行落 recovery_events（任务详情页「恢复」区读的就是它）。
//
// 对应 design.md §2.1 / §4 与 proposal.md 的 AC-3 / AC-4 / AC-7 / AC-8 / AC-14。

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import {
  collaborationGateOperations,
  nodeRunEvents,
  nodeRuns,
  recoveryEvents,
  taskRepos,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import { createSqliteTaskIdleTimeoutPersistence } from '../src/modules/task-execution/composition/taskIdleTimeout'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HOUR = 3_600_000
const NOW = 1_788_278_400_000

type Db = ReturnType<typeof createInMemoryDb>

async function seedBase(db: Db): Promise<void> {
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'u1',
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(workflows).values({ id: 'wf1', name: 'wf', definition: '{}' })
}

interface TaskSeed {
  id: string
  status:
    | 'pending'
    | 'running'
    | 'awaiting_human'
    | 'awaiting_review'
    | 'done'
    | 'canceled'
    | 'interrupted'
  startedAt: number
  finishedAt?: number | null
  parentTaskId?: string
  rootTaskId?: string | null
  deletedAt?: number
  errorSummary?: string
}

async function addTask(db: Db, seed: TaskSeed): Promise<void> {
  await db.insert(tasks).values({
    id: seed.id,
    name: seed.id,
    workflowId: 'wf1',
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${seed.id}`,
    status: seed.status,
    inputs: '{}',
    startedAt: seed.startedAt,
    finishedAt: seed.finishedAt ?? null,
    runningMs: 0,
    ownerUserId: 'u1',
    launchOrigin: 'manual',
    parentTaskId: seed.parentTaskId ?? null,
    rootTaskId: seed.rootTaskId === undefined ? (seed.parentTaskId ?? seed.id) : seed.rootTaskId,
    invocationDepth: seed.parentTaskId === undefined ? 0 : 1,
    ...(seed.deletedAt === undefined ? {} : { deletedAt: seed.deletedAt }),
    ...(seed.errorSummary === undefined ? {} : { errorSummary: seed.errorSummary }),
  })
  await db.insert(taskRepos).values({
    taskId: seed.id,
    repoIndex: 0,
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    branch: `agent-workflow/${seed.id}`,
  })
}

async function addRun(
  db: Db,
  input: {
    id: string
    taskId: string
    status: 'running' | 'done'
    startedAt: number
    pid?: number
    eventTs?: readonly number[]
  },
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: input.id,
    taskId: input.taskId,
    nodeId: 'n1',
    status: input.status,
    startedAt: input.startedAt,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    spawnBinaryPath: '/usr/local/bin/opencode',
    spawnLaunchNonce: 'nonce',
  })
  for (const ts of input.eventTs ?? []) {
    await db.insert(nodeRunEvents).values({ nodeRunId: input.id, ts, kind: 'text', payload: 'x' })
  }
}

async function addGateDecision(
  db: Db,
  input: { taskId: string; committedAt: number | null; operationKind?: 'decide' | 'open' },
): Promise<void> {
  await db.insert(collaborationGateOperations).values({
    id: `gate-${input.taskId}-${input.committedAt ?? 'null'}-${input.operationKind ?? 'decide'}`,
    taskId: input.taskId,
    gateKind: 'review',
    operationKind: input.operationKind ?? 'decide',
    gateRef: `ref-${input.taskId}-${input.committedAt ?? 'null'}`,
    idempotencyKey: `idem-${input.taskId}-${input.committedAt ?? 'null'}-${input.operationKind ?? 'decide'}`,
    requestHash: 'hash',
    expectedTaskRevision: 1,
    expectedGateRevision: 1,
    state: input.committedAt === null ? 'preparing' : 'committed',
    createdAt: NOW - 100 * HOUR,
    updatedAt: NOW,
    committedAt: input.committedAt,
    // committedShape CHECK：committed 行必须同时有 resultGateRevision(=expected+1)
    // 与 receiptJson。
    ...(input.committedAt === null ? {} : { resultGateRevision: 2, receiptJson: '{}' }),
  })
}

function activityOf(
  snapshot: { members: readonly { taskId: string; activityAt: number }[] } | null,
  taskId: string,
): number {
  const member = snapshot?.members.find((m) => m.taskId === taskId)
  expect(member, `task ${taskId} missing from tree snapshot`).toBeDefined()
  return member?.activityAt ?? -1
}

describe('RFC-350 活动口径（四类数据源）', () => {
  test('无任何 run / 决策时，活动时刻就是 started_at（新建任务不会被立刻收）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 'solo', status: 'pending', startedAt: NOW - 3 * HOUR })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    expect(activityOf(await p.loadTreeActivity('solo'), 'solo')).toBe(NOW - 3 * HOUR)
  })

  test('agent 事件推进活动时刻', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 't', status: 'running', startedAt: NOW - 50 * HOUR })
    await addRun(db, {
      id: 'r1',
      taskId: 't',
      status: 'running',
      startedAt: NOW - 50 * HOUR,
      eventTs: [NOW - 49 * HOUR, NOW - 5 * HOUR],
    })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    expect(activityOf(await p.loadTreeActivity('t'), 't')).toBe(NOW - 5 * HOUR)
  })

  test('新铸的 node_run 即使一个事件都没产出也算动作（手动 resume / retry）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 't', status: 'running', startedAt: NOW - 50 * HOUR })
    await addRun(db, { id: 'r1', taskId: 't', status: 'running', startedAt: NOW - 2 * HOUR })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    expect(activityOf(await p.loadTreeActivity('t'), 't')).toBe(NOW - 2 * HOUR)
  })

  test('人类推进动作（已提交的 gate decide）算动作', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 't', status: 'awaiting_review', startedAt: NOW - 50 * HOUR })
    await addGateDecision(db, { taskId: 't', committedAt: NOW - 4 * HOUR })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    expect(activityOf(await p.loadTreeActivity('t'), 't')).toBe(NOW - 4 * HOUR)
  })

  test('未提交的决策尝试与 open 不算「推进」', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 't', status: 'awaiting_review', startedAt: NOW - 50 * HOUR })
    await addGateDecision(db, { taskId: 't', committedAt: null })
    await addGateDecision(db, { taskId: 't', committedAt: NOW - 1 * HOUR, operationKind: 'open' })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    expect(activityOf(await p.loadTreeActivity('t'), 't')).toBe(NOW - 50 * HOUR)
  })

  test('已终态成员用 finished_at（不再逐 run 查事件）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 'root', status: 'running', startedAt: NOW - 90 * HOUR })
    await addTask(db, {
      id: 'child',
      status: 'done',
      startedAt: NOW - 90 * HOUR,
      finishedAt: NOW - 30 * HOUR,
      parentTaskId: 'root',
    })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    const snapshot = await p.loadTreeActivity('root')
    expect(activityOf(snapshot, 'child')).toBe(NOW - 30 * HOUR)
    expect(snapshot?.members).toHaveLength(2)
  })

  test('liveRuns 只含非终态 run，并带齐进程身份四元组', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 't', status: 'running', startedAt: NOW - 50 * HOUR })
    await addRun(db, {
      id: 'live',
      taskId: 't',
      status: 'running',
      startedAt: NOW - 50 * HOUR,
      pid: 99,
    })
    await addRun(db, { id: 'settled', taskId: 't', status: 'done', startedAt: NOW - 50 * HOUR })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    const snapshot = await p.loadTreeActivity('t')
    expect(snapshot?.liveRuns.map((r) => r.nodeRunId)).toEqual(['live'])
    expect(snapshot?.liveRuns[0]).toMatchObject({
      taskId: 't',
      pid: 99,
      spawnBinaryPath: '/usr/local/bin/opencode',
      spawnLaunchNonce: 'nonce',
    })
  })
})

describe('RFC-350 候选面', () => {
  test('只返回仍有非终态成员的树根，且整棵树只算一次', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 'live-root', status: 'running', startedAt: NOW - 50 * HOUR })
    await addTask(db, {
      id: 'live-child',
      status: 'pending',
      startedAt: NOW - 49 * HOUR,
      parentTaskId: 'live-root',
      rootTaskId: 'live-root',
    })
    await addTask(db, {
      id: 'settled',
      status: 'done',
      startedAt: NOW - 60 * HOUR,
      finishedAt: NOW - 59 * HOUR,
    })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    expect(await p.listIdleCandidateRoots(10)).toEqual(['live-root'])
  })

  test('软删除任务不进候选，其整棵树也不出快照（AC-14）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, {
      id: 'gone',
      status: 'running',
      startedAt: NOW - 50 * HOUR,
      deletedAt: NOW - 1 * HOUR,
    })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    expect(await p.listIdleCandidateRoots(10)).toEqual([])
    expect(await p.loadTreeActivity('gone')).toBeNull()
  })

  test('最老的活任务优先，并遵守单拍上限', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 'newest', status: 'running', startedAt: NOW - 10 * HOUR })
    await addTask(db, { id: 'oldest', status: 'running', startedAt: NOW - 90 * HOUR })
    await addTask(db, { id: 'middle', status: 'running', startedAt: NOW - 50 * HOUR })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    expect(await p.listIdleCandidateRoots(2)).toEqual(['oldest', 'middle'])
    expect(await p.listIdleCandidateRoots(0)).toEqual([])
  })

  test('legacy 行（root_task_id 为 NULL）沿父链上溯到真正的根', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, {
      id: 'legacy-root',
      status: 'done',
      startedAt: NOW - 90 * HOUR,
      finishedAt: NOW - 89 * HOUR,
      rootTaskId: null,
    })
    await addTask(db, {
      id: 'legacy-child',
      status: 'running',
      startedAt: NOW - 88 * HOUR,
      parentTaskId: 'legacy-root',
      rootTaskId: null,
    })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    expect(await p.listIdleCandidateRoots(10)).toEqual(['legacy-root'])
    const snapshot = await p.loadTreeActivity('legacy-root')
    expect(snapshot?.members.map((m) => m.taskId).sort()).toEqual(['legacy-child', 'legacy-root'])
  })
})

describe('RFC-350 收割写入', () => {
  test('原因文案只覆盖「我们取消的那一行」', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    // 本次收割取消的行：cancelTask 写的默认 summary。
    await addTask(db, {
      id: 'ours',
      status: 'canceled',
      startedAt: NOW - 90 * HOUR,
      finishedAt: NOW,
      errorSummary: 'canceled by user',
    })
    // 竞态里被别的终态写手抢先的行：保留它自己的真实原因。
    await addTask(db, {
      id: 'theirs',
      status: 'canceled',
      startedAt: NOW - 90 * HOUR,
      finishedAt: NOW,
      errorSummary: 'task-time-limit-exceeded',
    })
    // 根本没被取消的行。
    await addTask(db, { id: 'running', status: 'running', startedAt: NOW - 90 * HOUR })

    const p = createSqliteTaskIdleTimeoutPersistence(db)
    for (const taskId of ['ours', 'theirs', 'running']) {
      await p.writeIdleTimeoutReason({
        taskId,
        summary: 'task-idle-timeout',
        message: 'no activity',
      })
    }
    const rows = await db.select({ id: tasks.id, errorSummary: tasks.errorSummary }).from(tasks)
    const byId = new Map(rows.map((r) => [r.id, r.errorSummary]))
    expect(byId.get('ours')).toBe('task-idle-timeout')
    expect(byId.get('theirs')).toBe('task-time-limit-exceeded')
    expect(byId.get('running')).toBeNull()
  })

  test('审计落 recovery_events，kind = idle-timeout-reap（详情页「恢复」区读的就是它）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await addTask(db, { id: 't', status: 'canceled', startedAt: NOW - 90 * HOUR, finishedAt: NOW })
    const p = createSqliteTaskIdleTimeoutPersistence(db)
    await p.recordReapAudit({
      taskId: 't',
      reason: 'no activity for 108000000ms',
      silentMs: 30 * HOUR,
      thresholdMs: 24 * HOUR,
      killOutcomes: { 'window-expired': 2 },
      now: NOW,
    })
    const rows = await db.select().from(recoveryEvents).where(eq(recoveryEvents.taskId, 't'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('idle-timeout-reap')
    expect(rows[0]?.actor).toBe('system')
    expect(JSON.parse(rows[0]?.beforeJson ?? '{}')).toEqual({
      silentMs: 30 * HOUR,
      thresholdMs: 24 * HOUR,
    })
    expect(JSON.parse(rows[0]?.afterJson ?? '{}')).toEqual({
      status: 'canceled',
      killOutcomes: { 'window-expired': 2 },
    })
  })
})
