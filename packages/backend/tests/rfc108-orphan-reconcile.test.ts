// RFC-108 T17 (AR-10) — periodic post-boot orphan reconciler.
//
// 为什么这条测试存在：boot reaper 只跑一次且乐观翻所有 running；周期 reconciler 在活
// daemon 里只能翻「活性证据链确已断裂」的 run，且要躲过刚 spawn 的竞态。本测试用注入
// 探针锁定编排逻辑：① 进程消失 + 过 grace → 翻 run + 翻 task + 记 periodic-reap；
// ② grace 内的新 run 不碰；③ 进程仍在不翻；④ 任务还有别的活 run 时不翻 task。
//
// RFC-230：注入点从「isGone(run)」收缩为「probeProcessAlive(pid, binary)」——旧签名让
// 判活口径（pid===null ⇒ 已消失）永远走不到真实代码，正是那次 wrapper 误收事故的测试
// 盲区。判活语义本身由 rfc230-run-liveness.test.ts 直测真函数。

import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, runtimeSessionLeases, tasks, workflows } from '../src/db/schema'
import { reconcileDeadRunningRuns } from '../src/services/orphanReconcile'
import { listRecoveryEventsForTask, __resetRecoveryCountersForTest } from '../src/services/recovery'
import {
  claimNewRuntimeSession,
  markRuntimeSessionResetPending,
} from '../src/services/runtimeSessionLease'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_000_000

afterEach(() => __resetRecoveryCountersForTest())

async function seedRunningTask(db: DbClient): Promise<string> {
  const wfId = ulid()
  const taskId = ulid()
  const def = { $schema_version: 1, inputs: [], nodes: [], edges: [] }
  await db.insert(workflows).values({ id: wfId, name: 'w', definition: JSON.stringify(def) })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW - 100_000,
  })
  return taskId
}

async function seedRun(
  db: DbClient,
  taskId: string,
  status: string,
  startedAt: number | null,
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n1',
    status: status as 'running',
    pid: 999,
    startedAt,
  })
  return id
}

describe('RFC-108 T17 — reconcileDeadRunningRuns', () => {
  test('gone run past grace → reaps run + task + records periodic-reap', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    const runId = await seedRun(db, taskId, 'running', NOW - 50_000) // older than grace
    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: () => false,
    })
    expect(res.reapedRuns).toEqual([runId])
    expect(res.reapedTasks).toEqual([taskId])
    const t = await db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(t[0]!.status).toBe('interrupted')
    expect(
      (await listRecoveryEventsForTask(db, taskId)).some((e) => e.kind === 'periodic-reap'),
    ).toBe(true)
  })

  test('periodic reap deletes a reset-pending native lease instead of leaking it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    const runId = await seedRun(db, taskId, 'running', NOW - 50_000)
    const lease = claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'periodic-reset-old',
      taskId,
      nodeId: 'n1',
      currentNodeRunId: runId,
      leaseNonceDigest: 'periodic-reset-nonce',
      leasedAt: NOW - 40_000,
    })
    expect(markRuntimeSessionResetPending(db, lease)).toBe(true)

    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: () => false,
      reapHeldNativeSessionProcess: async () => 'not-alive',
    })

    expect(res.reapedRuns).toEqual([runId])
    expect(
      db
        .select()
        .from(runtimeSessionLeases)
        .where(eq(runtimeSessionLeases.sessionId, 'periodic-reset-old'))
        .get(),
    ).toBeUndefined()
  })

  test('periodic reap keeps a held native lease when a missing PID leaves child reap unproven', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    const runId = await seedRun(db, taskId, 'running', NOW - 50_000)
    db.update(nodeRuns).set({ pid: null }).where(eq(nodeRuns.id, runId)).run()
    claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'periodic-unproven-native',
      taskId,
      nodeId: 'n1',
      currentNodeRunId: runId,
      leaseNonceDigest: 'periodic-unproven-nonce',
    })

    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: () => false,
      reapHeldNativeSessionProcess: async () => 'no-pid',
    })

    expect(res.reapedRuns).toEqual([])
    expect(res.reapedTasks).toEqual([])
    expect(
      db.select({ status: nodeRuns.status }).from(nodeRuns).where(eq(nodeRuns.id, runId)).get(),
    ).toEqual({ status: 'running' })
    expect(
      db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get(),
    ).toEqual({ status: 'running' })
    expect(
      db
        .select({ holder: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(eq(runtimeSessionLeases.sessionId, 'periodic-unproven-native'))
        .get(),
    ).toEqual({ holder: runId })
  })

  test('periodic reap keeps a held native lease when a live PID has a command mismatch', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    const runId = await seedRun(db, taskId, 'running', NOW - 50_000)
    claimNewRuntimeSession(db, {
      protocol: 'claude-code',
      sessionId: 'periodic-command-mismatch-native',
      taskId,
      nodeId: 'n1',
      currentNodeRunId: runId,
      leaseNonceDigest: 'periodic-command-mismatch-nonce',
    })

    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      // The coarse probe cannot tell a dead process from a recycled/live PID
      // whose command no longer matches the recorded binary.
      probeProcessAlive: () => false,
      reapHeldNativeSessionProcess: async () => 'command-mismatch',
    })

    expect(res.reapedRuns).toEqual([])
    expect(res.reapedTasks).toEqual([])
    expect(
      db.select({ status: nodeRuns.status }).from(nodeRuns).where(eq(nodeRuns.id, runId)).get(),
    ).toEqual({ status: 'running' })
    expect(
      db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get(),
    ).toEqual({ status: 'running' })
    expect(
      db
        .select({ holder: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(eq(runtimeSessionLeases.sessionId, 'periodic-command-mismatch-native'))
        .get(),
    ).toEqual({ holder: runId })
  })

  test('run within grace is not even a candidate', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    await seedRun(db, taskId, 'running', NOW - 100) // newer than grace 1000
    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: () => false,
    })
    expect(res.reapedRuns).toHaveLength(0)
  })

  test('alive run (probe says alive) is left running', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    await seedRun(db, taskId, 'running', NOW - 50_000)
    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: () => true,
    })
    expect(res.reapedRuns).toHaveLength(0)
    expect(res.reapedTasks).toHaveLength(0)
  })

  test('task with another active run is not flipped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    const goneId = await seedRun(db, taskId, 'running', NOW - 50_000)
    await seedRun(db, taskId, 'pending', NOW - 50_000) // still active
    const res = await reconcileDeadRunningRuns({
      db,
      graceMs: 1000,
      now: NOW,
      probeProcessAlive: () => false,
    })
    expect(res.reapedRuns).toEqual([goneId])
    expect(res.reapedTasks).toHaveLength(0) // task kept running (pending run remains)
    const t = await db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(t[0]!.status).toBe('running')
  })
})
