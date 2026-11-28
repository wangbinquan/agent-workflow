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
// 【守卫层】RFC-093（WP-7）已落地：调研基线的五处装饰性 async 事务（review.ts、
// memory.ts ×2、plugin.ts、mcp.ts）已全部改写为 src/db/txSync.ts 的 dbTxSync
// （类型层拒绝 async 回调 + 运行时 Promise 守卫即回滚），守卫从此零容忍——
// src 内任何非注释行出现 `.transaction(async` 本测试即红，强迫作者面对本文件
// 行为证明层的事实并改用 dbTxSync。原语自身的行为锁定（提交/回滚/运行时守卫/
// review 三步序列红绿对照）见 rfc093-db-tx-sync.test.ts。

import { insertOne } from '@/platform/persistence/singleInsert'
import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import {
  RAW_TRANSACTION_SITES,
  countNonCommentMatches,
  withoutConversionTargetTransactions,
} from './helpers/rfc629SharedProgramRules'

// Building the cached whole-source TypeScript semantic graph take about 7 s per CI-scaled case; allow 30 s.
setDefaultTimeout(30000)

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
      await insertOne(tx, t, { id: 1, v: 'a' })
      // 第一个 await 已把控制权交还同步包装器 → 包装器已 COMMIT。
      observed.inTxAfterFirstAwait = raw.inTransaction
      await insertOne(tx, t, { id: 2, v: 'b' }) // autocommit 单飞
    })

    expect(observed.inTxAtBodyStart).toBe(true)
    expect(observed.inTxAfterFirstAwait).toBe(false) // ← S-10 的核心事实
    expect((await db.select().from(t)).length).toBe(2)
  })

  test('throw after the first await rejects the promise but does NOT roll back already-run statements', async () => {
    const { db } = makeDb()

    await expect(
      db.transaction(async (tx) => {
        await insertOne(tx, t, { id: 1, v: 'a' })
        await insertOne(tx, t, { id: 2, v: 'b' })
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
// 守卫层（实库 `ts.Program` 全仓扫描已并入 architecture/rfc629-shared-program-guards.test.ts；
// 本文件保留 SQLite 行为证明层、虚拟 ConversionTargetConnection 负对照与账本元数据校核）
// ---------------------------------------------------------------------------

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

const backendConfig = ts.readConfigFile(resolve(BACKEND_SRC, '../tsconfig.json'), ts.sys.readFile)
if (backendConfig.error)
  throw new Error(ts.flattenDiagnosticMessageText(backendConfig.error.messageText, '\n'))
const compilerOptions = ts.parseJsonConfigFileContent(
  backendConfig.config,
  ts.sys,
  resolve(BACKEND_SRC, '..'),
).options

test('S-10 resolves the real async target contract while retaining raw and unknown receivers', () => {
  const file = resolve(BACKEND_SRC, '__s10_transaction_fixture.ts')
  const content = `
    import type { ConversionTargetConnection as Target } from '@/platform/persistence/migration/run/types'
    import type { Database } from 'bun:sqlite'
    declare const target: Target
    declare const nested: { target: Target }
    declare const raw: Database
    declare const unresolved: any
    interface ConversionTargetConnection { transaction(body: () => Promise<void>): void }
    declare const lookalike: ConversionTargetConnection
    declare const mixed: Target | Database
    const alias = target
    target.transaction(async () => { raw.transaction(async () => {}) })
    nested.target.transaction(async () => {})
    alias.transaction(async () => {})
    unresolved.transaction(async () => {})
    lookalike.transaction(async () => {})
    mixed.transaction(async () => {})
    function shadow(target: Database) { target.transaction(async () => {}) }
  `
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
  const host = ts.createCompilerHost(compilerOptions)
  const readSource = host.getSourceFile.bind(host)
  host.getSourceFile = (name, language, onError, createNew) =>
    name === file ? source : readSource(name, language, onError, createNew)
  const program = ts.createProgram([file], compilerOptions, host)
  const filtered = withoutConversionTargetTransactions(
    source,
    program.getTypeChecker(),
    BACKEND_SRC,
  )
  expect(countNonCommentMatches(filtered, /\.transaction\s*\(\s*async\b/g)).toBe(5)
  expect(filtered).toContain('raw.transaction(async')
  expect(filtered).toContain('unresolved.transaction(async')
  expect(filtered).toContain('lookalike.transaction(async')
  expect(filtered).toContain('mixed.transaction(async')
  expect(filtered).toContain('function shadow(target: Database) { target.transaction(async')
  expect(filtered).not.toContain('nested.target.transaction(')
  expect(filtered).not.toContain('alias.transaction(')
})

describe('RFC-317 T37（CC-04）—— 原始事务账本元数据校核', () => {
  // RFC-351 —— 只答「回调体是同步的」不够：那只关闭 S-10，没关闭 RFC-338 AC-2。
  test('每条保留理由都同时回答两类危害（只答同步体 ⇒ 红）', () => {
    for (const [file, site] of Object.entries(RAW_TRANSACTION_SITES)) {
      expect(site.why, `${file}: 未说明同步体/半提交这一类`).toMatch(/同步|async|半提交/)
      expect(site.why, `${file}: 未说明 BEGIN IMMEDIATE / BUSY_SNAPSHOT 这一类`).toMatch(
        /IMMEDIATE|BUSY_SNAPSHOT|预占/,
      )
    }
  })

  test('账本里的文件都还在（文件没了 ⇒ 这一行是空白许可证，必须删）', () => {
    const gone = Object.keys(RAW_TRANSACTION_SITES).filter(
      (rel) => !existsSync(join(BACKEND_SRC, rel)),
    )
    expect(gone, '死条目会让该路径下未来新增的直调事务被静默放过').toEqual([])
  })
})
