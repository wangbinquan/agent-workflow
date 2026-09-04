// RFC-359 W2-T10 —— 统一事务原语的原子性对拍（AC-3）。
//
// 这条测试锁的是本 RFC 的技术前提：**一个事务体可以同时跑在两个 provider 上**。
// 216 份成对适配器的唯一技术成因是「bun:sqlite 的同步事务包装器 vs PostgreSQL 的异步事务」；
// 若下面「前提」那一组变绿（即包装器忽然有原子性了），说明 bun:sqlite 行为变了，
// 先确认再改判据，不要直接删这组断言。
//
// PostgreSQL 侧的同一组断言由真库 lane 承担（W5-T21），本文件只跑 SQLite——
// 因为需要被证明「从不可能变为可能」的正是 SQLite 这一侧。

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '@/db/client'
import { CrossContextTransactionError } from '@/db/transactionScope'
import { dbTxSync } from '@/db/txSync'
import { createSqliteDatabaseSession } from '@/platform/persistence/databaseTransaction'
import { acquireWriterLease, WriterLeaseTimeoutError } from '@/platform/persistence/writerLease'
import { MIGRATIONS } from './migration-freeze'

function scratchDb(): DbClient {
  const db = createInMemoryDb(MIGRATIONS)
  db.run(sql.raw('create table rfc359_scratch(id integer primary key, v text)'))
  return db
}

const values = (db: DbClient): string[] =>
  db.all<{ v: string }>(sql.raw('select v from rfc359_scratch order by id')).map((row) => row.v)

const insert = (db: DbClient, v: string): void => {
  db.run(sql.raw(`insert into rfc359_scratch(v) values ('${v}')`))
}

describe('RFC-359 —— 统一事务原语（SQLite）', () => {
  test('前提：bun:sqlite 的同步包装器 + async 回调确实零原子性', async () => {
    const db = scratchDb()
    // drizzle 的 `transaction(fn)` 直接执行并返回 Promise（不同于裸 bun:sqlite 返回可调用体）。
    await expect(
      db.transaction(async () => {
        insert(db, 'A1')
        await Promise.resolve()
        insert(db, 'A2')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(
      values(db),
      'bun:sqlite 的包装器忽然有原子性了 ⇒ 本 RFC 的技术前提变了，先确认再改判据',
    ).toEqual(['A1', 'A2'])
  })

  test('体内抛错 ⇒ 整笔回滚，且跨真实事件循环 tick 仍然成立', async () => {
    const db = scratchDb()
    const session = createSqliteDatabaseSession(db)
    await expect(
      session.transaction(async () => {
        insert(db, 'B1')
        await new Promise((resolve) => setTimeout(resolve, 3))
        insert(db, 'B2')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(values(db)).toEqual([])
  })

  test('正常返回 ⇒ 提交；体内自读看得见未提交的自身写入', async () => {
    const db = scratchDb()
    const session = createSqliteDatabaseSession(db)
    const seenInside = await session.transaction(async () => {
      insert(db, 'C1')
      await new Promise((resolve) => setTimeout(resolve, 3))
      insert(db, 'C2')
      return values(db)
    })
    expect(seenInside).toEqual(['C1', 'C2'])
    expect(values(db)).toEqual(['C1', 'C2'])
  })

  test('单写者租约：并发事务不交错', async () => {
    const db = scratchDb()
    const session = createSqliteDatabaseSession(db)
    const one = session.transaction(async () => {
      insert(db, 'D1a')
      await new Promise((resolve) => setTimeout(resolve, 8))
      insert(db, 'D1b')
    })
    const two = session.transaction(async () => {
      insert(db, 'D2a')
      await new Promise((resolve) => setTimeout(resolve, 1))
      insert(db, 'D2b')
    })
    await Promise.all([one, two])
    // 交错的话会出现 D1a,D2a,… 的形状；串行化保证每笔的两条相邻。
    expect(values(db)).toEqual(['D1a', 'D1b', 'D2a', 'D2b'])
  })

  // 显式超时：重入检出一旦回归，内层会等外层持有的写者租约 ⇒ 死锁。没有超时的话 CI 上
  // 表现为整个分片挂住而不是一条可归因的红（2026-09-04 变异验证实测到这个形态）。
  test('重入：嵌套调用复用外层事务，不死锁、不双开、随外层一起回滚', async () => {
    const db = scratchDb()
    const session = createSqliteDatabaseSession(db)
    await expect(
      session.transaction(async () => {
        insert(db, 'E1')
        await session.transaction(async () => {
          insert(db, 'E2')
        })
        throw new Error('outer boom')
      }),
    ).rejects.toThrow('outer boom')
    expect(values(db), '内层写入必须随外层一起回滚——它们本就是同一笔事务').toEqual([])
  }, 5_000)

  test('重入的正向：内外都提交后一起可见', async () => {
    const db = scratchDb()
    const session = createSqliteDatabaseSession(db)
    await session.transaction(async () => {
      insert(db, 'F1')
      await session.transaction(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2))
        insert(db, 'F2')
      })
    })
    expect(values(db)).toEqual(['F1', 'F2'])
  }, 5_000)
})

describe('RFC-359 —— 写者租约的有界等待', () => {
  test('等不到租约时抛可诊断的错误，而不是无界挂住', async () => {
    const client = {}
    const held = await acquireWriterLease(client)
    await expect(acquireWriterLease(client, 20)).rejects.toBeInstanceOf(WriterLeaseTimeoutError)
    held()
  })

  test('超时的等待者会放行链条，不把一处故障放大成全进程停摆', async () => {
    const client = {}
    const held = await acquireWriterLease(client)
    await expect(acquireWriterLease(client, 20)).rejects.toThrow(WriterLeaseTimeoutError)
    // 持有者正常释放后，后来的等待者必须仍能取到——超时者已把自己从链上放行。
    held()
    const next = await acquireWriterLease(client, 1_000)
    expect(typeof next).toBe('function')
    next()
  })

  test('release 幂等：重复调用不会把链条提前放行', async () => {
    const client = {}
    const first = await acquireWriterLease(client)
    first()
    first()
    const second = await acquireWriterLease(client, 1_000)
    second()
    expect(true).toBe(true)
  })
})

// 过渡期里 `dbTxSync` 与统一原语跑在同一条连接上。这一组锁的是它们的共存语义——
// 尤其是那个**静默**的危险形态：旁观者的写入被卷进别人开着的事务并随它回滚。
describe('RFC-359 —— 与 dbTxSync 的共存', () => {
  test('同一上下文里嵌套 dbTxSync 合法，且随外层一起回滚', async () => {
    const db = scratchDb()
    const session = createSqliteDatabaseSession(db)
    await expect(
      session.transaction(async () => {
        insert(db, 'G1')
        await new Promise((resolve) => setTimeout(resolve, 2))
        dbTxSync(db, (tx) => {
          tx.run(sql.raw("insert into rfc359_scratch(v) values ('G2')"))
          return 1
        })
        throw new Error('outer boom')
      }),
    ).rejects.toThrow('outer boom')
    expect(values(db), 'bun:sqlite 对已开事务走 SAVEPOINT——内层必须随外层一起回滚').toEqual([])
  })

  test('跨上下文的旁观者写入被拦下，而不是被静默卷入并回滚', async () => {
    const db = scratchDb()
    const session = createSqliteDatabaseSession(db)
    let bystander: unknown = null
    const outer = session.transaction(async () => {
      insert(db, 'H1')
      await new Promise((resolve) => setTimeout(resolve, 30))
      throw new Error('outer boom')
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    try {
      // 另一个 async 上下文：它不知道有事务开着，也不持有租约。
      dbTxSync(db, (tx) => {
        tx.run(sql.raw("insert into rfc359_scratch(v) values ('H2')"))
        return 1
      })
    } catch (error) {
      bystander = error
    }
    await expect(outer).rejects.toThrow('outer boom')
    expect(
      bystander,
      '旁观者必须拿到明确错误。放它过去的话它会落进别人的事务并随之回滚——不报错、行消失',
    ).toBeInstanceOf(CrossContextTransactionError)
    expect(values(db)).toEqual([])
  })

  test('事务结束后旁观者恢复正常', async () => {
    const db = scratchDb()
    const session = createSqliteDatabaseSession(db)
    await session.transaction(async () => {
      insert(db, 'I1')
    })
    dbTxSync(db, (tx) => {
      tx.run(sql.raw("insert into rfc359_scratch(v) values ('I2')"))
      return 1
    })
    expect(values(db)).toEqual(['I1', 'I2'])
  })
})

describe('RFC-359 —— serializable() opt-in（SQLite 侧等于 transaction）', () => {
  test('抛错回滚、正常提交、重入复用，与 transaction 同一语义', async () => {
    const db = scratchDb()
    const session = createSqliteDatabaseSession(db)
    await expect(
      session.serializable(async () => {
        insert(db, 'S1')
        await new Promise((resolve) => setTimeout(resolve, 2))
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(values(db)).toEqual([])
    await session.serializable(async () => {
      insert(db, 'S2')
      await session.transaction(async () => {
        insert(db, 'S3')
      })
    })
    expect(values(db)).toEqual(['S2', 'S3'])
  })
})
