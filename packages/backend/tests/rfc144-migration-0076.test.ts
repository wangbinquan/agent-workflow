// RFC-144 T5 — migration 0076 存量僵尸行清洗语义。
//
// 为什么这条测试存在：runTask 入口 replay 只按 (task_id, merge_state) 捞行，
// RFC-144 之前落库的「被取代但 merge_state 停在在途值」的历史行会把过期 delta
// 物化进主树（stale replay，design §7）。运行时不变量由 mint 收口点维持；本
// 迁移清洗存量。三类行判定必须精确：
//   ① freshest 崩溃窗口行（无更新兄弟）原样保留——它是合法 replay 对象，误清
//      会把「崩溃恢复」这个 RFC-130 核心能力干掉；
//   ② 被取代的 top-level 在途行（isolating/pending-merge/conflict-human）清洗；
//   ③ 被取代父行的子行随父清洗（(b) 支）；父行未被取代的子行不误伤
//      （Codex 设计门 P1-2——(a) 支必须带 parent_node_run_id IS NULL 谓词）。
// 直接执行迁移文件里的真实语句（剥注释），锁 SQL 语义本身。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'

const MIGRATION = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'db',
    'migrations',
    '0076_rfc144_abandon_superseded_merge_state.sql',
  ),
  'utf8',
)

/** 定长补零 id：字典序 = 数值序（ULID 序的等价替身）。 */
const mkId = (n: number): string => String(n).padStart(26, '0')

function buildDb(): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE node_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    parent_node_run_id TEXT,
    merge_state TEXT
  )`)
  return db
}

function seed(
  db: Database,
  rows: Array<{
    id: string
    task?: string
    node?: string
    iter?: number
    parent?: string | null
    ms?: string | null
  }>,
): void {
  const ins = db.prepare(
    'INSERT INTO node_runs (id, task_id, node_id, iteration, parent_node_run_id, merge_state) VALUES (?,?,?,?,?,?)',
  )
  for (const r of rows) {
    ins.run(r.id, r.task ?? 't1', r.node ?? 'A', r.iter ?? 0, r.parent ?? null, r.ms ?? null)
  }
}

function applyMigration(db: Database): void {
  const stmt = MIGRATION.split('\n')
    .filter((l) => !l.trimStart().startsWith('--') && l.trim().length > 0)
    .join('\n')
  db.run(stmt)
}

function stateOf(db: Database, id: string): string | null {
  return (
    db.query('SELECT merge_state AS ms FROM node_runs WHERE id = ?').get(id) as {
      ms: string | null
    }
  ).ms
}

describe('migration 0076 — 三类行判定', () => {
  test('①freshest 崩溃窗口行保留 ②被取代 top-level 清洗 ③被取代父行子行清洗（新鲜父行子行不动）', () => {
    const db = buildDb()
    seed(db, [
      // ② 被取代的 top-level 在途行（老一代）→ abandoned
      { id: mkId(1), ms: 'isolating' },
      { id: mkId(2), ms: 'pending-merge' },
      { id: mkId(3), ms: 'conflict-human' },
      // ③ 老一代父行 mkId(3) 的子行 → 随父 abandoned
      { id: mkId(4), parent: mkId(3), ms: 'pending-merge' },
      // 老一代但已终态/未隔离 → 不在 from 集，保留
      { id: mkId(5), ms: 'merged' },
      { id: mkId(6), ms: null },
      { id: mkId(7), ms: 'merge-failed' },
      // ① freshest 行（最大 id、无更新兄弟）→ 合法崩溃窗口，保留
      { id: mkId(10), ms: 'pending-merge' },
      // P1-2：freshest 父行 mkId(10) 的子行 → 不得经 (a) 支误伤
      { id: mkId(11), parent: mkId(10), ms: 'pending-merge' },
    ])
    applyMigration(db)
    expect(stateOf(db, mkId(1))).toBe('abandoned')
    expect(stateOf(db, mkId(2))).toBe('abandoned')
    expect(stateOf(db, mkId(3))).toBe('abandoned')
    expect(stateOf(db, mkId(4))).toBe('abandoned')
    expect(stateOf(db, mkId(5))).toBe('merged')
    expect(stateOf(db, mkId(6))).toBeNull()
    expect(stateOf(db, mkId(7))).toBe('merge-failed')
    expect(stateOf(db, mkId(10))).toBe('pending-merge')
    expect(stateOf(db, mkId(11))).toBe('pending-merge')
  })

  test('隔离维度：不同 task / node / iteration 不构成取代关系', () => {
    const db = buildDb()
    seed(db, [
      // 同 node 但不同 iteration —— 各自 freshest，都保留
      { id: mkId(1), iter: 0, ms: 'pending-merge' },
      { id: mkId(2), iter: 1, ms: 'pending-merge' },
      // 不同 node —— 互不取代
      { id: mkId(3), node: 'B', ms: 'conflict-human' },
      // 不同 task —— 互不取代（id 序even更大也无关）
      { id: mkId(4), task: 't2', ms: 'isolating' },
    ])
    applyMigration(db)
    expect(stateOf(db, mkId(1))).toBe('pending-merge')
    expect(stateOf(db, mkId(2))).toBe('pending-merge')
    expect(stateOf(db, mkId(3))).toBe('conflict-human')
    expect(stateOf(db, mkId(4))).toBe('isolating')
  })

  test('幂等：二次执行零变更（abandoned 不在 from 集）', () => {
    const db = buildDb()
    seed(db, [
      { id: mkId(1), ms: 'pending-merge' },
      { id: mkId(2), ms: 'pending-merge' },
    ])
    applyMigration(db)
    expect(stateOf(db, mkId(1))).toBe('abandoned')
    expect(stateOf(db, mkId(2))).toBe('pending-merge')
    applyMigration(db)
    expect(stateOf(db, mkId(1))).toBe('abandoned')
    expect(stateOf(db, mkId(2))).toBe('pending-merge')
  })
})
