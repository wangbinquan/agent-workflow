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

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

/**
 * RFC-093 已落地（WP-7）：调研基线的五处装饰性 async 事务（mcp.ts / memory.ts ×2 /
 * plugin.ts / review.ts）已全部改写为 `dbTxSync`（src/db/txSync.ts）的同步执行面。
 * 守卫从此零容忍：src 内任何非注释行出现 `.transaction(async` 即红。
 */
const EXPECTED_ASYNC_TX_SITES: Record<string, number> = {}

describe('S-10 guard: `.transaction(async` inventory in packages/backend/src', () => {
  test('ZERO decorative async transactions — any occurrence turns this red (use dbTxSync)', () => {
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
    // 任何命中 → 此断言红。处置：不要写 async 事务体——它在 bun:sqlite 下
    // 没有任何原子性（见本文件行为证明层）；用 src/db/txSync.ts 的 dbTxSync
    // + 同步执行面（.all()/.run()/.get()）。
    expect(actual).toEqual(EXPECTED_ASYNC_TX_SITES)
  })
})

/**
 * RFC-317 T37（CC-04）—— 词法禁令升级为**站点账本**。
 *
 * 上面那条只挡 `.transaction(async`：一个**不带 `async` 关键字、但返回 promise** 的箭头
 * 函数它一个字都匹配不到。而 bun:sqlite 只看「回调返回了什么」——返回一个 pending
 * promise，wrapper 就当回调结束并立刻 COMMIT，之后的语句全在 autocommit 里跑。也就是说
 * 那条禁令挡住的是**一种拼法**，不是那类危险。
 *
 * `dbTxSync` 才是本仓唯一被认可的事务原语：它在类型层把返回 promise 的回调塌成
 * `never`，在运行期对 thenable 抛错（抛在事务内 ⇒ drizzle ROLLBACK，失败得大声）。
 * 于是「谁在绕过它直接调 drizzle 的 db.transaction」必须是**可枚举的**——新增一处要么
 * 改用 dbTxSync，要么在这张表里登记并说清为什么。
 *
 * 现存 37 处全部在 store / infrastructure 层：那里的对象**拥有**自己的事务边界，
 * 回调体是同步的 drizzle 执行面（上面那条零容忍断言持续证明它们不含 async 体）。
 * 这张表不是「豁免」，是**可见性**：它让「又多了一个绕过内核的事务点」变成 diff 里
 * 必然出现的一行数字变化，而不是淹没在几百行 store 代码里的一次静默新增。
 */
const RAW_TRANSACTION_SITES: Record<string, number> = {
  'modules/development-automation/composition/digitalEmployeePlatformWorkItems.ts': 1,
  'modules/development-automation/infrastructure/sqliteMissionStore.ts': 7,
  'modules/development-automation/infrastructure/sqliteUploadSessionStore.ts': 1,
  'modules/digital-employee/composition/writerCutover.ts': 2,
  'modules/digital-employee/infrastructure/sqliteAuthoringStore.ts': 5,
  // RFC-330：+1 replaceCaseMembers；RFC-336：+1 recordMetering exact-once receipt + Case totals。
  'modules/digital-employee/infrastructure/sqliteRuntimeStore.ts': 14,
  'modules/event-center/infrastructure/sqliteCustomEventSourceStore.ts': 1,
  'modules/event-center/infrastructure/sqliteEventStore.ts': 4,
  'modules/development-automation/composition/missionOperations.ts': 1,
}

describe('RFC-317 T37（CC-04）—— 绕过 dbTxSync 的原始事务站点必须逐处可见', () => {
  const actualSites = (): Record<string, number> => {
    const actual: Record<string, number> = {}
    for (const file of walkTsFiles(BACKEND_SRC)) {
      const rel = relative(BACKEND_SRC, file).split(sep).join('/')
      if (rel === 'db/txSync.ts') continue
      const count = countNonCommentMatches(readFileSync(file, 'utf8'), /\.transaction\s*\(/g)
      if (count > 0) actual[rel] = count
    }
    return actual
  }

  test('语料非空：确实扫得到一批站点（扫成空说明判据失效，此刻零预言力）', () => {
    expect(Object.keys(RAW_TRANSACTION_SITES).length).toBeGreaterThanOrEqual(9)
    expect(walkTsFiles(BACKEND_SRC).length).toBeGreaterThanOrEqual(300)
  })

  test('站点账本与磁盘逐条相等（新增一处不登记 ⇒ 红；改用 dbTxSync 后要把这行删掉 ⇒ 也红）', () => {
    expect(
      actualSites(),
      '有人绕过 dbTxSync 直接调了 drizzle 的 db.transaction。dbTxSync 的两道防线' +
        '（类型层把返回 promise 的回调塌成 never、运行期对 thenable 抛错并回滚）都不作用于' +
        '直调；确有理由直调就在 RAW_TRANSACTION_SITES 里登记这一处',
    ).toEqual(RAW_TRANSACTION_SITES)
  })

  test('账本里的文件都还在（文件没了 ⇒ 这一行是空白许可证，必须删）', () => {
    const gone = Object.keys(RAW_TRANSACTION_SITES).filter(
      (rel) => !existsSync(join(BACKEND_SRC, rel)),
    )
    expect(gone, '死条目会让该路径下未来新增的直调事务被静默放过').toEqual([])
  })
})
