// RFC-314 D2 —— 会话树两段窗口的取法：按 id 取、逐 node_run 查。
//
// 这条测试为什么存在（2026-08-21 生产量级实测）：两段窗口原本是 `ORDER BY ts`，与索引
// `idx_events_node (node_run_id, id)` 不匹配 ⇒ `USE TEMP B-TREE FOR ORDER BY`：为了挑出
// 最新 2 万条，SQLite 先把该 run 的**全部**事件连 payload 灌进排序器。单 run 10.8 万事件
// 的同形库上实测 **461.5ms + 122.0ms 两条**（daemon 只有一条同步连接）。
//
// 改法两半，缺一不可：
//   ① 窗口按 `id` 取 —— 排序器消失（输出顺序不变：取回后那次 (ts,id) 排序本来就在）；
//   ② **逐 node_run** 查询 —— 只换排序键不够：`node_run_id IN (?,?,?)` 之后 SQLite 无法
//      沿单一索引顺序产出全局有序结果，EXPLAIN 实测照样 TEMP B-TREE。
//
// 随之而来的语义差异（proposal §4 B2，本文件逐条钉住）：窗口成员从「全局最早/最新 N 条」
// 变成「每个 run 最早/最新 N 条」，且在 ts/id 乱序时按 id 划线。定根用的 prefix 按 id 取
// 反而更贴合用途——root 会话的事件本就是最先写入的那批。
//
// 根不退化那条判据由 `rfc311-session-view-bounded.test.ts` 继续看守，这里不重复。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, users, workflows } from '../src/db/schema'
import { getSessionTree } from '../src/services/sessionView'
import { recordStatements, type RecordedStatement } from './helpers/statementRecorder'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SESSION = 'ses_parent'

interface SeedEvent {
  /** 显式给 id，让「插入序 vs ts 序」可以被刻意拆开。 */
  id: number
  ts: number
  payload: string
}

async function seedBase(db: DbClient): Promise<string> {
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'u1',
    role: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
  const snapshot = JSON.stringify({
    nodes: [{ id: 'n1', kind: 'agent-single', data: { agentName: 'worker' } }],
    edges: [],
  })
  await db.insert(workflows).values({ id: 'wf1', name: 'wf', definition: snapshot })
  await db.insert(tasks).values({
    id: 't1',
    name: 't1',
    workflowId: 'wf1',
    workflowSnapshot: snapshot,
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: 'b',
    status: 'done',
    inputs: '{}',
    startedAt: 1,
    runningMs: 0,
    ownerUserId: 'u1',
    invocationDepth: 0,
    launchOrigin: 'manual',
    branchStartedAt: 1,
    rootTaskId: 't1',
  })
  return snapshot
}

async function seedRun(
  db: DbClient,
  runId: string,
  events: SeedEvent[],
  retryIndex = 0,
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: runId,
    taskId: 't1',
    nodeId: 'n1',
    status: 'done',
    retryIndex,
    startedAt: 1,
    promptText: `prompt for ${runId}`,
    opencodeSessionId: SESSION,
  })
  for (const e of events) {
    await db.insert(nodeRunEvents).values({
      id: e.id,
      nodeRunId: runId,
      ts: e.ts,
      kind: 'text',
      sessionId: SESSION,
      parentSessionId: null,
      payload: e.payload,
    })
  }
}

/** 常规数据：ts 与 id 同序。 */
function monotonic(base: number, n: number, tag: string): SeedEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: base + i,
    ts: 1_000 + base + i,
    payload: `${tag}-${i}`,
  }))
}

/**
 * 树里 assistant 文本的**逐行**内容。parser 会把连续 text 事件拼成一条消息，所以
 * 「哪些事件进了窗口、按什么顺序」在这里是一个精确的字符串数组——比 `toContain`
 * 硬得多，窗口多一条少一条都会红。
 */
function textLines(tree: unknown): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const n = node as {
      messages?: Array<{ kind?: string; text?: string }>
      children?: unknown[]
    }
    for (const m of n.messages ?? []) {
      if (m.kind === 'assistant-text' && typeof m.text === 'string') out.push(...m.text.split('\n'))
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(tree)
  return out
}

describe('RFC-314 D2 —— 窗口成员', () => {
  test('每个 run 各自的最早 N / 最新 M 都在，中段被舍弃', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await seedRun(db, 'nr_a', monotonic(100, 20, 'A'))
    await seedRun(db, 'nr_b', monotonic(200, 20, 'B'), 1)

    const { tree } = await getSessionTree(db, 't1', 'nr_a', { rootPrefix: 2, tail: 3 })

    // 逐 run 各取各的窗口：A 与 B 的头 2 条 + 尾 3 条都在，中段（*-2 … *-16）被舍弃。
    // 旧的「全局取窗口」在 tail=3 时只会留下全局最新的 3 条（全部来自 nr_b），
    // nr_a 的尾巴会整段消失——这条断言就是那个差别。
    expect(textLines(tree)).toEqual([
      'A-0',
      'A-1',
      'A-17',
      'A-18',
      'A-19',
      'B-0',
      'B-1',
      'B-17',
      'B-18',
      'B-19',
    ])
  })

  test('ts 与 id 乱序时按 id 划线：最后写入的旧 ts 事件仍在尾窗内', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    // 前 10 条正常，最后一条是子代理回灌：id 最大（最后写入）但 ts 很旧。
    await seedRun(db, 'nr_a', [
      ...monotonic(100, 10, 'A'),
      { id: 200, ts: 1, payload: 'BACKFILLED-OLD-TS' },
    ])

    const { tree } = await getSessionTree(db, 't1', 'nr_a', { rootPrefix: 1, tail: 2 })

    // 尾窗按 id 取 ⇒ 回灌那条在窗口内（旧的按 ts 取会把它排到最前、落在 tail 之外）；
    // 而**输出顺序**仍按 (ts,id)，所以它排在最前面。两件事在这一条断言里同时被钉住。
    expect(textLines(tree)).toEqual(['BACKFILLED-OLD-TS', 'A-0', 'A-9'])
  })
})

describe('RFC-314 D2 —— 结构判据', () => {
  async function capture(eventsPerRun: number): Promise<{
    statements: RecordedStatement[]
    db: DbClient
  }> {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await seedRun(db, 'nr_a', monotonic(1_000, eventsPerRun, 'A'))
    await seedRun(db, 'nr_b', monotonic(100_000, eventsPerRun, 'B'), 1)
    const raw = (db as unknown as { $client: Parameters<typeof recordStatements>[0] }).$client
    const rec = recordStatements(raw)
    try {
      await getSessionTree(db, 't1', 'nr_a', { rootPrefix: 3, tail: 5 })
    } finally {
      rec.stop()
    }
    return { statements: rec.statements, db }
  }

  test('语句条数只随 lineage 的 run 数增长，不随事件量增长', async () => {
    const small = await capture(10)
    const large = await capture(400)
    expect(large.statements.length).toBe(small.statements.length)
    // 2 个 sibling run × (prefix + tail) = 4 条事件查询。数目本身也钉住：旧实现是
    // 「两条全局查询」，把 lineage 合在一起取窗口——那正是要被换掉的形状。
    const eventSelects = large.statements.filter(
      (s) => /^\s*select/i.test(s.sql) && s.sql.includes('node_run_events'),
    )
    expect(eventSelects).toHaveLength(4)
  })

  test('事件窗口查询不临时排序、不扫大表', async () => {
    const { statements, db } = await capture(400)
    const raw = (
      db as unknown as { $client: { prepare(q: string): { all(...a: unknown[]): unknown[] } } }
    ).$client
    const eventSelects = statements.filter(
      (s) => /^\s*select/i.test(s.sql) && s.sql.includes('node_run_events'),
    )
    expect(eventSelects.length).toBeGreaterThan(0)
    for (const stmt of eventSelects) {
      const args = Array.from({ length: stmt.params }, () => null)
      const plan = (
        raw.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`).all(...args) as Array<{ detail: string }>
      )
        .map((r) => r.detail)
        .join('\n')
      expect(plan, `计划里出现了临时排序：\n${stmt.sql}\n${plan}`).not.toContain('USE TEMP B-TREE')
      expect(plan, `计划里出现了裸扫：\n${stmt.sql}\n${plan}`).not.toContain('SCAN node_run_events')
    }
  })
})
