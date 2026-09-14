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
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { mcps } from '../src/db/schema'
import { AuthorityClaimRegistry } from '../src/modules/identity-access/application/operationContext'
import { composeMcpCatalog } from '../src/modules/resource-catalog/composition/mcpOperations'
import { composeResourceCatalogFor } from '../src/modules/resource-catalog/composition/providerResourceCatalog'
import type { McpCatalogModule } from '../src/modules/resource-catalog/public/operations'
import type { McpOperationContext } from '../src/modules/resource-catalog/public/participants'
import { ResourceOperationCoordinator } from '../src/services/resourceOperationCoordinator'
import {
  createMcpForTest as createMcp,
  type McpCatalogTestBinding as McpServiceBinding,
} from './helpers/mcpServiceBinding'

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

function composeTestMcpCatalog(db: ProviderNeutralDatabase): McpCatalogModule {
  return composeMcpCatalog({
    db,
    coordinator: new ResourceOperationCoordinator(),
    nextMutationTimestamp: async (mcp) => mcp.updatedAt + 1,
    runtime: Object.freeze({
      prepareDelete: async () => undefined,
      reconcileDurableIntents: async () => undefined,
    }),
    lifecycle: Object.freeze({
      transitionMutation: async () => undefined,
      deletePrepared: async () => undefined,
    }),
    resourceCatalog: composeResourceCatalogFor({ db }),
  })
}

function bindingFor(catalog: McpCatalogModule, userId: string): McpServiceBinding {
  return Object.freeze({ catalog, authority: authorityFor(userId) })
}

async function seedVictimPublicMcp(
  db: ProviderNeutralDatabase,
  victim: McpServiceBinding,
): Promise<string> {
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

describeEachProvider('伪造 overwrite：他人 public 资源 id + 正确 hash', (harness) => {
  test('exact application reload + owner 围栏 ⇒ 拒绝，受害者那一行不变', async () => {
    const db = harness.db
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
    const db = harness.db
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

describeEachProvider('围栏的另一面：读取之后、提交之前的 owner 转移', (harness) => {
  test('读取时看到 VICTIM，提交前行被转给别人 ⇒ fresh reload 后拒绝', async () => {
    const db = harness.db
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
    const db = harness.db
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
  // RFC-359 —— 两台 apply 引擎合一，这条判据挪到**生产在用的那一份**上。
  //
  // 围栏的形态变了、挡的东西没变。合一之前 legacy 那份在 preflight 期读到行、把
  // `expectedOwnerUserId: existing.ownerUserId` 带进提交期，由 `commitLegacyMcpUpdateInTx`
  // 在事务里比对；现行这份**在事务里自己重读那一行**（`transaction.select().from(mcps)`），
  // 于是不需要把 owner 当参数带过去——重读拿到的就是提交那一刻的真值，比「带一个快照过去」
  // 更直接。两者挡的都是「授权之后 owner 变了」。
  //
  // 「在 intent 里改别人的资源」本身在更上游就被挡掉了（`application/resolveChangeset.ts` 的
  // `intent-foreign-modify-forbidden`：preflight 把非己有的目标标成 copy-only，只能复制一份），
  // 两个引擎同一条路——这里这道是提交期的同一件事再核一次。
  test('提交期在事务里重读 owner，而不是信任 preflight 时的快照', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'infrastructure',
        'aggregateAdapters',
        'postgresqlIntentApplyResourcePorts.ts',
      ),
      'utf8',
    )
    const reread = src.indexOf(
      'const row = await transaction.select().from(mcps).where(eq(mcps.id, plan.resourceId)).get()',
    )
    expect(reread, '语料失效：提交期那次重读一处都没扫到').toBeGreaterThanOrEqual(0)
    const fence = src.indexOf("requireOwner(actor, 'mcp', current)", reread)
    expect(fence, 'owner 核对必须在重读之后').toBeGreaterThan(reread)
    // 写回还带一道 `updatedAt` 的 CAS：重读与写回之间行又变了就落空。
    expect(src.indexOf('eq(mcps.updatedAt, current.updatedAt)', fence)).toBeGreaterThan(fence)
  })
})
