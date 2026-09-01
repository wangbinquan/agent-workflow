// RFC-108 T20 (AR-05a) — heartbeat stalled-child auto-kill (default OFF).
//
// 为什么这条测试存在：heartbeat-kill 一旦开启，只能杀「事件静默超阈值」的活子进程、且穿
// 全部护栏，绝不碰其它任务/已隔离任务。本测试：① 注入 find/kill 锁定 loop（enabled+killed
// → 记 heartbeat-kill 事件；disabled → no-op；隔离 → 跳；kill 非 'killed' → 跳）；
// ② findStalledRunningChildren 真查询（running+pid+静默 → 命中；近期/非 running/无 pid → 排除）。

import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  findStalledRunningChildren,
  runHeartbeatKillOnce,
  type StalledRun,
} from '../src/services/autoKill'
import { __clearDriverLeasesForTest } from '../src/services/driverLease'
import { listRecoveryEventsForTask, __resetRecoveryCountersForTest } from '../src/services/recovery'
import { recordAutoRecoveryAttempt } from '../src/services/recoveryBreaker'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BREAKER = { maxPerWindow: 3, windowMs: 60 * 60 * 1000 }

afterEach(() => {
  __clearDriverLeasesForTest()
  __resetRecoveryCountersForTest()
})

async function seedTask(db: DbClient): Promise<string> {
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
    startedAt: Date.now(),
  })
  return taskId
}

function stalled(taskId: string, id = ulid()): StalledRun {
  return { id, taskId, pid: 4242, startedAt: 1000, spawnBinaryPath: '/x/opencode', lastTs: 1000 }
}

describe('RFC-108 T20 — heartbeat-kill loop', () => {
  test('enabled + stalled + killed → killed list + records heartbeat-kill event', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const run = stalled(taskId)
    const operations = taskRecoveryOperations(db)
    const res = await runHeartbeatKillOnce({
      operations,
      enabled: true,
      breaker: BREAKER,
      findStalledRuns: async () => [run],
      killChild: async () => 'killed',
    })
    expect(res.killed).toEqual([{ taskId, nodeRunId: run.id }])
    expect(
      (await listRecoveryEventsForTask(operations, taskId)).some(
        (e) => e.kind === 'heartbeat-kill',
      ),
    ).toBe(true)
  })

  test('disabled → no-op (never queries or kills)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const operations = taskRecoveryOperations(db)
    let queried = false
    const res = await runHeartbeatKillOnce({
      operations,
      enabled: false,
      breaker: BREAKER,
      findStalledRuns: async () => {
        queried = true
        return []
      },
      killChild: async () => 'killed',
    })
    expect(res.killed).toHaveLength(0)
    expect(queried).toBe(false)
  })

  test('quarantined task → skipped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const operations = taskRecoveryOperations(db)
    for (let i = 0; i < 4; i++) {
      await recordAutoRecoveryAttempt(operations, taskId, BREAKER, 1000)
    }
    const res = await runHeartbeatKillOnce({
      operations,
      enabled: true,
      breaker: BREAKER,
      findStalledRuns: async () => [stalled(taskId)],
      killChild: async () => 'killed',
    })
    expect(res.killed).toHaveLength(0)
    expect(res.skipped[0]!.reason).toBe('quarantined')
  })

  test('kill outcome other than killed → skipped (window-expired / command-mismatch)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const operations = taskRecoveryOperations(db)
    const res = await runHeartbeatKillOnce({
      operations,
      enabled: true,
      breaker: BREAKER,
      findStalledRuns: async () => [stalled(taskId)],
      killChild: async () => 'window-expired',
    })
    expect(res.killed).toHaveLength(0)
    expect(res.skipped[0]!.reason).toContain('not-killed')
  })
})

describe('RFC-108 T20 — findStalledRunningChildren query', () => {
  async function seedRun(
    db: DbClient,
    taskId: string,
    opts: { status: string; pid: number | null; startedAt: number | null },
  ): Promise<string> {
    const id = ulid()
    await db.insert(nodeRuns).values({
      id,
      taskId,
      nodeId: 'n1',
      status: opts.status as 'running',
      pid: opts.pid,
      startedAt: opts.startedAt,
    })
    return id
  }

  test('returns running+pid+silent runs; excludes recent / non-running / no-pid', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const now = 1_000_000
    const stallMs = 1000
    const silent = await seedRun(db, taskId, { status: 'running', pid: 111, startedAt: now - 5000 }) // 5000>1000 → stale
    await seedRun(db, taskId, { status: 'running', pid: 222, startedAt: now - 100 }) // recent → excluded
    await seedRun(db, taskId, { status: 'done', pid: 333, startedAt: now - 5000 }) // not running → excluded
    await seedRun(db, taskId, { status: 'running', pid: null, startedAt: now - 5000 }) // no pid → excluded

    const found = await findStalledRunningChildren(taskRecoveryOperations(db), stallMs, now)
    expect(found.map((r) => r.id)).toEqual([silent])
  })
})
