// RFC-271 T12 / RFC-345 —— MCP exact application 的 owner 围栏。
//
// 这是 RFC 设计期定位到的一条**真实越权面**，不是假想题：
//
//   历史裸 `commitMcpUpdateInTx` 只校验 `expectedConfigHash`、不校验 owner。
//   RFC-345 删除该 service 原语后，所有 active CRUD 都必须经过 Resource Catalog
//   application：持 stable-id lock 后 reload，再用 exact admitted authority 授权。
//
//   攻击形态：拿一个**他人的 public MCP** 的 id（public ⇒ 攻击者看得见，也能读到
//   它的当前 config，从而算出正确的 hash），伪造一次「overwrite」。hash 对得上、
//   行存在 ⇒ 旧实现照写不误 —— 别人那一行的内容被改写。
//
// 要害是概念区分：**hash 不是授权**。它只证明「我读到的是这一版」，不证明「我有
// 权改它」。两件事必须各有各的判据。

import { describe, expect, test } from 'bun:test'
import { buildActor } from '../src/auth/actor'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { mcps } from '../src/db/schema'
import { AuthorityClaimRegistry } from '../src/modules/identity-access/application/operationContext'
import { composeMcpCatalog } from '../src/modules/resource-catalog/composition/mcpOperations'
import type { McpCatalogModule } from '../src/modules/resource-catalog/public/operations'
import type { McpOperationContext } from '../src/modules/resource-catalog/public/participants'
import { ResourceOperationCoordinator } from '../src/services/resourceOperationCoordinator'
import {
  createMcpForTest as createMcp,
  type McpCatalogTestBinding as McpServiceBinding,
} from './helpers/mcpServiceBinding'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const VICTIM = 'u-victim'
const ATTACKER = 'u-attacker'

function authorityFor(userId: string): McpOperationContext {
  const projection = buildActor({
    user: { id: userId, username: userId, displayName: userId, role: 'user', status: 'active' },
    source: 'session',
  })
  return new AuthorityClaimRegistry().mintDirectAuthority(
    { userId, source: 'session' },
    { ...projection, userId },
  ).actor
}

function composeTestMcpCatalog(db: DbClient): McpCatalogModule {
  return composeMcpCatalog({
    db,
    coordinator: new ResourceOperationCoordinator(),
    nextMutationTimestamp: async (mcp) => mcp.updatedAt + 1,
    runtime: Object.freeze({
      prepareDelete: async () => undefined,
      reconcileDurableIntents: async () => undefined,
    }),
    transitionMutationInTx: () => undefined,
    deletePreparedInTx: () => undefined,
  })
}

function bindingFor(catalog: McpCatalogModule, userId: string): McpServiceBinding {
  return Object.freeze({ catalog, authority: authorityFor(userId) })
}

async function seedVictimPublicMcp(db: DbClient, victim: McpServiceBinding): Promise<string> {
  const created = await createMcp(victim, {
    name: 'shared-tools',
    description: 'victim owns this',
    type: 'remote',
    config: { url: 'https://example.test/mcp' },
    enabled: true,
  })
  // public ⇒ 攻击者看得见它、读得到 config、算得出 hash。
  await db.update(mcps).set({ visibility: 'public' }).where(eq(mcps.id, created.id)).run()
  return created.id
}

describe('伪造 overwrite：他人 public 资源 id + 正确 hash', () => {
  test('exact application reload + owner 围栏 ⇒ 拒绝，受害者那一行不变', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const catalog = composeTestMcpCatalog(db)
    const victim = bindingFor(catalog, VICTIM)
    const attacker = bindingFor(catalog, ATTACKER)
    const id = await seedVictimPublicMcp(db, victim)
    const before = await catalog.queries.get(attacker.authority, { id })
    // 攻击者能读到当前 config，于是能算出**正确**的 hash。
    const correctHash = before!.operationConfigHash

    await expect(
      catalog.operations.update.invoke(attacker.authority, {
        id,
        update: {
          description: 'pwned',
          config: { url: 'https://evil.test/mcp' },
          expectedConfigHash: correctHash,
        },
      }),
    ).rejects.toThrow()

    const after = await catalog.queries.get(victim.authority, { id })
    expect(after?.description).toBe(before?.description)
    expect(after?.config).toEqual(before?.config)
  })

  test('**对照组**：owner 的同一 exact command 正常成功', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const catalog = composeTestMcpCatalog(db)
    const victim = bindingFor(catalog, VICTIM)
    const id = await seedVictimPublicMcp(db, victim)
    const before = await catalog.queries.get(victim.authority, { id })

    await catalog.operations.update.invoke(victim.authority, {
      id,
      update: {
        description: 'owner edit',
        expectedConfigHash: before!.operationConfigHash,
      },
    })
    const after = await catalog.queries.get(victim.authority, { id })
    expect(after?.description).toBe('owner edit')
  })
})

describe('围栏的另一面：读取之后、提交之前的 owner 转移', () => {
  test('读取时看到 VICTIM，提交前行被转给别人 ⇒ fresh reload 后拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const catalog = composeTestMcpCatalog(db)
    const victim = bindingFor(catalog, VICTIM)
    const id = await seedVictimPublicMcp(db, victim)
    const before = await catalog.queries.get(victim.authority, { id })
    // 竞态窗口里发生了 owner 转移。
    await db.update(mcps).set({ ownerUserId: 'u-new-owner' }).where(eq(mcps.id, id)).run()

    await expect(
      catalog.operations.update.invoke(victim.authority, {
        id,
        update: {
          description: 'stale authorization',
          expectedConfigHash: before!.operationConfigHash,
        },
      }),
    ).rejects.toThrow()
    const newOwner = bindingFor(catalog, 'u-new-owner')
    expect((await catalog.queries.get(newOwner.authority, { id }))?.description).toBe(
      'victim owns this',
    )
  })

  test('owner 没变 ⇒ 正常放行（围栏不误伤）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const catalog = composeTestMcpCatalog(db)
    const victim = bindingFor(catalog, VICTIM)
    const id = await seedVictimPublicMcp(db, victim)
    const before = await catalog.queries.get(victim.authority, { id })
    await catalog.operations.update.invoke(victim.authority, {
      id,
      update: {
        description: 'owner edits own row',
        expectedConfigHash: before!.operationConfigHash,
      },
    })
    expect((await catalog.queries.get(victim.authority, { id }))?.description).toBe(
      'owner edits own row',
    )
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
