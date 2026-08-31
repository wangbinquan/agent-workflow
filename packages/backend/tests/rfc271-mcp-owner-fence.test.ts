// RFC-271 T12 —— `commitMcpUpdateInTx` 的**提交事务内 owner 围栏**。
//
// 这是 RFC 设计期定位到的一条**真实越权面**，不是假想题：
//
//   `commitMcpUpdateInTx` 此前只校验 `expectedConfigHash`，**从不校验 owner**——
//   owner 门只存在于路由层（`requireResourceOwner`）。对经路由的编辑没问题；但
//   任何**直接到达这条原语**的写路径都绕过了它。intent apply 是一条，配置包导入
//   将是第二条。
//
//   攻击形态：拿一个**他人的 public MCP** 的 id（public ⇒ 攻击者看得见，也能读到
//   它的当前 config，从而算出正确的 hash），伪造一次「overwrite」。hash 对得上、
//   行存在 ⇒ 旧实现照写不误 —— 别人那一行的内容被改写。
//
// 要害是概念区分：**hash 不是授权**。它只证明「我读到的是这一版」，不证明「我有
// 权改它」。两件事必须各有各的判据。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { mcps } from '../src/db/schema'
import { commitMcpUpdateInTx, createMcp, getMcpById } from '../src/services/mcp'
import { mcpOperationConfigHashOf } from '../src/services/mcpOperationRevision'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const VICTIM = 'u-victim'
const ATTACKER = 'u-attacker'

async function seedVictimPublicMcp(db: DbClient): Promise<string> {
  const created = await createMcp(
    db,
    {
      name: 'shared-tools',
      description: 'victim owns this',
      type: 'remote',
      config: { url: 'https://example.test/mcp' },
      enabled: true,
    } as never,
    { ownerUserId: VICTIM, actor: null },
  )
  // public ⇒ 攻击者看得见它、读得到 config、算得出 hash。
  await db.update(mcps).set({ visibility: 'public' }).where(eq(mcps.id, created.id)).run()
  return created.id
}

describe('伪造 overwrite：他人 public 资源 id + 正确 hash', () => {
  test('带 owner 围栏 ⇒ 事务内拒绝，受害者那一行**一个字节没变**', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedVictimPublicMcp(db)
    const before = await getMcpById(db, id)
    // 攻击者能读到当前 config，于是能算出**正确**的 hash。
    const correctHash = mcpOperationConfigHashOf(before!)

    expect(() =>
      dbTxSync(db, (tx) =>
        commitMcpUpdateInTx(tx, {
          id,
          set: { description: 'pwned', config: JSON.stringify({ url: 'https://evil.test/mcp' }) },
          expectedConfigHash: correctHash, // hash 是对的！
          expectedOwnerUserId: ATTACKER, // 但 owner 不是他
        }),
      ),
    ).toThrow()

    const after = await getMcpById(db, id)
    expect(after?.description).toBe(before?.description)
    expect(after?.config).toEqual(before?.config)
  })

  test('**对照组**：不传 owner 围栏时，同一次伪造会成功 —— 这就是修复前的行为', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedVictimPublicMcp(db)
    const before = await getMcpById(db, id)

    dbTxSync(db, (tx) =>
      commitMcpUpdateInTx(tx, {
        id,
        set: { description: 'pwned' },
        expectedConfigHash: mcpOperationConfigHashOf(before!),
        // 无 expectedOwnerUserId —— 既有调用方（updateMcp / 路由）的形态
      }),
    )
    const after = await getMcpById(db, id)
    // 这条**故意**断言旧行为：证明上一条的绿不是因为别的东西挡住了写入，而正是
    // 围栏在起作用。同时说明「缺席 = 不设围栏」对既有调用方逐字兼容。
    expect(after?.description).toBe('pwned')
  })
})

describe('围栏的另一面：授权之后、提交之前的 owner 转移', () => {
  test('授权时看到 VICTIM，提交前行被转给别人 ⇒ 拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedVictimPublicMcp(db)
    const authorizedOwner = VICTIM
    // 竞态窗口里发生了 owner 转移。
    await db.update(mcps).set({ ownerUserId: 'u-new-owner' }).where(eq(mcps.id, id)).run()

    expect(() =>
      dbTxSync(db, (tx) =>
        commitMcpUpdateInTx(tx, {
          id,
          set: { description: 'stale authorization' },
          expectedOwnerUserId: authorizedOwner,
        }),
      ),
    ).toThrow()
    expect((await getMcpById(db, id))?.description).toBe('victim owns this')
  })

  test('owner 没变 ⇒ 正常放行（围栏不误伤）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedVictimPublicMcp(db)
    dbTxSync(db, (tx) =>
      commitMcpUpdateInTx(tx, {
        id,
        set: { description: 'owner edits own row' },
        expectedOwnerUserId: VICTIM,
      }),
    )
    expect((await getMcpById(db, id))?.description).toBe('owner edits own row')
  })
})

describe('intent apply 的 MCP update 分支已经带上围栏（源码层）', () => {
  test('传的是「授权时看到的 owner」，不是 actor 自己', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'infrastructure',
        'aggregateAdapters',
        'legacyIntentApplyResourceParticipants.ts',
      ),
      'utf8',
    )
    // `existing` 是 preflight 期读到的那一行 —— 用它才能同时覆盖「伪造」与
    // 「授权后转移」两种情形；写死 actor.user.id 会把 admin 代改的合法场景也拦掉。
    expect(src).toContain('expectedOwnerUserId: existing.ownerUserId')
  })
})
