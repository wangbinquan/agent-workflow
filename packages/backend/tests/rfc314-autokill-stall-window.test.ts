// RFC-314 D1 —— autoKill 的「最后一次活动」判据：有界窗口取代全表 max(ts)。
//
// 这条测试为什么存在（2026-08-21 生产量级实测）：`findStalledRunningChildren` 原本是
// `LEFT JOIN node_run_events + max(ts) + GROUP BY`，一条语句要把**每个 running run 的全部
// 事件**走一遍索引求 max，再走 TEMP B-TREE 分组。78.6 万行 / 单 run 最大 10.8 万事件的同形
// 库上实测**单条 194.9ms**——daemon 只有一条同步连接，这 0.2 秒里全站不响应。
//
// 改法是逐 run 按 id 反向取 200 行、窗口内取 max(ts)。两个方向都要锁：
//   ① 窗口内的 ts 乱序（子代理回灌携带 opencode 原始 ts）必须被吸收——**不能**因为最后
//      一行是旧 ts 就把一个活着的进程判成僵死（这个判据的后果是杀进程，不是报告警；
//      `stuckTaskDetector` 只取最后一行是刻意的不同选择，那边只出 alert）；
//   ② 窗口**外**的乱序确实会被低估——这是 proposal §4 B1 明确接受的取舍，用例把它钉住，
//      免得日后有人当 bug「修」成全表 max 又把 194.9ms 请回来。
// 另加两条结构判据（形状退化在小库上永远看不出来）：语句数不随事件量增长；EXPLAIN 不许
// 出现 SCAN 或 TEMP B-TREE。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { findStalledRunningChildren } from '../src/services/autoKill'
import { recordStatements, type RecordedStatement } from './helpers/statementRecorder'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_788_000_000_000
const STALL_MS = 60_000
/** 与 services/autoKill.ts 的 STALL_TS_WINDOW_ROWS 对齐（那边不导出，这里显式复述）。 */
const WINDOW = 200

async function seedRun(
  db: DbClient,
  opts: { startedAt: number; events: Array<{ ts: number }> },
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  const nodeRunId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'wf', definition: '{}' })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc314-fixture',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/r',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: opts.startedAt,
  })
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'n1',
    status: 'running',
    pid: 4242,
    startedAt: opts.startedAt,
  })
  // 逐条插入：id 顺序 == 插入顺序，这正是被测判据依赖的东西。
  for (const e of opts.events) {
    await db.insert(nodeRunEvents).values({ nodeRunId, ts: e.ts, kind: 'text', payload: '{}' })
  }
  return nodeRunId
}

/** 连续 n 条「很旧」的事件，用来把窗口填满。 */
function staleEvents(n: number, ts: number): Array<{ ts: number }> {
  return Array.from({ length: n }, () => ({ ts }))
}

describe('RFC-314 D1 —— 窗口内的 ts 乱序必须被吸收', () => {
  test('窗口里存在一条新 ts（最后一行是回灌的旧 ts）⇒ 不判僵死', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const startedAt = NOW - 10 * STALL_MS
    // 先一条「刚刚才有动静」的事件，随后 50 条子代理回灌的旧 ts —— 最后一行很旧，
    // 但窗口内有活着的证据。
    await seedRun(db, {
      startedAt,
      events: [{ ts: NOW - 1_000 }, ...staleEvents(50, startedAt)],
    })

    const found = await findStalledRunningChildren(db, STALL_MS, NOW)
    expect(found).toHaveLength(0)
  })

  test('整个窗口都很旧 ⇒ 判僵死，并带回窗口内的 max(ts)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const startedAt = NOW - 10 * STALL_MS
    const quietTs = NOW - 5 * STALL_MS
    const id = await seedRun(db, { startedAt, events: staleEvents(10, quietTs) })

    const found = await findStalledRunningChildren(db, STALL_MS, NOW)
    expect(found.map((r) => r.id)).toEqual([id])
    expect(found[0]!.lastTs).toBe(quietTs)
  })

  test('一条事件都没有 ⇒ lastTs 为 null，回落 startedAt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedRun(db, { startedAt: NOW - 10 * STALL_MS, events: [] })

    const found = await findStalledRunningChildren(db, STALL_MS, NOW)
    expect(found.map((r) => r.id)).toEqual([id])
    expect(found[0]!.lastTs).toBeNull()
  })
})

describe('RFC-314 D1 —— 窗口外的乱序会被低估（proposal §4 B1 明确接受的取舍）', () => {
  test('最大 ts 落在窗口之外 ⇒ 判僵死；这是取舍不是 bug', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const startedAt = NOW - 10 * STALL_MS
    // 第一条是「刚才还活着」，其后 WINDOW+50 条回灌旧 ts 把它挤出窗口。
    await seedRun(db, {
      startedAt,
      events: [{ ts: NOW - 1_000 }, ...staleEvents(WINDOW + 50, startedAt)],
    })

    const found = await findStalledRunningChildren(db, STALL_MS, NOW)
    // 全表 max(ts) 会返回空数组（那条新 ts 让它不算僵死）；窗口法看不到它。
    // 判据在这里被钉住：改回全表 max 会让这条转红，改小窗口也会。
    expect(found).toHaveLength(1)
    expect(found[0]!.lastTs).toBe(startedAt)
  })
})

describe('RFC-314 D1 —— 结构判据', () => {
  async function capture(eventsPerRun: number): Promise<{
    statements: RecordedStatement[]
    db: DbClient
  }> {
    const db = createInMemoryDb(MIGRATIONS)
    for (let i = 0; i < 3; i += 1) {
      await seedRun(db, {
        startedAt: NOW - 10 * STALL_MS,
        events: staleEvents(eventsPerRun, NOW - 5 * STALL_MS),
      })
    }
    const raw = (db as unknown as { $client: Parameters<typeof recordStatements>[0] }).$client
    const rec = recordStatements(raw)
    try {
      await findStalledRunningChildren(db, STALL_MS, NOW)
    } finally {
      rec.stop()
    }
    return { statements: rec.statements, db }
  }

  test('语句条数只随 running run 数增长，不随事件量增长', async () => {
    const small = await capture(5)
    const large = await capture(400)
    expect(large.statements.length).toBe(small.statements.length)
    // 1 条候选查询 + 每个 run 一条窗口查询。
    expect(small.statements.length).toBe(4)
  })

  test('每条语句都不扫大表、不临时排序', async () => {
    const { statements, db } = await capture(400)
    const raw = (
      db as unknown as { $client: { prepare(q: string): { all(...a: unknown[]): unknown[] } } }
    ).$client
    for (const stmt of statements) {
      if (!/^\s*select/i.test(stmt.sql)) continue
      const args = Array.from({ length: stmt.params }, () => null)
      const plan = (
        raw.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`).all(...args) as Array<{ detail: string }>
      )
        .map((r) => r.detail)
        .join('\n')
      expect(plan, `计划里出现了裸扫：\n${stmt.sql}\n${plan}`).not.toContain('SCAN node_run_events')
      expect(plan, `计划里出现了临时排序：\n${stmt.sql}\n${plan}`).not.toContain('USE TEMP B-TREE')
    }
  })
})
