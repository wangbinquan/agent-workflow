// AF-D1 preserves the single-round-trip fenced INSERT after the committed first write.
// Keep AC-11's persistence, idempotence, multi-row, returning and retired-generation cases.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

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

describeEachProvider('RFC-359 AC-11 · 单行 INSERT 原生事务围栏（双引擎）', (harness) => {
  // 快路径要求本进程已给这一代记过首次写；先做一笔写把那个一次性标记走掉，
  // 否则测到的是「第一笔写」的形状而不是稳态形状。
  async function warmGenerationMark(): Promise<void> {
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, userRow(`warm_${ulid()}`))
  }

  test('① 写照样落库，两个引擎结果相同', async () => {
    await warmGenerationMark()
    const id = `u_${ulid()}`
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, userRow(id))
    const rows = await harness.db.select().from(users).where(eq(users.id, id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, role: 'user', status: 'active' })
  })

  test('② PostgreSQL 稳态单行 INSERT 只用一次往返且仍锁住 active generation', async () => {
    await warmGenerationMark()
    const id = `u_${ulid()}`
    const recording = harness.recordStatements()
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, userRow(id))
    const statements = recording.statements.map((row) => String(row.sql))
    recording.stop()

    if (harness.capabilities.provider === 'postgresql') {
      expect(statements).toHaveLength(1)
      expect(statements[0]).toContain('insert into')
      expect(statements[0]).toContain('"agent_workflow_meta"."generations"')
      expect(statements[0]!.toLowerCase()).toContain('for share')
      expect(statements[0]).not.toContain('first_write')
    } else {
      expect(statements).toHaveLength(1)
      expect(statements[0]).toContain('insert into')
    }
  })

  test('③ 不该折的形状原路走且行为不变：on conflict 幂等、returning 取回行', async () => {
    await warmGenerationMark()
    const id = `u_${ulid()}`
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, userRow(id))
    // 同一主键再插一次：`on conflict do nothing` 必须是幂等的（不抛、不改行）。
    await harness.db.insert(users).values(userRow(id)).onConflictDoNothing()
    expect(await harness.db.select().from(users).where(eq(users.id, id))).toHaveLength(1)

    const multi = [userRow(`multi_${ulid()}`), userRow(`multi_${ulid()}`)]
    const recording = harness.recordStatements()
    await harness.db.insert(users).values(multi)
    recording.stop()
    expect(await harness.db.select().from(users).where(eq(users.id, multi[0]!.id))).toHaveLength(1)
    if (harness.capabilities.isolation === 'read-committed') {
      expect(recording.statements.filter((row) => row.sql === 'BEGIN')).toHaveLength(1)
      expect(recording.statements.filter((row) => row.sql === 'COMMIT')).toHaveLength(1)
    }
    const returnedId = `u_${ulid()}`
    const returned = await harness.db
      .insert(users)
      .values(userRow(returnedId))
      .returning({ id: users.id })
    expect(returned.map((row) => row.id)).toEqual([returnedId])
  })

  test('④ 世代退休后 admission 拒绝写入，恢复 generation 后仍可写', async () => {
    if (harness.capabilities.provider !== 'postgresql') return
    await warmGenerationMark()
    await harness.executeFixtureDdl(
      `UPDATE "agent_workflow_meta"."generations" SET state = 'retired' WHERE state = 'active'`,
    )
    try {
      const blocked = `u_${ulid()}`
      const recording = harness.recordStatements()
      const { users } = tablesOf(harness.db)
      const rejected = await Promise.resolve(insertOne(harness.db, users, userRow(blocked))).then(
        () => null,
        (error: unknown) => error,
      )
      const attempted = recording.statements.map((row) => String(row.sql))
      recording.stop()
      expect(attempted).toHaveLength(1)
      expect(attempted[0]).toContain('"agent_workflow_meta"."generations"')
      expect(attempted[0]!.toLowerCase()).toContain('for share')
      // 拒绝发生在业务写入前，并保留具体的 generation-fence 错误。
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
        `UPDATE "agent_workflow_meta"."generations" SET state = 'active' WHERE state = 'retired'`,
      )
    }
    // 恢复之后写照样落得下去——上面那条拒绝不是把库弄坏了。
    const after = `u_${ulid()}`
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, userRow(after))
    expect(await harness.db.select().from(users).where(eq(users.id, after))).toHaveLength(1)
  })
})
