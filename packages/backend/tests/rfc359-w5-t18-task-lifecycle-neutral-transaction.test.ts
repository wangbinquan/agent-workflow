// RFC-359 W5-T18 —— 任务生命周期的事务 opener 从**裸驱动事务**改走中立会话
// （`postgresqlTaskLifecycleTransaction.ts`：`withPostgresqlSerializableTaskExecution` /
// `withPostgresqlTaskAggregateTransaction` 各一处 `db.transaction(` →
// `databaseSessionFor(db).serializable / .transaction`）。
//
// RFC-359 W11：本文件此前用的是同一族里的第三个 opener（node run 那一个），而**它零生产
// 调用方**——node run 的写路径在 W4-B1 就已经合成一份并改走统一写事务原语，那个 opener 从此
// 只被这份测试引用着（「测试在给死代码续命」）。它已随 W11 删除，本文件的每一条判据原样搬到
// 仍在生产上跑的 `withPostgresqlTaskAggregateTransaction`：两者同走
// `databaseSessionFor(db).transaction`，非 SERIALIZABLE，回滚与可重入的语义逐字相同。
//
// # 这份用例锁的是什么（别在重构时删掉）
//
// 裸 `db.transaction(` 在两个引擎上语义不同，而这三个 opener 恰好在最热的写路径上：
//
//   · **PG 侧不可重入**：驱动的 `transaction` 会**另开一条连接**跑那笔事务并独立提交。于是
//     「外层已有一笔事务、内层再调一次 opener」时，内层的写**不在**外层那笔里——外层回滚
//     带不走它。本波实撞过这个形状：同一段代码跑完，SQLite 侧 0 行、**PG 侧 1 行**。
//     另开连接还有第二个可观测后果：内层读不到外层尚未提交的写（READ COMMITTED）。
//   · **SQLite 侧根本跑不动**：`bun:sqlite` 的 `Database.transaction` 是同步包装器，async 体在
//     第一个 `await` 处被当成「已返回」并当场 COMMIT。这三个 opener 因此只有 PG 一份实现，
//     正是 RFC-359 要消灭的形态。
//
// 中立会话（`platform/persistence/databaseTransaction.ts`）把两件事在两个引擎上钉成同一个语义：
// **可重入**（按客户端认 AsyncLocalStorage 帧，嵌套复用外层事务句柄）与**失败回滚**
// （体内抛错整笔回滚）。下面每条用例就是这两件事各自的双引擎判据。
//
// 隔离级别与行锁没有跟着变：`serializable` 走的正是本仓当年写在
// `postgresqlTaskLifecycleTransaction.ts` 里的那段「SET TRANSACTION ISOLATION LEVEL
// SERIALIZABLE + 40001/40P01 整笔重放」——中立原语的 `serializable` 注释显式记着它以那里为蓝本；
// `withPostgresqlTaskAggregateTransaction` 事务头那条聚合根行锁的语义一字未动（W11 起它由
// 能力矩阵的 `lockAggregateRoot` 渲染：PG 发 `for update`，SQLite no-op）。
// 这两条既有判据分别由 `tests/rfc349-task-aggregate-transaction.test.ts`、
// `tests/rfc359-w11-dialect-ledger-conformance.test.ts` 与
// `tests/rfc349-postgresql-serialization-retry.test.ts` 继续把守，本文件不重复。
//
// # 变异表（2026-09-07 落地实测，`AW_TEST_POSTGRESQL_URL` 指向真库）
//
// | # | 变异 | 结果 |
// |---|------|------|
// | ① | 非 serializable 的那个 opener 改回裸的 `db.transaction(body)` | **红 3 条**：PG 2（内层读不到外层未提交的写；外层回滚带不走内层的插入）、SQLite 1（体内抛错却留下了行——同步包装器在第一个 await 处就当场 COMMIT 了） |
// | ② | `withPostgresqlSerializableTaskExecution` 改回裸的 `db.transaction(…SET ISOLATION SERIALIZABLE…)` | **红 3 条**：PG 1（外层回滚带不走内层的插入）、SQLite 2（体内抛错留行 + 外层回滚带不走内层的插入） |
//
// 两条变异在两个引擎上都红，但**红的理由不同**：
//   · PG 红在「另一条连接独立提交」——内层是一笔真的、独立的事务；
//   · SQLite 红在「同步包装器把 async 体当成已返回」——注意这一档里**语句是发出去了的**
//     （drizzle 的 thenable 在同步驱动上当场执行，`insert` 真的写进了库），是那个包装器
//     已经先 COMMIT 了，所以随后的 throw 什么也回滚不掉。
// 注意 ① 在 SQLite 的**可重入**两条上并不红：bun:sqlite 对已开事务发 SAVEPOINT，同一条连接
// 天然看得见、也天然一起回滚。**「只在 PG 上红」是结论，不是判据的缺陷**——这正是双引擎跑的理由。
//
// **本文件不覆盖的一个相邻档位**（别把这里的结论外推过去）：`.run()` 之后**漏 await**。
// 那一档的表现与上面两条都不同——SQLite 同步驱动当场就把 `changes` 给出来，PG 上 `.run()` 回的是
// 一个没被 await 的 Promise、`changes` 恒 `undefined`，于是**按受影响行数判的 CAS 会静默失真**，
// 只有 PG 红。再往下还有一档：既不 `.run()` 也不 `await` 的惰性 `QueryPromise`，语句在**两个引擎上
// 都一条不发**，双引擎一起红。判据是「语句发没发出去」双引擎一起红、「发出去了但结果没等到」只有 PG 红。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { cachedRepos } from '@/db/schema'
import {
  withPostgresqlSerializableTaskExecution,
  withPostgresqlTaskAggregateTransaction,
  type PostgresqlTaskExecutionTransaction,
} from '@/modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider } from './helpers/eachProvider'

/**
 * 这两个 opener 的形参类型仍写着 `PostgresqlDatabaseClient`——RFC-349 把它们定为
 * task-execution 的 PG 私有 atom，本次只换事务边界、不改契约。但边界换成中立会话之后，
 * **它们的事务语义已经不再依赖 PG 驱动**，于是同一份实现在 SQLite 客户端上也跑得动，
 * 这正是本文件要证的事。所以这里按客户端句柄的实际角色转型，而不是给生产代码放宽签名。
 * （W11 起 `withPostgresqlTaskAggregateTransaction` 的聚合根行锁也走能力矩阵，于是它同样
 * 在两个引擎上都跑得动——此前它裸写 `for update`，在 SQLite 上是语法错误。）
 */
const asClient = (db: ProviderNeutralDatabase): PostgresqlDatabaseClient =>
  db as unknown as PostgresqlDatabaseClient

/** 一行最小的业务行。选 `cached_repos`：两个引擎上列形状相同，且不牵扯任何生命周期不变量。 */
async function insertRow(tx: PostgresqlTaskExecutionTransaction, id: string): Promise<void> {
  await tx.insert(cachedRepos).values({
    id,
    urlHash: `h_${id}`.slice(0, 40),
    urlRedacted: `https://example.invalid/${id}.git`,
    urlEnc: null,
    localPath: `/tmp/mirror/${id}`,
    lastFetchedAt: 1,
    createdAt: 1,
  })
}

async function rowCount(db: ProviderNeutralDatabase, id: string): Promise<number> {
  const rows = await db
    .select({ id: cachedRepos.id })
    .from(cachedRepos)
    .where(eq(cachedRepos.id, id))
  return rows.length
}

class Boom extends Error {}

/**
 * 聚合根行锁的锁定键。这些用例验的是**事务边界**（回滚 / 可重入），不是行锁本身，所以
 * 故意用一个不存在的任务 id：锁语句照发（PG 上匹配 0 行、不取锁），事务语义不受影响。
 */
const TASK_ID = 't_rfc359_w5_t18_absent'

describeEachProvider('RFC-359 W5-T18 —— 任务生命周期事务边界：失败回滚', (harness) => {
  test('serializable opener：体内抛错 ⇒ 那笔写一格不留', async () => {
    const db = harness.db
    const id = `cr_${ulid()}`

    await expect(
      withPostgresqlSerializableTaskExecution(asClient(db), async (tx) => {
        await insertRow(tx, id)
        throw new Boom('body failed')
      }),
    ).rejects.toBeInstanceOf(Boom)

    expect(await rowCount(db, id), '体内抛错却留下了行 ⇒ 这笔事务没有回滚').toBe(0)
  })

  test('聚合根 opener：体内抛错 ⇒ 那笔写一格不留', async () => {
    const db = harness.db
    const id = `cr_${ulid()}`

    await expect(
      withPostgresqlTaskAggregateTransaction(asClient(db), TASK_ID, async (tx) => {
        await insertRow(tx, id)
        throw new Boom('body failed')
      }),
    ).rejects.toBeInstanceOf(Boom)

    expect(await rowCount(db, id), '体内抛错却留下了行 ⇒ 这笔事务没有回滚').toBe(0)
  })

  test('正常返回 ⇒ 提交，且返回值原样带出', async () => {
    const db = harness.db
    const id = `cr_${ulid()}`

    const returned = await withPostgresqlTaskAggregateTransaction(
      asClient(db),
      TASK_ID,
      async (tx) => {
        await insertRow(tx, id)
        return 'committed'
      },
    )

    expect(returned).toBe('committed')
    expect(await rowCount(db, id)).toBe(1)
  })
})

describeEachProvider('RFC-359 W5-T18 —— 任务生命周期事务边界：可重入', (harness) => {
  test('嵌进外层事务时复用同一笔：内层读得到外层尚未提交的写', async () => {
    const db = harness.db
    const outerId = `cr_${ulid()}`

    const seen = await databaseSessionFor(db).transaction(async (outer) => {
      await insertRow(outer, outerId)
      // 另开一条连接的话，这次读在 READ COMMITTED 下看不见 outerId（PG 裸事务的旧形态）。
      return await withPostgresqlTaskAggregateTransaction(asClient(db), TASK_ID, async (inner) => {
        const rows = await inner
          .select({ id: cachedRepos.id })
          .from(cachedRepos)
          .where(eq(cachedRepos.id, outerId))
        return rows.length
      })
    })

    expect(seen, '内层没看见外层未提交的写 ⇒ 它跑在另一笔事务里，不是复用').toBe(1)
  })

  test('外层回滚把内层 opener 写下的行一起带走（聚合根 opener）', async () => {
    const db = harness.db
    const innerId = `cr_${ulid()}`

    await expect(
      databaseSessionFor(db).transaction(async () => {
        await withPostgresqlTaskAggregateTransaction(asClient(db), TASK_ID, async (inner) => {
          await insertRow(inner, innerId)
        })
        throw new Boom('outer failed')
      }),
    ).rejects.toBeInstanceOf(Boom)

    expect(
      await rowCount(db, innerId),
      '外层回滚后行还在 ⇒ 内层在另一条连接上独立提交了（本波实撞的那个形态）',
    ).toBe(0)
  })

  test('外层回滚把内层 opener 写下的行一起带走（serializable opener）', async () => {
    const db = harness.db
    const innerId = `cr_${ulid()}`

    await expect(
      databaseSessionFor(db).transaction(async () => {
        await withPostgresqlSerializableTaskExecution(asClient(db), async (inner) => {
          await insertRow(inner, innerId)
        })
        throw new Boom('outer failed')
      }),
    ).rejects.toBeInstanceOf(Boom)

    expect(
      await rowCount(db, innerId),
      '外层回滚后行还在 ⇒ 内层在另一条连接上独立提交了（本波实撞的那个形态）',
    ).toBe(0)
  })
})
