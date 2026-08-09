// RFC-271 AC-12 —— **built-in 归一写路径**必须推进 exact-revision token。
//
// 覆盖验收条款：AC-12（根资源沿用 exact-revision 保护）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）
//
// 这条锁的是一个只在**导出语义**层面才看得见的漂移。
//
// `seedFusionResources` 会把既有的 `aw-skill-merger` 行归一成框架内置件
// （`owner=__system__` / `public` / `builtin=true`）。这个写入不改名字、不改 body、
// 不改任何"内容"——所以它此前既不推 `updatedAt` 也不推 `aclRevision`。
//
// 但它**彻底改变了这一行导出出来是什么**：
//   · 归一前：普通资源 ⇒ 包里有一条 `agent-create` op，导入方会**创建一个新 agent**；
//   · 归一后：框架内置件 ⇒ 不产 op、只进 `manifest.builtins`，导入方**自动忽略**并
//     绑到自己那一个。
//
// 于是在 exact-revision fence 眼里，这两次导出「是同一个版本」——用户拿着页面上看到的
// token 点导出，拿回一个语义完全不同的包，而 fence 一声不响。Codex 实测
// `sameStaleFenceAccepted: true`。
//
// **反过来的要求同样重要**：`seedFusionResources` 每次启动都跑。无条件推进 token 会让
// 每次重启都作废所有在途 fence——那等于把一个安全机制变成噪音源，用户学会的第一件事
// 就是忽略 409。所以只在**真的发生归一**时推进，稳态重启必须逐字不变。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, users } from '../src/db/schema'
import { seedFusionResources } from '../src/services/fusion'
import { expectTokenOf } from '../src/services/resourcePackage/preview'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const agentRow = (db: DbClient, name: string): Record<string, unknown> | undefined =>
  db.select().from(agents).where(eq(agents.name, name)).all()[0] as
    | Record<string, unknown>
    | undefined

async function freshDb(): Promise<DbClient> {
  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'U1',
    role: 'admin',
    status: 'active',
    passwordHash: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as never)
  return db
}

describe('AC-12 · built-in 归一改变导出语义 ⇒ 必须推进 token', () => {
  test('把一行归一成 built-in ⇒ exact-revision token 变化（旧 fence 不再对得上）', async () => {
    const db = await freshDb()
    // 第一次 seed：建出这一行（此时它已经是 built-in）。
    await seedFusionResources(db)
    const seeded = agentRow(db, 'aw-skill-merger')
    expect(seeded?.builtin).toBe(true)

    // 人为把它退回「普通用户资源」的形态，模拟一个待归一的存量库。
    await db
      .update(agents)
      .set({ ownerUserId: 'u1', visibility: 'private', builtin: false } as never)
      .where(eq(agents.id, String(seeded?.id)))

    const beforeRow = agentRow(db, 'aw-skill-merger')!
    const beforeToken = expectTokenOf('agent', beforeRow)

    // 再次 seed ⇒ 触发归一。
    await seedFusionResources(db)

    const afterRow = agentRow(db, 'aw-skill-merger')!
    expect(afterRow.builtin).toBe(true)
    expect(afterRow.ownerUserId).toBe('__system__')

    // 核心断言：token 必须变。它变了，拿着 beforeToken 的导出请求才会 409，
    // 而不是静默拿回一个「自动忽略」语义的包。
    expect(expectTokenOf('agent', afterRow)).not.toEqual(beforeToken)
    expect(Number(afterRow.aclRevision)).toBeGreaterThan(Number(beforeRow.aclRevision))
  })

  test('**稳态重启逐字不变** —— 没发生归一就不许动 token', async () => {
    // 这条是上一条的必要配平。`seedFusionResources` 每次启动都跑；如果它无条件推进
    // token，那么「重启一次服务」就会作废所有在途 fence，409 从信号退化成噪音。
    const db = await freshDb()
    await seedFusionResources(db)
    const first = agentRow(db, 'aw-skill-merger')!
    const firstToken = expectTokenOf('agent', first)

    await seedFusionResources(db)
    await seedFusionResources(db)

    const third = agentRow(db, 'aw-skill-merger')!
    expect(expectTokenOf('agent', third)).toEqual(firstToken)
    expect(third.updatedAt).toEqual(first.updatedAt)
    expect(third.aclRevision).toEqual(first.aclRevision)
  })
})
