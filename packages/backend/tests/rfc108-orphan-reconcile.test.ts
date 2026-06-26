// RFC-108 T17 (AR-10) — periodic post-boot orphan reconciler.
//
// 为什么这条测试存在：boot reaper 只跑一次且乐观翻所有 running；周期 reconciler 在活
// daemon 里只能翻「进程确已消失」的 run，且要躲过刚 spawn 的竞态。本测试用注入 isGone
// 锁定：① 进程消失 + 过 grace → 翻 run + 翻 task + 记 periodic-reap；② grace 内的新 run
// 不碰；③ 进程仍在（isGone=false）不翻；④ 任务还有别的活 run 时不翻 task。

import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { reconcileDeadRunningRuns } from '../src/services/orphanReconcile'
import { listRecoveryEventsForTask, __resetRecoveryCountersForTest } from '../src/services/recovery'

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
    const res = await reconcileDeadRunningRuns({ db, graceMs: 1000, now: NOW, isGone: () => true })
    expect(res.reapedRuns).toEqual([runId])
    expect(res.reapedTasks).toEqual([taskId])
    const t = await db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(t[0]!.status).toBe('interrupted')
    expect(
      (await listRecoveryEventsForTask(db, taskId)).some((e) => e.kind === 'periodic-reap'),
    ).toBe(true)
  })

  test('run within grace is not even a candidate', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    await seedRun(db, taskId, 'running', NOW - 100) // newer than grace 1000
    const res = await reconcileDeadRunningRuns({ db, graceMs: 1000, now: NOW, isGone: () => true })
    expect(res.reapedRuns).toHaveLength(0)
  })

  test('alive run (isGone=false) is left running', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    await seedRun(db, taskId, 'running', NOW - 50_000)
    const res = await reconcileDeadRunningRuns({ db, graceMs: 1000, now: NOW, isGone: () => false })
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
      isGone: (r) => r.id === goneId,
    })
    expect(res.reapedRuns).toEqual([goneId])
    expect(res.reapedTasks).toHaveLength(0) // task kept running (pending run remains)
    const t = await db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(t[0]!.status).toBe('running')
  })
})
