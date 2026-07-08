// RFC-145 T2 — migration 0077 三列 + backfill 语义。
//
// 为什么这条测试存在：error_message 上寄生的两个机器协议（信封失败前缀路由 /
// review supersede 标记）列化为 failure_code / superseded_by_review /
// rolled_back。拍板 D2 走 backfill+单读路径（不留 legacy 前缀回退），所以
// backfill 的判定必须逐格锁死：
//   ① 七个信封前缀 → 对应 code（LIKE 谓词与今日 decide 链 startsWith 逐字对应）；
//   ② D8 格：clarify-options-* 等非 clarify-questions-* 的校验码**不得**被
//      backfill（今日路由对它们不给 follow-up——误填会把无 follow-up 错误升级）；
//   ③ supersede 两决策 + rollback 后缀组合；
//   ④ 不匹配行留 NULL（= 无机器可读失败，合法常态）；幂等。
// 另按 0044 先例锁列存在/往返/历史行 NULL/全枚举可存（真迁移链路）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { FAILURE_CODES } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MIGRATION = readFileSync(resolve(MIGRATIONS, '0077_rfc145_failure_code.sql'), 'utf8')

// ---------------------------------------------------------------------------
// fixture 级：直接对最小表执行迁移文件的真实语句（剥注释 + 按 breakpoint 分段）。
// ---------------------------------------------------------------------------

function buildDb(): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE node_runs (
    id TEXT PRIMARY KEY,
    error_message TEXT
  )`)
  return db
}

function applyMigration(db: Database): void {
  const statements = MIGRATION.split('--> statement-breakpoint').map((chunk) =>
    chunk
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--') && l.trim().length > 0)
      .join('\n'),
  )
  for (const stmt of statements) {
    if (stmt.trim().length > 0) db.run(stmt)
  }
}

function seed(db: Database, id: string, errorMessage: string | null): void {
  db.prepare('INSERT INTO node_runs (id, error_message) VALUES (?, ?)').run(id, errorMessage)
}

function rowOf(
  db: Database,
  id: string,
): {
  failure_code: string | null
  superseded_by_review: string | null
  rolled_back: number | null
} {
  return db
    .query('SELECT failure_code, superseded_by_review, rolled_back FROM node_runs WHERE id = ?')
    .get(id) as never
}

describe('migration 0077 — 信封前缀 backfill 逐格', () => {
  test('七前缀 → 对应 code；不匹配留 NULL；D8：clarify-options-* 不得被填', () => {
    const db = buildDb()
    seed(db, 'r1', 'no <workflow-output> envelope found in stdout')
    seed(db, 'r2', 'clarify-and-output-both-present: agent emitted both envelopes')
    seed(db, 'r3', 'clarify-questions-malformed: empty body')
    seed(db, 'r4', 'clarify-questions-too-many: 9 > 5')
    seed(db, 'r5', 'clarify-required-missing: channel active but no clarify')
    seed(db, 'r6', 'clarify-forbidden: stop directive active')
    seed(db, 'r7', 'envelope-port-malformed: </|DSML|port>')
    seed(db, 'r8', 'port-validation-markdown-empty: port "doc" empty')
    // D8 格：clarify 校验器的非 questions 族码——今日 decide 链不给 follow-up。
    seed(db, 'r9', 'clarify-options-too-few: single option')
    // 常态失败（无机器可读形态）与空值。
    seed(db, 'r10', 'node A threw: spawn ENOENT')
    seed(db, 'r11', null)
    applyMigration(db)
    expect(rowOf(db, 'r1').failure_code).toBe('envelope-missing')
    expect(rowOf(db, 'r2').failure_code).toBe('clarify-and-output-both')
    expect(rowOf(db, 'r3').failure_code).toBe('clarify-questions-malformed')
    expect(rowOf(db, 'r4').failure_code).toBe('clarify-questions-malformed')
    expect(rowOf(db, 'r5').failure_code).toBe('clarify-required')
    expect(rowOf(db, 'r6').failure_code).toBe('clarify-forbidden')
    expect(rowOf(db, 'r7').failure_code).toBe('envelope-port-malformed')
    expect(rowOf(db, 'r8').failure_code).toBe('port-validation-failed')
    expect(rowOf(db, 'r9').failure_code).toBeNull() // D8
    expect(rowOf(db, 'r10').failure_code).toBeNull()
    expect(rowOf(db, 'r11').failure_code).toBeNull()
  })

  test('supersede 组合：两决策 × rollback 后缀；marker 行不误入 failure_code', () => {
    const db = buildDb()
    seed(
      db,
      's1',
      'superseded-by-review-iterated: Replaced by retry_index 2 due to review iterated of rv',
    )
    seed(
      db,
      's2',
      'superseded-by-review-rejected: Replaced by retry_index 1 due to review rejected of rv',
    )
    seed(
      db,
      's3',
      'superseded-by-review-iterated-rollback: Replaced by retry_index 3 due to review iterated of rv',
    )
    seed(
      db,
      's4',
      'superseded-by-review-rejected-rollback: Replaced by retry_index 4 due to review rejected of rv',
    )
    applyMigration(db)
    expect(rowOf(db, 's1')).toEqual({
      failure_code: null,
      superseded_by_review: 'iterated',
      rolled_back: null,
    })
    expect(rowOf(db, 's2').superseded_by_review).toBe('rejected')
    expect(rowOf(db, 's2').rolled_back).toBeNull()
    expect(rowOf(db, 's3')).toEqual({
      failure_code: null,
      superseded_by_review: 'iterated',
      rolled_back: 1,
    })
    expect(rowOf(db, 's4').superseded_by_review).toBe('rejected')
    expect(rowOf(db, 's4').rolled_back).toBe(1)
  })

  test('幂等：二次执行零变更', () => {
    const db = buildDb()
    seed(db, 'r1', 'no <workflow-output> envelope found in stdout')
    seed(db, 's1', 'superseded-by-review-rejected-rollback: x')
    applyMigration(db)
    const first = { r1: rowOf(db, 'r1'), s1: rowOf(db, 's1') }
    // 二次执行只跑 UPDATE 段（ALTER 会因列已存在而失败——真实迁移器不会重放已应用
    // 迁移；这里只验证 backfill 谓词的幂等）。
    const updates = MIGRATION.split('--> statement-breakpoint')
      .map((c) =>
        c
          .split('\n')
          .filter((l) => !l.trimStart().startsWith('--') && l.trim())
          .join('\n'),
      )
      .filter((s) => s.trim().startsWith('UPDATE'))
    for (const u of updates) db.run(u)
    expect({ r1: rowOf(db, 'r1'), s1: rowOf(db, 's1') }).toEqual(first)
  })
})

// ---------------------------------------------------------------------------
// 0044 式四测：真迁移链路（createInMemoryDb 应用全部 77 个迁移）。
// ---------------------------------------------------------------------------

describe('migration 0077 — 真迁移链路（0044 先例四测）', () => {
  async function harness() {
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'w',
      definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
    })
    const taskId = ulid()
    await db.insert(tasks).values({
      name: 't',
      id: taskId,
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/nonexistent/rfc145',
      worktreePath: '/nonexistent/rfc145',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    return { db, taskId }
  }

  test('三列存在且可往返；省略时为 NULL（历史行语义）', async () => {
    const { db, taskId } = await harness()
    const id = ulid()
    await db.insert(nodeRuns).values({
      id,
      taskId,
      nodeId: 'n',
      status: 'failed',
      startedAt: Date.now(),
      failureCode: 'envelope-missing',
      supersededByReview: 'iterated',
      rolledBack: true,
    })
    const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(row.failureCode).toBe('envelope-missing')
    expect(row.supersededByReview).toBe('iterated')
    expect(row.rolledBack).toBe(true)

    const bare = ulid()
    await db
      .insert(nodeRuns)
      .values({ id: bare, taskId, nodeId: 'n', status: 'failed', startedAt: Date.now() })
    const bareRow = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, bare)))[0]!
    expect(bareRow.failureCode).toBeNull()
    expect(bareRow.supersededByReview).toBeNull()
    // integer(mode:'boolean') 的 NULL 读回 null——读侧谓词恒 `=== true`。
    expect(bareRow.rolledBack).toBeNull()
  })

  test('全 FAILURE_CODES 枚举值可存（新增值自动纳入）', async () => {
    const { db, taskId } = await harness()
    for (const code of FAILURE_CODES) {
      const id = ulid()
      await db.insert(nodeRuns).values({
        id,
        taskId,
        nodeId: 'n',
        status: 'failed',
        startedAt: Date.now(),
        failureCode: code,
      })
      const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
      expect(row.failureCode).toBe(code)
    }
  })
})
