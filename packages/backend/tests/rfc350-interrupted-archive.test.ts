// RFC-350 —— `interrupted` 任务树必须能被归档出库（回归防护）。
//
// 为什么这条测试存在：`shared/lifecycle.ts` 的 `TERMINAL_TASK_STATUSES` 含
// `interrupted`，orphan reaper 把 daemon 重启时在跑的任务翻成它**并写了 finished_at**；
// 而 `services/taskArchive.ts` 的归档器自己抄了一份三元素 `TERMINAL`（done / failed /
// canceled），漏掉了它。两处对「终态」的定义不一致，后果是每次 daemon 重启残留的那批
// 任务既不能被取消（cancel 事件的 allowed-from 不含 interrupted），又永远等不到归档——
// 它们是库里唯一一类永久居民，而且恰恰是最典型的僵尸。
//
// 把 TERMINAL 改回引用 shared 的单一事实源之前，本文件第一条用例是**红**的。
// 任何把它改回手抄字面量的重构会立刻让它再红一次。
//
// 对应 proposal.md AC-11 与能力影响清单 I-4（用户 2026-09-02 逐项确认）。

import { describe, expect, test } from 'bun:test'
import { count } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { taskRepos, tasks, users, workflows } from '../src/db/schema'
import { runTaskArchiveSweep } from '../src/services/taskArchive'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAY = 86_400_000
const NOW = 1_788_278_400_000

type Db = ReturnType<typeof createInMemoryDb>

function tmpDirs(): { archiveDir: string; runsDir: string; logsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc350-archive-'))
  const dirs = {
    archiveDir: join(root, 'archive', 'tasks'),
    runsDir: join(root, 'runs'),
    logsDir: join(root, 'logs'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return dirs
}

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

async function addTask(
  db: Db,
  seed: {
    id: string
    status: 'done' | 'canceled' | 'interrupted' | 'running'
    finishedAt: number | null
    parentTaskId?: string
  },
): Promise<void> {
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
    startedAt: NOW - 200 * DAY,
    finishedAt: seed.finishedAt,
    runningMs: 0,
    ownerUserId: 'u1',
    launchOrigin: 'manual',
    parentTaskId: seed.parentTaskId ?? null,
    rootTaskId: seed.parentTaskId ?? seed.id,
    invocationDepth: seed.parentTaskId === undefined ? 0 : 1,
  })
  await db.insert(taskRepos).values({
    taskId: seed.id,
    repoIndex: 0,
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    branch: `agent-workflow/${seed.id}`,
  })
}

async function taskCount(db: Db): Promise<number> {
  const rows = await db.select({ n: count() }).from(tasks)
  return rows[0]?.n ?? 0
}

describe('RFC-350 —— interrupted 树进入归档面', () => {
  test('T-15 全 interrupted 的树过了保留期会被归档出库（此前永远不会）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    await addTask(db, { id: 'orphaned', status: 'interrupted', finishedAt: NOW - 300 * DAY })

    const result = await runTaskArchiveSweep(
      db,
      { enabled: true, retentionDays: 90 },
      { ...dirs, now: NOW },
    )
    expect(result.archived.map((tree) => tree.rootTaskId)).toEqual(['orphaned'])
    expect(await taskCount(db)).toBe(0)
    expect(readdirSync(dirs.archiveDir)).toEqual(['orphaned'])
  })

  test('T-16 还在保留期内的 interrupted 树不动', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    await addTask(db, { id: 'recent', status: 'interrupted', finishedAt: NOW - 10 * DAY })

    const result = await runTaskArchiveSweep(
      db,
      { enabled: true, retentionDays: 90 },
      { ...dirs, now: NOW },
    )
    expect(result.archived).toHaveLength(0)
    expect(await taskCount(db)).toBe(1)
    expect(readdirSync(dirs.archiveDir)).toEqual([])
  })

  test('T-17 混合树按 max(finished_at) 判保留期，且非终态成员仍然挡住整棵树', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    // 树 A：canceled 根 + interrupted 子，最近完成时间仍在保留期内 ⇒ 不动。
    await addTask(db, { id: 'a-root', status: 'canceled', finishedAt: NOW - 300 * DAY })
    await addTask(db, {
      id: 'a-child',
      status: 'interrupted',
      finishedAt: NOW - 10 * DAY,
      parentTaskId: 'a-root',
    })
    // 树 B：interrupted 根 + 仍在跑的子 ⇒ 非终态成员挡住整棵树。
    await addTask(db, { id: 'b-root', status: 'interrupted', finishedAt: NOW - 300 * DAY })
    await addTask(db, {
      id: 'b-child',
      status: 'running',
      finishedAt: null,
      parentTaskId: 'b-root',
    })
    // 树 C：全 interrupted 且都超期 ⇒ 出库。
    await addTask(db, { id: 'c-root', status: 'interrupted', finishedAt: NOW - 300 * DAY })
    await addTask(db, {
      id: 'c-child',
      status: 'interrupted',
      finishedAt: NOW - 299 * DAY,
      parentTaskId: 'c-root',
    })

    const result = await runTaskArchiveSweep(
      db,
      { enabled: true, retentionDays: 90 },
      { ...dirs, now: NOW },
    )
    expect(result.archived.map((tree) => tree.rootTaskId)).toEqual(['c-root'])
    expect(await taskCount(db)).toBe(4)
  })

  test('默认关闭时 interrupted 树同样一行不动（新面不改变默认行为）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dirs = tmpDirs()
    await seedBase(db)
    await addTask(db, { id: 'orphaned', status: 'interrupted', finishedAt: NOW - 300 * DAY })

    const result = await runTaskArchiveSweep(
      db,
      { enabled: false, retentionDays: 90 },
      { ...dirs, now: NOW },
    )
    expect(result.archived).toHaveLength(0)
    expect(await taskCount(db)).toBe(1)
  })
})
