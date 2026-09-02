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
 * This guard is intentionally about Bun's synchronous SQLite transaction
 * wrapper. PostgreSQL transactions are asynchronous by contract, so counting
 * their `.transaction(async ...)` calls here would turn the SQLite safety lock
 * into a provider-name allowlist. Keep the corpus source-backed instead: a file
 * is in scope only when it imports the concrete SQLite client/runtime (or is
 * itself a named SQLite adapter).
 */
function sqliteTransactionSource(relativePath: string, content: string): string | null {
  if (/(^|\/)postgresql[^/]*\.ts$/i.test(relativePath)) return null
  const ownsSqlite =
    /(^|\/)sqlite[^/]*\.ts$/i.test(relativePath) ||
    /from\s+['"](?:@\/db\/client|[^'"]*\/db\/client)['"]/.test(content) ||
    /from\s+['"](?:bun:sqlite|drizzle-orm\/bun-sqlite)['"]/.test(content)
  if (!ownsSqlite) return null

  // A few provider-private infrastructure modules colocate two explicitly
  // named factories. Only the SQLite half is subject to Bun's synchronous
  // transaction rule; the PostgreSQL half deliberately owns async tx bodies.
  const postgresqlFactory = content.search(
    /(?:export\s+)?(?:async\s+)?function\s+\w*Postgresql\w*\s*\(/,
  )
  return postgresqlFactory < 0 ? content : content.slice(0, postgresqlFactory)
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
      const rel = relative(BACKEND_SRC, file).split(sep).join('/')
      const content = readFileSync(file, 'utf8')
      const sqliteSource = sqliteTransactionSource(rel, content)
      if (sqliteSource === null) continue
      const count = countNonCommentMatches(sqliteSource, /\.transaction\s*\(\s*async\b/g)
      if (count > 0) {
        actual[rel] = count
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
 * 【RFC-351 订正】此前这段写的是「回调体是同步的 ⇒ 安全」。那句话只关闭了**一半**危害。
 * `dbTxSync` 承担两个互相独立的职责：
 *
 *   1. 同步体（S-10）：拒绝 async 回调，避免 bun:sqlite 在第一个 await 处提前 COMMIT；
 *   2. `{ behavior: 'immediate' }`（RFC-338 AC-2）：在事务边界预占 writer。deferred 事务
 *      先读取快照、再去升级成写，只要别的连接在这中间完成一次短提交，升级就以
 *      `SQLITE_BUSY_SNAPSHOT` **立即**失败并**绕过 busy_timeout**（`db/txSync.ts:51-57`）。
 *      裸 `SQLiteError` 不是 `DomainError`，`util/errors.ts` 于是兜成 500 `internal-error`。
 *
 * 只答第 1 条的理由会让第 2 条看起来「已评估」。2026-09-02 主干 CI run `33638907352` 上
 * DE-07 的两次工具发布 500 就是第 2 条：`sqliteAuthoringStore.publishTool` 当时正是一处裸
 * deferred 的「先读后写」。RFC-351 把除纯读外的站点全部收敛到 `dbTxSync`，本表因此只剩
 * 纯读事务，并要求每条 `why` **同时**回答这两类危害（下面的守卫强制）。
 */
interface RawTransactionSite {
  /** 该文件里裸 `db.transaction(` 的处数，与磁盘逐条相等。 */
  readonly count: number
  /** 必须同时回答 S-10（同步体）与 RFC-338 AC-2（BEGIN IMMEDIATE）两类危害。 */
  readonly why: string
}

const RAW_TRANSACTION_SITES: Record<string, RawTransactionSite> = {
  'modules/digital-employee/infrastructure/writerCutoverPersistence.ts': {
    count: 1,
    why:
      'migrationSnapshot 是纯读事务（只有 select，无任何写语句）。S-10 的同步体要求满足：回调体是同步 ' +
      'drizzle 执行面；RFC-338 AC-2 的 BEGIN IMMEDIATE 在这里**不适用且有害**——纯读改成 immediate 会无谓 ' +
      '预占 writer，把一次快照读变成写锁竞争者。既然没有「读后升级为写」这一步，就不存在 ' +
      'SQLITE_BUSY_SNAPSHOT 暴露面。RFC-351 保留本处。',
  },
}

describe('RFC-317 T37（CC-04）—— 绕过 dbTxSync 的原始事务站点必须逐处可见', () => {
  const actualSites = (): Record<string, number> => {
    const actual: Record<string, number> = {}
    for (const file of walkTsFiles(BACKEND_SRC)) {
      const rel = relative(BACKEND_SRC, file).split(sep).join('/')
      if (rel === 'db/txSync.ts') continue
      const content = readFileSync(file, 'utf8')
      const sqliteSource = sqliteTransactionSource(rel, content)
      if (sqliteSource === null) continue
      const count = countNonCommentMatches(sqliteSource, /\.transaction\s*\(/g)
      if (count > 0) actual[rel] = count
    }
    return actual
  }

  test('语料非空：确实扫得到一批站点（扫成空说明判据失效，此刻零预言力）', () => {
    // RFC-351 之后本表只剩纯读事务；语料非空判据改为「扫得到源码树」+「账本非空」。
    expect(Object.keys(RAW_TRANSACTION_SITES).length).toBeGreaterThanOrEqual(1)
    expect(
      Object.values(RAW_TRANSACTION_SITES).reduce((sum, site) => sum + site.count, 0),
    ).toBeGreaterThanOrEqual(1)
    expect(walkTsFiles(BACKEND_SRC).length).toBeGreaterThanOrEqual(300)
  })

  test('站点账本与磁盘逐条相等（新增一处不登记 ⇒ 红；改用 dbTxSync 后要把这行删掉 ⇒ 也红）', () => {
    expect(
      actualSites(),
      '有人绕过 dbTxSync 直接调了 drizzle 的 db.transaction。dbTxSync 的两道防线' +
        '（类型层把返回 promise 的回调塌成 never、运行期对 thenable 抛错并回滚）都不作用于' +
        '直调；确有理由直调就在 RAW_TRANSACTION_SITES 里登记这一处',
    ).toEqual(
      Object.fromEntries(
        Object.entries(RAW_TRANSACTION_SITES).map(([file, site]) => [file, site.count]),
      ),
    )
  })

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
