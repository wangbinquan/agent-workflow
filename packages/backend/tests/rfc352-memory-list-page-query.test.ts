// RFC-352 T8 —— 分页查询与全量查询的等价性（provider 侧集成）。
//
// 为什么这条测试存在：`/api/memories` 的分页是**加**出来的，不是把已有分页下推——
// 所以最大的风险不是「分页不工作」，而是「分页路径与全量路径悄悄给出不同的结果」：
// 两条路径各有一份过滤实现（标签在内存里判、可见性问 resource-catalog participant、
// 候选按 RFC-285 Q4 收窄），一旦顺序或判据不一致，用户翻页看到的集合就和不翻页时不同，
// 而这种差异在只测「翻页能翻」的用例里完全看不出来。
//
// 因此本文件的主断言是**等价性**：同一份数据、同一个调用者，逐页拼起来必须与全量逐条相同，
// 且分页项的字段集与全量项**逐字相同**（游标用的 `createdAt` 只活在内部，绝不能漏上 wire）。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, memories } from '../src/db/schema'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import { composeSqliteMemoryCatalogOperations } from '../src/modules/memory/composition'
import type { MemoryCatalogOperations } from '../src/modules/memory/public/catalog'
import { TEST_RESOURCE_SCOPE_AUTHORIZATION } from './helpers/resourceScopeAuthority'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actorOfRole(role: 'admin' | 'user', id = `u_${role}`): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

function catalogOf(db: DbClient): MemoryCatalogOperations {
  return composeSqliteMemoryCatalogOperations({
    db,
    contexts: composeIdentityAccess(db).contexts,
    authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
  })
}

function scopeAuthorityOf(db: DbClient, actor: Actor) {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return Object.freeze({ authority: context.authority, actor })
}

/** 造 n 条 global scope 的 approved 记忆；createdAt 递减，且**故意让部分同毫秒**。 */
async function seedGlobal(db: DbClient, n: number): Promise<void> {
  const base = 1_700_000_000_000
  for (let i = 0; i < n; i += 1) {
    await db.insert(memories).values({
      id: `m_${String(i).padStart(4, '0')}`,
      scopeType: 'global',
      scopeId: null,
      title: `memory ${i}`,
      bodyMd: `body ${i}`,
      status: 'approved',
      sourceKind: 'manual',
      tags: JSON.stringify(i % 3 === 0 ? ['alpha'] : ['beta']),
      version: 1,
      // 每 4 条共享同一毫秒——只按 createdAt 做游标必然漏行/重复。
      createdAt: base - Math.floor(i / 4),
    })
  }
}

describe('RFC-352 T8 — 分页与全量等价', () => {
  test('逐页拼起来 === 全量，顺序一致、不重不漏', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedGlobal(db, 37)
    const catalog = catalogOf(db)
    const authority = scopeAuthorityOf(db, actorOfRole('admin'))

    const full = await catalog.queries.list({ status: 'approved' })
    const paged: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 30; guard += 1) {
      const page: Awaited<ReturnType<typeof catalog.queries.listPage>> =
        await catalog.queries.listPage(
          authority,
          { status: 'approved' },
          { cursor, limit: 7 },
          { includeCandidates: true },
        )
      paged.push(...page.items.map((m) => m.id))
      cursor = page.nextCursor
      if (cursor === null) break
    }
    expect(cursor).toBeNull()
    expect(paged).toEqual(full.map((m) => m.id))
    expect(new Set(paged).size).toBe(paged.length)
  })

  test('分页项的字段集与全量项逐字相同（游标用的 createdAt 不上 wire）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedGlobal(db, 5)
    const catalog = catalogOf(db)
    const authority = scopeAuthorityOf(db, actorOfRole('admin'))

    const full = await catalog.queries.annotateManageRights(
      authority,
      await catalog.queries.list({ status: 'approved' }),
    )
    const page = await catalog.queries.listPage(
      authority,
      { status: 'approved' },
      { cursor: null, limit: 5 },
      { includeCandidates: true },
    )
    expect(page.items.length).toBe(full.length)
    const fullKeys = Object.keys(full[0]!).sort()
    const pageKeys = Object.keys(page.items[0]!).sort()
    expect(pageKeys).toEqual(fullKeys)
    expect(pageKeys).not.toContain('createdAt')
  })

  test('标签过滤在分页路径上与全量一致', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedGlobal(db, 20)
    const catalog = catalogOf(db)
    const authority = scopeAuthorityOf(db, actorOfRole('admin'))

    const filter = { status: 'approved' as const, tags: ['alpha'] }
    const full = await catalog.queries.list(filter)
    const collected: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard += 1) {
      const page: Awaited<ReturnType<typeof catalog.queries.listPage>> =
        await catalog.queries.listPage(
          authority,
          filter,
          { cursor, limit: 3 },
          { includeCandidates: true },
        )
      collected.push(...page.items.map((m) => m.id))
      cursor = page.nextCursor
      if (cursor === null) break
    }
    expect(collected).toEqual(full.map((m) => m.id))
    expect(collected.length).toBeGreaterThan(0)
  })

  test('候选收窄（RFC-285 Q4）在分页路径上照样生效', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(memories).values({
      id: 'm_candidate',
      scopeType: 'global',
      scopeId: null,
      title: 'candidate',
      bodyMd: 'body',
      status: 'candidate',
      sourceKind: 'clarify',
      tags: '[]',
      version: 1,
      createdAt: 1_700_000_000_000,
    })
    const catalog = catalogOf(db)
    const authority = scopeAuthorityOf(db, actorOfRole('user'))

    const withCandidates = await catalog.queries.listPage(
      authority,
      {},
      { cursor: null, limit: 10 },
      { includeCandidates: true },
    )
    const withoutCandidates = await catalog.queries.listPage(
      authority,
      {},
      { cursor: null, limit: 10 },
      { includeCandidates: false },
    )
    expect(withCandidates.items.map((m) => m.id)).toEqual(['m_candidate'])
    expect(withoutCandidates.items).toEqual([])
  })

  test('资源 scope 不可见的行不进页，且不因此让页「缺位」', async () => {
    // 外人看不见私有 agent 名下的记忆——分页必须把它们跳过去继续凑，而不是返回带空洞的一页。
    const db = createInMemoryDb(MIGRATIONS)
    const owner = actorOfRole('user', 'u_owner')
    await db.insert(agents).values({
      id: 'agt_private',
      name: 'private-agent',
      ownerUserId: owner.user.id,
      visibility: 'private',
    })
    const base = 1_700_000_000_000
    for (let i = 0; i < 12; i += 1) {
      await db.insert(memories).values({
        id: `m_${String(i).padStart(2, '0')}`,
        // 交替：一半挂私有 agent（外人不可见），一半 global（全员可读）
        scopeType: i % 2 === 0 ? 'agent' : 'global',
        scopeId: i % 2 === 0 ? 'agt_private' : null,
        title: `m ${i}`,
        bodyMd: 'body',
        status: 'approved',
        sourceKind: 'manual',
        tags: '[]',
        version: 1,
        createdAt: base - i,
      })
    }
    const catalog = catalogOf(db)
    const stranger = scopeAuthorityOf(db, actorOfRole('user', 'u_stranger'))

    const page = await catalog.queries.listPage(
      stranger,
      { status: 'approved' },
      { cursor: null, limit: 6 },
      { includeCandidates: false },
    )
    // 6 条 global 全部凑齐（跨过了穿插其间的 6 条不可见 agent 行）
    expect(page.items.length).toBe(6)
    expect(page.items.every((m) => m.scopeType === 'global')).toBe(true)
  })

  test('坏游标显式报错，不静默从头开始', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedGlobal(db, 3)
    const catalog = catalogOf(db)
    const authority = scopeAuthorityOf(db, actorOfRole('admin'))
    await expect(
      catalog.queries.listPage(
        authority,
        {},
        { cursor: 'not-a-cursor!!', limit: 5 },
        { includeCandidates: true },
      ),
    ).rejects.toThrow(/cursor/i)
  })
})
