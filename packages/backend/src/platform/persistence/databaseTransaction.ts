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

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { acquireWriterLease } from './writerLease'

/** 事务句柄。两个 provider 上都是 drizzle 的同一套 query builder。 */
export type DatabaseTransaction = ProviderNeutralDatabase

export interface DatabaseSession {
  /**
   * 写事务。两个 provider 上语义相同：体内抛错 ⇒ 整笔回滚；正常返回 ⇒ 提交；
   * 体内跨事件循环 tick 仍在同一事务内。
   *
   * **重入是安全的**：同一客户端上嵌套调用会复用外层事务句柄，不会再开一层、也不会自死锁。
   */
  transaction<T>(body: (tx: DatabaseTransaction) => Promise<T>): Promise<T>
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
  return frames.run(next, run)
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
  return Object.freeze({
    async transaction<T>(body: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
      const reused = reuseFrame(client)
      if (reused !== undefined) return await body(reused)
      const release = await acquireWriterLease(client)
      const tx = db as unknown as DatabaseTransaction
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
      }
    },
  })
}

/** PostgreSQL 会话。驱动自带异步事务，不需要应用层单写者（每笔事务一条独立连接）。 */
export function createPostgresqlDatabaseSession(db: PostgresqlDatabaseClient): DatabaseSession {
  const client: object = db
  return Object.freeze({
    async transaction<T>(body: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
      const reused = reuseFrame(client)
      if (reused !== undefined) return await body(reused)
      return await db.transaction(async (tx) => {
        const handle = tx as unknown as DatabaseTransaction
        return await withFrame(client, handle, async () => await body(handle))
      })
    },
  })
}
