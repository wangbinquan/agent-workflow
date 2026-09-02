// RFC-350 —— 端到端：真库 + 真 cancelTask + 真归档器，把「超时 → 终结 → 出库」
// 这条链整条跑一遍。
//
// 上游的纯函数与编排各自有单测；这里锁的是接线本身，也就是那些只有把真组件接到
// 一起才会暴露的东西：
//   - 收割真的把树内非终态任务写成 canceled，并覆盖成本功能的原因文案（AC-2/AC-7）；
//   - 恢复审计真的落进 recovery_events，任务详情页「恢复」区读得到（AC-8）；
//   - 收割后的任务作为普通终态任务被既有归档按 retentionDays 出库（AC-9）；
//   - 只开收割不开归档 ⇒ 只终结、不出库、仍可查看（AC-10）；
//   - 软删除任务一根汗毛都不碰（AC-14）。
//
// 进程终止在这里注入成桩：真去 kill 一个 pid 属于 util/process 的职责（它自己有
// PID 复用窗口与身份门的测试），本文件要证的是收割链，不是信号。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { cancelTask } from '../src/services/task'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, recoveryEvents, taskRepos, tasks, users, workflows } from '../src/db/schema'
import {
  composeTaskIdleTimeoutOperations,
  createSqliteTaskIdleTimeoutPersistence,
  runTaskIdleTimeoutSweep,
} from '../src/modules/task-execution/composition/taskIdleTimeout'
import { runTaskArchiveSweep } from '../src/services/taskArchive'
import { installTaskLifecycleAfterCommitTestPump } from './helpers/taskLifecycleCommittedEvents'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HOUR = 3_600_000
const DAY = 86_400_000
const NOW = 1_788_278_400_000
const IDLE_CONFIG = { enabled: true, idleHours: 24 }

type Db = ReturnType<typeof createInMemoryDb>

let db: Db
let uninstall: (() => void) | undefined

function tmpDirs(): { archiveDir: string; runsDir: string; logsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc350-e2e-'))
  const dirs = {
    archiveDir: join(root, 'archive', 'tasks'),
    runsDir: join(root, 'runs'),
    logsDir: join(root, 'logs'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return dirs
}

async function seedBase(): Promise<void> {
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

async function seedTask(seed: {
  id: string
  status: 'running' | 'pending' | 'awaiting_human'
  startedAt: number
  parentTaskId?: string
  deletedAt?: number
}): Promise<void> {
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
    runningMs: 0,
    ownerUserId: 'u1',
    launchOrigin: 'manual',
    parentTaskId: seed.parentTaskId ?? null,
    rootTaskId: seed.parentTaskId ?? seed.id,
    invocationDepth: seed.parentTaskId === undefined ? 0 : 1,
    ...(seed.deletedAt === undefined ? {} : { deletedAt: seed.deletedAt }),
  })
  await db.insert(taskRepos).values({
    taskId: seed.id,
    repoIndex: 0,
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    branch: `agent-workflow/${seed.id}`,
  })
}

async function seedRun(taskId: string, id: string, startedAt: number): Promise<void> {
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n1',
    status: 'running',
    startedAt,
    pid: 4242,
    spawnBinaryPath: '/usr/local/bin/opencode',
    spawnLaunchNonce: 'nonce',
  })
}

const killed: string[] = []

function operations() {
  return composeTaskIdleTimeoutOperations({
    persistence: createSqliteTaskIdleTimeoutPersistence(db),
    cancelTask: async (taskId: string) => {
      await cancelTask(db, taskId)
    },
    // 桩：不真发信号，只记录被要求终止的 run。
    async killRunProcessTree(run) {
      killed.push(run.nodeRunId)
      return 'not-alive'
    },
  })
}

async function statusOf(taskId: string): Promise<{
  status: string
  errorSummary: string | null
  errorMessage: string | null
  finishedAt: number | null
} | null> {
  const rows = await db
    .select({
      status: tasks.status,
      errorSummary: tasks.errorSummary,
      errorMessage: tasks.errorMessage,
      finishedAt: tasks.finishedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
  return rows[0] ?? null
}

async function taskCount(): Promise<number> {
  const rows = await db.select({ n: count() }).from(tasks)
  return rows[0]?.n ?? 0
}

beforeEach(() => {
  killed.length = 0
  db = createInMemoryDb(MIGRATIONS)
  uninstall = installTaskLifecycleAfterCommitTestPump(db, {})
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
})

describe('RFC-350 端到端', () => {
  test('AC-2 / AC-5 / AC-7 / AC-8：整树静默超阈值 ⇒ 杀进程、判 canceled、写原因与审计', async () => {
    await seedBase()
    await seedTask({ id: 'root', status: 'running', startedAt: NOW - 40 * HOUR })
    await seedTask({
      id: 'child',
      status: 'awaiting_human',
      startedAt: NOW - 39 * HOUR,
      parentTaskId: 'root',
    })
    await seedRun('root', 'root-run', NOW - 40 * HOUR)

    const result = await runTaskIdleTimeoutSweep(operations(), IDLE_CONFIG, { now: NOW })
    expect(result).toMatchObject({ reapedTrees: 1, skipped: 0 })
    expect(killed).toEqual(['root-run'])

    for (const taskId of ['root', 'child']) {
      const row = await statusOf(taskId)
      expect(row?.status, `${taskId} 应被收割`).toBe('canceled')
      expect(row?.errorSummary).toBe('task-idle-timeout')
      expect(row?.errorMessage).toContain('idle timeout')
      expect(row?.finishedAt).not.toBeNull()
    }

    const audits = await db
      .select({ taskId: recoveryEvents.taskId, kind: recoveryEvents.kind })
      .from(recoveryEvents)
      .where(eq(recoveryEvents.kind, 'idle-timeout-reap'))
    expect(audits.map((a) => a.taskId).sort()).toEqual(['child', 'root'])
  })

  test('AC-3：树内有新鲜动作 ⇒ 一行都不动', async () => {
    await seedBase()
    await seedTask({ id: 'root', status: 'running', startedAt: NOW - 40 * HOUR })
    await seedTask({
      id: 'child',
      status: 'running',
      startedAt: NOW - 39 * HOUR,
      parentTaskId: 'root',
    })
    // 子任务 1 小时前刚起了一条新 run ⇒ 整棵树算活着。
    await seedRun('child', 'fresh-run', NOW - 1 * HOUR)

    const result = await runTaskIdleTimeoutSweep(operations(), IDLE_CONFIG, { now: NOW })
    expect(result.reapedTrees).toBe(0)
    expect((await statusOf('root'))?.status).toBe('running')
    expect((await statusOf('child'))?.status).toBe('running')
    expect(killed).toEqual([])
  })

  test('AC-9：收割后的任务作为普通终态任务被既有归档按保留期出库', async () => {
    await seedBase()
    await seedTask({ id: 'root', status: 'running', startedAt: NOW - 40 * HOUR })
    await runTaskIdleTimeoutSweep(operations(), IDLE_CONFIG, { now: NOW })
    expect((await statusOf('root'))?.status).toBe('canceled')

    const dirs = tmpDirs()
    // 保留期内不动。
    expect(
      (
        await runTaskArchiveSweep(
          db,
          { enabled: true, retentionDays: 90 },
          { ...dirs, now: NOW + 10 * DAY },
        )
      ).archived,
    ).toHaveLength(0)
    expect(await taskCount()).toBe(1)

    // 跨过保留期 ⇒ 出库并从库里删除。
    const archived = await runTaskArchiveSweep(
      db,
      { enabled: true, retentionDays: 90 },
      { ...dirs, now: NOW + 91 * DAY },
    )
    expect(archived.archived.map((tree) => tree.rootTaskId)).toEqual(['root'])
    expect(await taskCount()).toBe(0)
    expect(readdirSync(dirs.archiveDir)).toEqual(['root'])
  })

  test('AC-10：只开收割、不开归档 ⇒ 只终结，不出库，仍可查看', async () => {
    await seedBase()
    await seedTask({ id: 'root', status: 'running', startedAt: NOW - 40 * HOUR })
    await runTaskIdleTimeoutSweep(operations(), IDLE_CONFIG, { now: NOW })

    const dirs = tmpDirs()
    const archived = await runTaskArchiveSweep(
      db,
      { enabled: false, retentionDays: 90 },
      { ...dirs, now: NOW + 999 * DAY },
    )
    expect(archived.archived).toHaveLength(0)
    expect(await taskCount()).toBe(1)
    expect((await statusOf('root'))?.status).toBe('canceled')
    expect(readdirSync(dirs.archiveDir)).toEqual([])
  })

  test('AC-1：默认关闭 ⇒ 任务原样不动', async () => {
    await seedBase()
    await seedTask({ id: 'root', status: 'running', startedAt: NOW - 400 * HOUR })
    const result = await runTaskIdleTimeoutSweep(
      operations(),
      { enabled: false, idleHours: 24 },
      { now: NOW },
    )
    expect(result.reapedTrees).toBe(0)
    expect((await statusOf('root'))?.status).toBe('running')
  })

  test('AC-14：软删除任务不被收割', async () => {
    await seedBase()
    await seedTask({
      id: 'gone',
      status: 'running',
      startedAt: NOW - 400 * HOUR,
      deletedAt: NOW - 1 * HOUR,
    })
    const result = await runTaskIdleTimeoutSweep(operations(), IDLE_CONFIG, { now: NOW })
    expect(result).toMatchObject({ scanned: 0, reapedTrees: 0 })
    expect((await statusOf('gone'))?.status).toBe('running')
  })
})
