// RFC-359 W2 —— 统一事务原语：一个事务体，两个 provider。
//
// # 它解决的是什么
//
// 本仓有 153 对 `sqliteX.ts` / `postgresqlX.ts` 成对适配器（SQLite 侧 30,135 行 / PG 侧 49,288 行）。
// 它们存在的**唯一**技术原因是事务：`bun:sqlite` 的 `Database.transaction` 是同步包装器——async
// 回调在第一个 `await` 处被它当作「已返回」并当场 COMMIT（`db/txSync.ts` 头注释记录了这个行为，
// RFC-093 因此在类型层把 Promise 回调塌成 `never`）；而 PostgreSQL 客户端是 async。于是一个事务体
// 没法同时跑在两侧，业务逻辑只能抄两遍——RFC-350 的 `taskIdleTimeoutPersistence.ts` 之所以能
// 「一份实现两个 provider 共用」，正是因为它**没有事务**，其头注释把这一点写得很明白。
//
// # 为什么现在可以合一
//
// RFC-093 的结论只对**那个包装器**成立，不是 SQLite 事务的固有性质。自己用显式语句划边界即可
// （2026-09-04 实测，经 drizzle 的 `sql.raw`）：
//
//   形态                                                        体内抛错后残留
//   db.transaction(async () => …)                               ["A1","A2"]  ← 零原子性
//   BEGIN IMMEDIATE + async 体 + COMMIT/ROLLBACK                []           ← 真回滚
//   同上，体内跨真实事件循环 tick（setTimeout）                  正常提交
//
// 仓内已有先例这么做：`platform/persistence/sqliteLogicalTarget.ts:222,287`。
//
// # 代价与护栏
//
// 显式边界让事务体里可以 `await`，也就打开了一个事件循环让渡窗口。两条护栏：
//   · 同一客户端上的写事务由 `writerLease` 串行化（见该文件头注释）；
//   · 事务体**只应 await 数据库操作**。await 网络 / 子进程 / 大文件会独占写者，
//     其余写请求在应用层排队。这条目前靠约定，RFC-359 W2-T12 会补 lint 规则。

import { sql } from 'drizzle-orm'
import { AsyncLocalStorage } from 'node:async_hooks'

import { observeDbTransaction, type DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'
import { runInExplicitTransactionScope } from '@/db/transactionScope'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlCapabilities,
  createSqliteCapabilities,
  type EngineCapabilities,
} from './capabilities'
import { unhandledDatabaseProvider } from './databaseProviders'
import type { DatabaseProvider } from './schemaContract'
import { acquireWriterLease } from './writerLease'

/** 事务句柄。两个 provider 上都是 drizzle 的同一套 query builder。 */
export type DatabaseTransaction = ProviderNeutralDatabase

// 每个引擎一份能力矩阵单例：`session.engine` 与 `engineOf(tx)` 拿到的是同一个对象。
const SQLITE_ENGINE = createSqliteCapabilities()
const POSTGRESQL_ENGINE = createPostgresqlCapabilities()

/**
 * 事务句柄（或客户端）背后的引擎能力。一份实现在事务体里只拿得到 `tx`，按能力提需求时从这里取。
 *
 * 判据是 drizzle 的 `resultKind`：bun:sqlite 驱动是 `'sync'`，sqlite-proxy 是 `'async'`——而本仓
 * 唯一的 async SQLite-dialect 客户端就是 PostgreSQL 客户端（`postgresqlDatabaseClient.ts`）。
 * 这比品牌字段更稳：事务句柄是 drizzle 的 `SQLiteTransaction`，不带 `$provider`。
 */
export function engineOf(handle: DatabaseTransaction): EngineCapabilities {
  return (handle as unknown as { readonly resultKind?: unknown }).resultKind === 'async'
    ? POSTGRESQL_ENGINE
    : SQLITE_ENGINE
}

/**
 * `.run()` 结果的受影响行数。bun:sqlite 返回 `{ changes, lastInsertRowid }`；本仓的 sqlite-proxy
 * 回调对 `run` 也回 `{ rows: [], changes }`（`postgresqlDatabaseClient.ts` 的 executeArrays）。
 * 两边都在 `changes`，缺失按 0 计——CAS 判据「必须恰好 1 行」因此在缺失时失败得大声。
 */
export function affectedRows(result: unknown): number {
  const changes = (result as { readonly changes?: unknown } | null | undefined)?.changes
  return typeof changes === 'number' && Number.isSafeInteger(changes) && changes >= 0 ? changes : 0
}

export interface DatabaseSession {
  /**
   * 引擎能力矩阵（RFC-359 §5）：一份实现按能力提需求（行锁 / 认领锁子句 / advisory lock / NULL 排序 /
   * 大小写不敏感 LIKE / 错误分类……），由边界按引擎渲染最优 SQL。实现里永远不出现 provider 名。
   */
  readonly engine: EngineCapabilities
  /**
   * 写事务。两个 provider 上语义相同：体内抛错 ⇒ 整笔回滚；正常返回 ⇒ 提交；
   * 体内跨事件循环 tick 仍在同一事务内。
   *
   * **重入是安全的**：同一客户端上嵌套调用会复用外层事务句柄，不会再开一层、也不会自死锁。
   */
  transaction<T>(body: (tx: DatabaseTransaction) => Promise<T>): Promise<T>
  /**
   * 显式 opt-in 的 SERIALIZABLE 事务。**默认不要用它**——`docs/dev-gotchas.md` 第 6 条实测：小表上
   * SERIALIZABLE 的 predicate lock 是索引页粒度，8 并发满速冲突率 81.2%；READ COMMITTED + 聚合根
   * `FOR UPDATE`（capabilities.lockAggregateRoot）后 0%。只给确实需要谓词级隔离的少数路径。
   * PG：SET TRANSACTION ISOLATION LEVEL SERIALIZABLE + 40001/40P01 退避重试；SQLite：与 `transaction`
   * 相同（BEGIN IMMEDIATE 本就完全串行）。重入时复用外层事务，不再抬升隔离级别。
   */
  serializable<T>(body: (tx: DatabaseTransaction) => Promise<T>): Promise<T>
}

interface TransactionFrame {
  readonly client: object
  readonly tx: DatabaseTransaction
}

/** 当前 async 上下文里已打开的事务帧。用于重入检出。 */
const frames = new AsyncLocalStorage<readonly TransactionFrame[]>()

function reuseFrame(client: object): DatabaseTransaction | undefined {
  return frames.getStore()?.find((frame) => frame.client === client)?.tx
}

function withFrame<T>(client: object, tx: DatabaseTransaction, run: () => Promise<T>): Promise<T> {
  const next: readonly TransactionFrame[] = [...(frames.getStore() ?? []), { client, tx }]
  // 同时登记进 `db/transactionScope`：`dbTxSync` 据此判断「有事务开着且我不在它的上下文里」，
  // 把过渡期最危险的那个形态（旁观者写入被静默卷入并回滚）变成一条明确的错误。
  return runInExplicitTransactionScope(client, async () => await frames.run(next, run))
}

/**
 * SQLite 会话。显式 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`，配单写者租约。
 *
 * `BEGIN IMMEDIATE`（而不是默认的 deferred）沿用 RFC-338 AC-2 的既有不变量：写事务必须先预占
 * writer，再取读快照——deferred 事务的读→写升级会以 `SQLITE_BUSY_SNAPSHOT` 立即失败并绕过
 * `busy_timeout`（RFC-351 记录了它在 HTTP 边界被兜成 500 的实测）。
 */
export function createSqliteDatabaseSession(db: DbClient): DatabaseSession {
  const client: object = db
  const transaction = async <T>(body: (tx: DatabaseTransaction) => Promise<T>): Promise<T> => {
    const reused = reuseFrame(client)
    if (reused !== undefined) return await body(reused)
    const release = await acquireWriterLease(client)
    const tx = db as unknown as DatabaseTransaction
    const startedAt = performance.now()
    try {
      db.run(sql.raw('BEGIN IMMEDIATE'))
      let result: T
      try {
        result = await withFrame(client, tx, async () => await body(tx))
      } catch (error) {
        // ROLLBACK 自身失败意味着连接状态不可知——不吞，让它盖过原错误往上抛，
        // 由调用方按「连接不可用」处置。静默继续会把后续语句留在一个开着的事务里。
        db.run(sql.raw('ROLLBACK'))
        throw error
      }
      db.run(sql.raw('COMMIT'))
      return result
    } finally {
      release()
      // 与 dbTxSync 同一个观测点（RFC-311 的事务时长守卫读它），迁过来的事务不能从指标里消失。
      observeDbTransaction(db, performance.now() - startedAt)
    }
  }
  // BEGIN IMMEDIATE 下整个库独占，已是最强隔离；serializable 与 transaction 是同一条路。
  // （写成同一个局部函数而不是 `this.transaction(...)` 自调：S-10 / RFC-317 T37 守卫按词法扫
  // `.transaction(`，自调会被误记成一处绕过 dbTxSync 的裸 drizzle 事务。）
  return Object.freeze({
    engine: SQLITE_ENGINE,
    transaction,
    serializable: transaction,
  })
}

/** PostgreSQL 会话。驱动自带异步事务，不需要应用层单写者（每笔事务一条独立连接）。 */
export function createPostgresqlDatabaseSession(db: PostgresqlDatabaseClient): DatabaseSession {
  const client: object = db
  return Object.freeze({
    engine: POSTGRESQL_ENGINE,
    async transaction<T>(body: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
      const reused = reuseFrame(client)
      if (reused !== undefined) return await body(reused)
      return await db.transaction(async (tx) => {
        const handle = tx as unknown as DatabaseTransaction
        return await withFrame(client, handle, async () => await body(handle))
      })
    },
    async serializable<T>(body: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
      const reused = reuseFrame(client)
      if (reused !== undefined) return await body(reused)
      // 蓝本：modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts 的
      // withPostgresqlSerializableTaskExecution。整笔事务作为重试单元——body 必须可重放。
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await db.transaction(async (tx) => {
            await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
            const handle = tx as unknown as DatabaseTransaction
            return await withFrame(client, handle, async () => await body(handle))
          })
        } catch (error) {
          if (await retryPostgresqlSerialization(attempt, error)) continue
          throw error
        }
      }
    },
  })
}

const sessions = new WeakMap<object, DatabaseSession>()

/**
 * 客户端句柄自述的 provider。PostgreSQL 客户端带 `$provider` 品牌（`postgresqlDatabaseClient.ts`）；
 * 没有品牌的客户端只有 bun:sqlite 一种（`db/client.ts`）。第三个 provider 必须带自己的品牌，
 * 并在下面的分派里得到自己的分支——残余分支是 `unhandledDatabaseProvider` 的 never 汇。
 */
function databaseProviderOf(client: object): DatabaseProvider {
  const brand = (client as { readonly $provider?: unknown }).$provider
  return brand === undefined ? 'sqlite' : (brand as DatabaseProvider)
}

/**
 * 按客户端句柄取会话（按客户端记忆化）。这是全仓看 provider 的唯一地方之一：业务代码拿到的是
 * DatabaseSession，看不见 provider。
 *
 * 传**客户端**，不要传事务句柄——重入靠 AsyncLocalStorage 帧按客户端识别，事务句柄不是帧的 key，
 * 拿它开会话会在一笔开着的事务里再发一次 BEGIN。
 */
export function databaseSessionFor(db: ProviderNeutralDatabase): DatabaseSession {
  const client = db as object
  const cached = sessions.get(client)
  if (cached !== undefined) return cached
  const provider = databaseProviderOf(client)
  const session =
    provider === 'postgresql'
      ? createPostgresqlDatabaseSession(db as unknown as PostgresqlDatabaseClient)
      : provider === 'sqlite'
        ? createSqliteDatabaseSession(db as unknown as DbClient)
        : unhandledDatabaseProvider(provider)
  sessions.set(client, session)
  return session
}
