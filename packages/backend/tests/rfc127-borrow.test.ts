// RFC-127 借壳顶替 — RFC-132 ③ 收官后的残余锁。
//
// 借壳机制已整体删除(RFC-131 T4 dispatched 账本去借壳 → RFC-132 ③ 删 immediate 账本 +
// buildBorrowedAgent + scheduler borrow 分支):节点恒跑自己的 agent,改派 = move(rerun 落
// target 节点)。本文件保留两条仍然成立的锁:
//   1. node_runs.agent_override_name (migration 0067) 列仍在(历史 audit,新行恒 null——
//      scheduler retry/revival 也写 null);mint 工厂 override 写入/默认 null 的持久化契约不变。
//   2. RFC-127 AC-9 / RFC-099 铁律:borrow 解析残余(resolveBorrowForNode 的多账本冲突
//      reject)只读图上 node id,绝不读归属列(confirmedBy/displayName/...)。
// 原 buildBorrowedAgent 纯函数锁 + scheduler wiring 锁随函数/分支删除。

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns } from '../src/db/schema'
import { mintNodeRun } from '../src/services/nodeRunMint'

describe('RFC-127 node_runs.agent_override_name persistence (migration 0067)', () => {
  const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
  const TASK_ID = 'task-borrow'
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.run(sql`INSERT INTO workflows (id, name, definition) VALUES ('wf', 'f', '{}')`)
    await db.run(sql`
      INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
        base_branch, branch, status, inputs, started_at, schema_version)
      VALUES (${TASK_ID}, 'b', 'wf', '{}', '/tmp/r', '/tmp/w', 'main', 'b', 'running', '{}', 1, 1)
    `)
  })

  test('override persists; default null', async () => {
    const id = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n1',
      status: 'pending',
      cause: 'initial',
      overrides: { agentOverrideName: 'agent-x' },
    })
    const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(row.agentOverrideName).toBe('agent-x')

    const id2 = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n2',
      status: 'pending',
      cause: 'initial',
    })
    const row2 = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id2)))[0]!
    expect(row2.agentOverrideName).toBeNull()
  })
})

// RFC-132 ③: scheduler 不再应用 borrow(节点恒跑自己的 agent);retry/revival 行的
// override 恒 null。锁定 buildBorrowedAgent 与 borrow 应用分支不复活。
describe('RFC-132 ③ — scheduler 无 borrow 应用(source-level lock)', () => {
  test('scheduler 不再 buildBorrowedAgent / isBorrowed;retry 行 override 恒 null', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(src).not.toContain('buildBorrowedAgent')
    expect(src).not.toContain('isBorrowed')
    expect(src).toContain('agentOverrideName: null')
    // 多账本冲突 reject 仍在(resolveBorrowForNode 的残余职责)。
    expect(src).toContain('await resolveBorrowForNode(')
  })
})

// RFC-127 AC-9 / RFC-099 铁律 — borrow 解析残余只读图 node id,归属列绝不进该路径。
describe('RFC-127 AC-9 — borrow 残余 prompt isolation(attribution never enters)', () => {
  test('source: resolveBorrowForNode 区域无归属列引用', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'taskQuestionDispatch.ts'),
      'utf8',
    )
    const i = src.indexOf('export async function resolveBorrowForNode')
    const j = src.indexOf('async function buildFrontierMintPlan')
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    const region = src.slice(i, j)
    expect(region).not.toMatch(/confirmedBy|confirmed_by|confirmedByRole|displayName/i)
  })
})
