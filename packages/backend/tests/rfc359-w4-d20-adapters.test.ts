// RFC-359 W4-D20 —— 两对对称适配器合一：Intent 上下文的资源身份 / 授权读取，与资源包的 owner-name 查找 +
// 预览 / 导出读模型。两者此前 SQLite / PG 各一份；SQLite 的那份 Intent 异步工厂**零生产消费**（两个
// SQLite bootstrap 用的都是同步变体），资源包那份另带两个零消费导出。
//
// 同一段断言在两个引擎上各跑一遍：身份读取按资源类型走 ACL 表、授权等级按 (type,id,user) 精确命中、
// owner+name 查找只回自己的、读模型按 id / name 取快照并只回活跃用户；附源码锁。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CreateAgentSchema } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, resourceGrants, users } from '@/db/schema'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { createIntentContextResourceAuthorizationReadPort } from '@/modules/resource-catalog/infrastructure/intentContextResourceAuthorization'
import {
  createResourcePackageOwnedResourceLookup,
  createResourcePackageReadPort,
} from '@/modules/resource-catalog/infrastructure/packageResourceRows'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

async function seedUser(
  db: ProviderNeutralDatabase,
  status: 'active' | 'disabled' = 'active',
): Promise<{ id: string; username: string }> {
  const id = ulid()
  const username = `u-${id.slice(-8).toLowerCase()}`
  await db.insert(users).values({
    id,
    username,
    displayName: username,
    role: 'user',
    status,
    createdAt: T0,
    updatedAt: T0,
  })
  return { id, username }
}

async function seedAgent(
  db: ProviderNeutralDatabase,
  input: { readonly ownerUserId: string; readonly name: string },
): Promise<string> {
  const id = ulid()
  await db.insert(agents).values(
    createAgentPersistenceValues({
      id,
      agent: CreateAgentSchema.parse({ name: input.name }),
      ownerUserId: input.ownerUserId,
      now: T0,
    }),
  )
  return id
}

describeEachProvider('RFC-359 W4-D20 —— Intent 上下文授权读取与资源包读模型', (harness) => {
  test('Intent 上下文：按资源类型读身份行；授权等级按 (类型, 资源, 用户) 精确命中', async () => {
    const owner = await seedUser(harness.db)
    const viewer = await seedUser(harness.db)
    const name = `agent-${ulid().slice(-6).toLowerCase()}`
    const agentId = await seedAgent(harness.db, { ownerUserId: owner.id, name })
    await harness.db.insert(resourceGrants).values({
      resourceType: 'agent',
      resourceId: agentId,
      userId: viewer.id,
      addedBy: owner.id,
      addedAt: T0,
      level: 'write',
    })

    const identity = await harness.session.transaction((tx) =>
      createIntentContextResourceAuthorizationReadPort(tx).loadIdentity('agent', agentId),
    )
    expect(identity).toEqual({
      resourceType: 'agent',
      resourceId: agentId,
      name,
      ownerUserId: owner.id,
      visibility: 'private',
    })
    expect(
      await harness.session.transaction((tx) =>
        createIntentContextResourceAuthorizationReadPort(tx).loadIdentity('agent', 'missing'),
      ),
    ).toBeNull()

    const port = (tx: Parameters<typeof createIntentContextResourceAuthorizationReadPort>[0]) =>
      createIntentContextResourceAuthorizationReadPort(tx)
    expect(
      await harness.session.transaction((tx) =>
        port(tx).loadGrantLevel('agent', agentId, viewer.id),
      ),
    ).toBe('write')
    // 授权是按 (类型, 资源, 用户) 三元组存的：换任一维都不该命中。
    expect(
      await harness.session.transaction((tx) =>
        port(tx).loadGrantLevel('agent', agentId, owner.id),
      ),
    ).toBeNull()
    expect(
      await harness.session.transaction((tx) =>
        port(tx).loadGrantLevel('workflow', agentId, viewer.id),
      ),
    ).toBeNull()
  })

  test('资源包：owner + name 查找只回自己的；读模型按 id / name 取快照', async () => {
    const owner = await seedUser(harness.db)
    const other = await seedUser(harness.db)
    const name = `agent-${ulid().slice(-6).toLowerCase()}`
    const mine = await seedAgent(harness.db, { ownerUserId: owner.id, name })
    await seedAgent(harness.db, { ownerUserId: other.id, name })

    const lookup = createResourcePackageOwnedResourceLookup(harness.db)
    expect(await lookup.findOwnedIdsByName({ kind: 'agent', ownerUserId: owner.id, name })).toEqual(
      [mine],
    )
    expect(
      await lookup.findOwnedIdsByName({ kind: 'agent', ownerUserId: owner.id, name: 'no-such' }),
    ).toEqual([])

    const reads = createResourcePackageReadPort(harness.db)
    const byId = await reads.listByIds('agent', [mine])
    expect(byId).toHaveLength(1)
    expect(byId[0]).toMatchObject({
      type: 'agent',
      id: mine,
      name,
      ownerUserId: owner.id,
      visibility: 'private',
    })
    expect(typeof byId[0]?.document).toBe('string')
    expect((await reads.getById('agent', mine))?.id).toBe(mine)
    expect(await reads.getById('agent', 'missing')).toBeUndefined()
    // 同名两行分属两位 owner：按 name 取回两条，且按 id 排序稳定。
    const byName = await reads.listByNames('agent', [name], { orderById: true })
    expect(byName.map((row) => row.id).sort()).toEqual(byName.map((row) => row.id))
    expect(byName).toHaveLength(2)
  })

  test('资源包：按用户名只回活跃用户', async () => {
    const active = await seedUser(harness.db)
    const disabled = await seedUser(harness.db, 'disabled')
    const reads = createResourcePackageReadPort(harness.db)
    expect(
      await reads.findActiveUsersByUsername([active.username, disabled.username, 'nobody']),
    ).toEqual([{ username: active.username, userId: active.id }])
    expect(await reads.findActiveUsersByUsername([])).toEqual([])
  })
})

test('源码锁：两对适配器没有 provider 命名的孪生，SQLite 命名的那个只剩 legacy 提交路径的同步助手', () => {
  const root = join(import.meta.dir, '..', 'src', 'modules', 'resource-catalog')
  for (const retired of [
    'infrastructure/postgresqlPackageResourceRows.ts',
    'infrastructure/sqliteIntentContextResourceAuthorization.ts',
    'infrastructure/postgresqlIntentContextResourceAuthorization.ts',
  ]) {
    expect(existsSync(join(root, retired)), retired).toBe(false)
  }
  for (const neutral of [
    'infrastructure/packageResourceRows.ts',
    'infrastructure/intentContextResourceAuthorization.ts',
  ]) {
    const source = readFileSync(join(root, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n')
    expect(source, neutral).not.toMatch(/PostgresqlDatabaseClient|createSqlite|createPostgresql/)
  }
  // 同步助手仍在，但只服务 legacy 提交路径；两个零消费导出已删。
  const legacyRows = readFileSync(join(root, 'infrastructure/sqlitePackageResourceRows.ts'), 'utf8')
  expect(legacyRows).toContain('getSqlitePackageResourceRowInTx')
  expect(legacyRows).not.toMatch(
    /listSqlitePackageResourceRowsByIds|listSqlitePackageResourceRowsByNames|createSqliteResourcePackageReadPort|createSqliteResourcePackageOwnedResourceLookup/,
  )
})
