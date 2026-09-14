// RFC-359 AC-11 —— 单行 INSERT 的世代围栏内联：四个往返收成一个。
//
// # 为什么这条判据存在
//
// PostgreSQL 的每笔**非事务单语句写**原本要四个往返——`BEGIN` / 围栏 `SELECT` / 写 /
// `COMMIT`（`postgresqlDatabaseClient.ts` 的 `withWriteFence`）。而每个认证请求固定带一笔
// 这样的写（PAT 调用审计）。它是 `void` 派发的、不挡响应，**但占着一条 reserve 出来的池连接
// 跑四个往返**，于是挡住后面的请求。
//
// 实测（本机 Docker PG，`/api/reviews/pending-count`，40 次取 p95）：
//
//   带审计写：SQLite 3.76ms / PostgreSQL 18.11ms
//   关掉它  ：SQLite 3.06ms / PostgreSQL  5.57ms   ← PG −69%，SQLite 只 −19%
//
// 「fire-and-forget 所以不要紧」是错的：它不占延迟，占的是**并发度**，而代价在 PG 上是
// SQLite 的四倍——差的正是 `BEGIN` / 围栏 / `COMMIT` 这三条 SQLite 根本不发的语句。
//
// # 锁三件事，缺一不可
//
// ① **语义逐字不变**——围栏还在：世代被退休之后这笔写必须照样被拒。只锁条数不锁语义，
//    把围栏删掉也能「优化成功」。
// ② **条数真的降了**——只锁语义不锁条数，有人把它改回四往返、语义照样对，
//    而这条判据存在的唯一理由就悄悄没了。
// ③ **不该折的形状原路走**——`on conflict` / `returning` / 多行 `values` 一律不进快路径。
//    这三类的行为必须与折叠前逐字相同。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { users } from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_800_000_000_000

function userRow(id: string) {
  return {
    id,
    username: id,
    displayName: id,
    role: 'user' as const,
    status: 'active' as const,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

describeEachProvider('RFC-359 AC-11 · 单行 INSERT 围栏内联（双引擎）', (harness) => {
  // 快路径要求本进程已给这一代记过首次写；先做一笔写把那个一次性标记走掉，
  // 否则测到的是「第一笔写」的形状而不是稳态形状。
  async function warmGenerationMark(): Promise<void> {
    await harness.db.insert(users).values(userRow(`warm_${ulid()}`))
  }

  test('① 写照样落库，两个引擎结果相同', async () => {
    await warmGenerationMark()
    const id = `u_${ulid()}`
    await harness.db.insert(users).values(userRow(id))
    const rows = await harness.db.select().from(users).where(eq(users.id, id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, role: 'user', status: 'active' })
  })

  test('② PostgreSQL 上这笔写只发一条语句（不再有 BEGIN / 围栏 / COMMIT）', async () => {
    await warmGenerationMark()
    const id = `u_${ulid()}`
    const recording = harness.recordStatements()
    await harness.db.insert(users).values(userRow(id))
    const statements = recording.statements.map((row) => String(row.sql))
    recording.stop()

    expect(statements).toHaveLength(1)
    expect(statements.filter((sql) => /^\s*(BEGIN|COMMIT)\s*$/i.test(sql))).toEqual([])
    if (harness.capabilities.provider === 'postgresql') {
      // 围栏没被删掉，只是搬进了写语句自己。
      expect(statements[0]).toContain('database_generations')
      expect(statements[0]).toContain('insert into')
    }
  })

  test('③ 不该折的形状原路走且行为不变：on conflict 幂等、returning 取回行', async () => {
    await warmGenerationMark()
    const id = `u_${ulid()}`
    await harness.db.insert(users).values(userRow(id))
    // 同一主键再插一次：`on conflict do nothing` 必须是幂等的（不抛、不改行）。
    await harness.db.insert(users).values(userRow(id)).onConflictDoNothing()
    expect(await harness.db.select().from(users).where(eq(users.id, id))).toHaveLength(1)

    const returnedId = `u_${ulid()}`
    const returned = await harness.db
      .insert(users)
      .values(userRow(returnedId))
      .returning({ id: users.id })
    expect(returned.map((row) => row.id)).toEqual([returnedId])
  })

  test('④ 围栏还在：世代被退休后，走快路径的那笔写照样被拒', async () => {
    if (harness.capabilities.provider !== 'postgresql') return
    await warmGenerationMark()
    await harness.executeFixtureDdl(
      `UPDATE "agent_workflow_meta"."database_generations" SET state = 'retired' WHERE state = 'active'`,
    )
    try {
      const blocked = `u_${ulid()}`
      const recording = harness.recordStatements()
      const rejected = await harness.db
        .insert(users)
        .values(userRow(blocked))
        .then(
          () => null,
          (error: unknown) => error,
        )
      const attempted = recording.statements.map((row) => String(row.sql))
      recording.stop()
      // 拒绝必须发生在**折叠后的那一条**上，而不是退回四往返路径顺便被老围栏拦住——
      // 否则这条判据证明的是老路径还在，不是新路径安全。
      expect(attempted).toHaveLength(1)
      expect(attempted[0]).toContain('database_generations')
      // 这是本刀最关键的一条：条数降下来了，但「世代不活跃就不许写」一个字没松。
      // drizzle 会把驱动侧的错误包一层，所以顺着 cause 链找原因，而不是比对最外层文本。
      const chain: string[] = []
      for (let error: unknown = rejected, depth = 0; error !== undefined && depth < 6; depth += 1) {
        chain.push(String((error as { message?: unknown }).message ?? error))
        error = (error as { cause?: unknown }).cause
      }
      expect(rejected).not.toBeNull()
      expect(chain.join(' | ')).toContain('generation fence')
      expect(await harness.db.select().from(users).where(eq(users.id, blocked))).toHaveLength(0)
    } finally {
      await harness.executeFixtureDdl(
        `UPDATE "agent_workflow_meta"."database_generations" SET state = 'active' WHERE state = 'retired'`,
      )
    }
    // 恢复之后写照样落得下去——上面那条拒绝不是把库弄坏了。
    const after = `u_${ulid()}`
    await harness.db.insert(users).values(userRow(after))
    expect(await harness.db.select().from(users).where(eq(users.id, after))).toHaveLength(1)
  })
})
