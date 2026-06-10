// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-10 (WP-7)
//
// 两层各司其职：
//
// 【行为证明层】固化平台语义（这不是 bug 测试，是"为什么 async 事务是装饰性的"
// 的可执行证据，绿测试）：drizzle + bun:sqlite 的 `db.transaction(async (tx) => …)`
// 中，bun:sqlite 的 Database.transaction 是同步包装——async 回调在第一个 await
// 处把控制权交还包装器，包装器见回调"返回"（返回的是 pending promise）即刻
// COMMIT。因此：
//   - 第一个 await 之后 connection 已不在事务中（raw.inTransaction === false）；
//   - await 之后的语句逐条 autocommit；
//   - 事后抛异常只会 reject 外层 promise，已写入的行不回滚。
// 仓内双重旁证：services/clarify.ts:385-387 注释明写 "db.transaction does NOT
// help: bun:sqlite's transaction is synchronous, so an async body COMMITs at
// its first real await — verified"；lifecycleRepair/options-R2.ts:4-7 记载
// RFC-052 approve 半提交事故正是此类。
//
// 【守卫层】当前缺陷行为：src 下仍存在五处装饰性 async 事务（review.ts:505、
// memory.ts:285/415、plugin.ts:237、mcp.ts:126）——API 形态像安全的，RFC-052
// 之后 review.ts:505 又新写了一处，复发已被证实。守卫断言清单恰好等于这五处：
// 任何人再写出第六处（或在新文件里写出第一处）本测试即红，强迫其面对本文件
// 行为证明层的事实。
//
// 正确语义：需要原子性的多写序列必须走同步事务（WP-7 的 dbTxSync 助手，包装
// bun:sqlite 原生同步 transaction——本文件第三个用例演示了该原语确实回滚）。
// 修复落点：WP-7（dbTxSync 助手 + 改写五处 + 修正 memory.ts:9 错误注释）。
// 修复时本文件的守卫用例应翻红：把 EXPECTED_ASYNC_TX_SITES 清空（或随逐处改写
// 递减），最终断言 src 内 `.transaction(async` 零命中；行为证明层永久保留。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// 行为证明层
// ---------------------------------------------------------------------------

const t = sqliteTable('t', {
  id: integer('id').primaryKey(),
  v: text('v').notNull(),
})

function makeDb(): { raw: Database; db: ReturnType<typeof drizzle> } {
  const raw = new Database(':memory:')
  raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)')
  return { raw, db: drizzle(raw) }
}

describe('S-10 platform semantics: drizzle + bun:sqlite async transaction is decorative', () => {
  test('async body COMMITs at the first await — connection leaves the transaction mid-body', async () => {
    const { raw, db } = makeDb()
    const observed = {
      inTxAtBodyStart: null as boolean | null,
      inTxAfterFirstAwait: null as boolean | null,
    }

    await db.transaction(async (tx) => {
      // 同步前奏仍在 BEGIN..COMMIT 内。
      observed.inTxAtBodyStart = raw.inTransaction
      await tx.insert(t).values({ id: 1, v: 'a' })
      // 第一个 await 已把控制权交还同步包装器 → 包装器已 COMMIT。
      observed.inTxAfterFirstAwait = raw.inTransaction
      await tx.insert(t).values({ id: 2, v: 'b' }) // autocommit 单飞
    })

    expect(observed.inTxAtBodyStart).toBe(true)
    expect(observed.inTxAfterFirstAwait).toBe(false) // ← S-10 的核心事实
    expect((await db.select().from(t)).length).toBe(2)
  })

  test('throw after the first await rejects the promise but does NOT roll back already-run statements', async () => {
    const { db } = makeDb()

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(t).values({ id: 1, v: 'a' })
        await tx.insert(t).values({ id: 2, v: 'b' })
        // 模拟 review.ts:505-538 这类多写序列中途失败/崩溃点。
        throw new Error('mid-sequence failure')
      }),
    ).rejects.toThrow('mid-sequence failure')

    // 半态留存：两行都已 autocommit 落库，没有任何回滚——
    // 正是 lifecycleRepair R2 规则（RFC-052 approve 半提交）的事故根因类。
    const rows = await db.select().from(t)
    expect(rows.length).toBe(2)
  })

  test('the safe primitive WP-7 will wrap: raw bun:sqlite SYNCHRONOUS transaction does roll back on throw', () => {
    const { raw } = makeDb()
    const ins = raw.prepare('INSERT INTO t (id, v) VALUES (?, ?)')
    const txFn = raw.transaction(() => {
      ins.run(1, 'a')
      ins.run(2, 'b')
      throw new Error('sync failure')
    })

    expect(() => txFn()).toThrow('sync failure')
    const count = raw.query('SELECT COUNT(*) AS n FROM t').get() as { n: number }
    expect(count.n).toBe(0) // 同步回调形态：真回滚
  })
})

// ---------------------------------------------------------------------------
// 守卫层
// ---------------------------------------------------------------------------

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function countNonCommentMatches(content: string, re: RegExp): number {
  let n = 0
  for (const line of content.split('\n')) {
    if (isCommentLine(line)) continue
    const m = line.match(re)
    if (m) n += m.length
  }
  return n
}

/** 调研基线（HEAD f9db99f 附近）的五处装饰性 async 事务。 */
const EXPECTED_ASYNC_TX_SITES: Record<string, number> = {
  'services/mcp.ts': 1,
  'services/memory.ts': 2,
  'services/plugin.ts': 1,
  'services/review.ts': 1,
}

describe('S-10 guard: `.transaction(async` inventory in packages/backend/src', () => {
  test('exactly the five known decorative sites — a sixth occurrence turns this red', () => {
    const actual: Record<string, number> = {}
    for (const file of walkTsFiles(BACKEND_SRC)) {
      const count = countNonCommentMatches(
        readFileSync(file, 'utf8'),
        /\.transaction\s*\(\s*async\b/g,
      )
      if (count > 0) {
        actual[relative(BACKEND_SRC, file).split(sep).join('/')] = count
      }
    }
    // 新增命中（任何文件计数上升 / 新文件出现）→ 此断言红。处置：不要写
    // async 事务体——用 WP-7 的同步事务助手；如 WP-7 已落地并改写既有处，
    // 同步递减/清空本清单（届时目标是空对象）。
    expect(actual).toEqual(EXPECTED_ASYNC_TX_SITES)
  })
})
