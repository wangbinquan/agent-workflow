// RFC-285 T9（B7）—— memory 权限现状矩阵回归锁（scope × 角色 × {读, 管理}）。
//
// 为什么这条测试存在：v1 曾把「repo/global 读面仍 admin-only」「manager 无管理
// 权」当成待修洞（E9/E10）——设计门对账发现**代码早已是目标态**（backlog 过期）。
// 本文件把 memory.ts:canViewMemory/canManageMemory 的现状语义拍死成矩阵，防
// 将来任何一格无声漂移（漂移必须来改这里=评审可见）。RFC-285 唯二真 delta
// 已另行落地：distill 详情门（B6④，先行会话已修，rfc285 逐锚复核确认）与
// candidate 读面收紧（Q4，routes/memories.ts，本批）。
//
// 语义单源：packages/backend/src/services/memory.ts canViewMemory / canManageMemory。
//
// RFC-352（RFC-294 W4-E2）把这份矩阵**升格为迁移 oracle**：memory 的授权谓词要从
// `modules/memory/infrastructure/sqliteMemoryCatalog.ts` 提到 application 层，并让
// SQLite / PostgreSQL 两个 provider 共用同一份纯策略（今天它们各写了一遍同样的级联：
// `sqliteMemoryCatalog.ts:1104` 与 `postgresqlMemoryCatalogOperations.ts:372`）。
// 迁移期间**这张表的每一格都不许变**——变了就是行为回归，必须先回来改这里。
// 为此本轮补齐了三块此前没覆盖的格子：workflow scope、RFC-324 D9 的 `write` 授权档、
// 以及 `annotateMemoryManageRights` 与 `canManageMemory` 之间既存的判据差。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, resourceGrants, users, workflows } from '../src/db/schema'
import { annotateMemoryManageRights, canManageMemory, canViewMemory } from '../src/services/memory'
import { resourceScopeAuthority } from './helpers/resourceScopeAuthority'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actorOfRole(role: 'admin' | 'manager' | 'user', id = `u_${role}`): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedAgent(db: DbClient, ownerUserId: string): Promise<string> {
  const id = 'agt_matrix'
  await db.insert(agents).values({
    id,
    name: 'matrix-agent',
    ownerUserId,
    visibility: 'private',
  })
  return id
}

async function seedWorkflow(db: DbClient, ownerUserId: string): Promise<string> {
  const id = 'wf_matrix'
  await db.insert(workflows).values({
    id,
    name: 'matrix-workflow',
    definition: '{"$schema_version":1,"nodes":[],"edges":[]}',
    ownerUserId,
    visibility: 'private',
  })
  return id
}

/** RFC-324 D9 的 `write` 授权档：被授权人不是 owner，但可以改内容。 */
async function seedWriteGrant(
  db: DbClient,
  resourceType: 'agent' | 'workflow',
  resourceId: string,
  userId: string,
  ownerId: string,
): Promise<void> {
  const now = Date.now()
  await db.insert(users).values({
    id: userId,
    username: userId,
    displayName: userId,
    role: 'user',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  await db.insert(resourceGrants).values({
    resourceType,
    resourceId,
    userId,
    addedBy: ownerId,
    addedAt: Date.now(),
    level: 'write',
  })
}

describe('RFC-285 B7 — 现状矩阵（读面）', () => {
  test('repo / repo_group / global：全员可读（含普通 user；Q3 锁 RFC-248 AC-29）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    for (const scopeType of ['repo', 'repo_group', 'global'] as const) {
      for (const role of ['admin', 'manager', 'user'] as const) {
        const actor = actorOfRole(role)
        expect(
          await canViewMemory(db, resourceScopeAuthority(db, actor), {
            scopeType,
            scopeId: 's1',
          }),
        ).toBe(true)
      }
    }
  })

  test('资源 scope（agent）：随资源可见性——owner 可读、外人不可读、资源管理员全读', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = actorOfRole('user', 'u_owner')
    const stranger = actorOfRole('user', 'u_stranger')
    const agentId = await seedAgent(db, owner.user.id)
    const scope = { scopeType: 'agent' as const, scopeId: agentId }
    expect(await canViewMemory(db, resourceScopeAuthority(db, owner), scope)).toBe(true)
    expect(await canViewMemory(db, resourceScopeAuthority(db, stranger), scope)).toBe(false)
    const admin = actorOfRole('admin')
    const manager = actorOfRole('manager')
    expect(await canViewMemory(db, resourceScopeAuthority(db, admin), scope)).toBe(true)
    expect(await canViewMemory(db, resourceScopeAuthority(db, manager), scope)).toBe(true)
  })

  test('资源 scope 资源行消失：非管理员 fail-closed、管理员保留（清理面）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const scope = { scopeType: 'agent' as const, scopeId: 'agt_vanished' }
    const user = actorOfRole('user')
    const admin = actorOfRole('admin')
    expect(await canViewMemory(db, resourceScopeAuthority(db, user), scope)).toBe(false)
    expect(await canViewMemory(db, resourceScopeAuthority(db, admin), scope)).toBe(true)
  })
})

describe('RFC-285 B7 — 现状矩阵（管理面）', () => {
  test('repo / repo_group / global：admin+manager 可管（hasResourceAclBypass 兜底）、普通 user 不可', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    for (const scopeType of ['repo', 'repo_group', 'global'] as const) {
      const scope = { scopeType, scopeId: 's1' }
      const admin = actorOfRole('admin')
      const manager = actorOfRole('manager')
      const user = actorOfRole('user')
      expect(await canManageMemory(db, resourceScopeAuthority(db, admin), scope)).toBe(true)
      expect(await canManageMemory(db, resourceScopeAuthority(db, manager), scope)).toBe(true)
      expect(await canManageMemory(db, resourceScopeAuthority(db, user), scope)).toBe(false)
    }
  })

  test('资源 scope：资源 owner 可管、可见非 owner 不可管、admin+manager 兜底', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = actorOfRole('user', 'u_owner')
    const stranger = actorOfRole('user', 'u_stranger')
    const agentId = await seedAgent(db, owner.user.id)
    const scope = { scopeType: 'agent' as const, scopeId: agentId }
    expect(await canManageMemory(db, resourceScopeAuthority(db, owner), scope)).toBe(true)
    expect(await canManageMemory(db, resourceScopeAuthority(db, stranger), scope)).toBe(false)
    const manager = actorOfRole('manager')
    expect(await canManageMemory(db, resourceScopeAuthority(db, manager), scope)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RFC-352 补格：迁移前必须先把 oracle 补全，否则搬完了也不知道哪一格漂了。
// ---------------------------------------------------------------------------

describe('RFC-352 W4-E2 迁移 oracle — 补齐的格子', () => {
  test('workflow scope 与 agent scope 同档：owner 可读可管、外人都不行、资源管理员兜底', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = actorOfRole('user', 'u_owner')
    const stranger = actorOfRole('user', 'u_stranger')
    const workflowId = await seedWorkflow(db, owner.user.id)
    const scope = { scopeType: 'workflow' as const, scopeId: workflowId }
    expect(await canViewMemory(db, resourceScopeAuthority(db, owner), scope)).toBe(true)
    expect(await canViewMemory(db, resourceScopeAuthority(db, stranger), scope)).toBe(false)
    expect(await canManageMemory(db, resourceScopeAuthority(db, owner), scope)).toBe(true)
    expect(await canManageMemory(db, resourceScopeAuthority(db, stranger), scope)).toBe(false)
    for (const role of ['admin', 'manager'] as const) {
      const bypass = actorOfRole(role)
      expect(await canViewMemory(db, resourceScopeAuthority(db, bypass), scope)).toBe(true)
      expect(await canManageMemory(db, resourceScopeAuthority(db, bypass), scope)).toBe(true)
    }
  })

  test('RFC-324 D9：`write` 授权档能管资源 scope 的记忆（不只是 owner）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = actorOfRole('user', 'u_owner')
    const writer = actorOfRole('user', 'u_writer')
    const agentId = await seedAgent(db, owner.user.id)
    await seedWriteGrant(db, 'agent', agentId, writer.user.id, owner.user.id)
    const scope = { scopeType: 'agent' as const, scopeId: agentId }
    expect(await canViewMemory(db, resourceScopeAuthority(db, writer), scope)).toBe(true)
    expect(await canManageMemory(db, resourceScopeAuthority(db, writer), scope)).toBe(true)
  })

  // 现状锁，不是背书：`annotateMemoryManageRights` 的判据停在 RFC-099 D12 的
  // 「只有 owner」，而 `canManageMemory` 在 RFC-324 D9 之后已经放宽到 `write|own`。
  // 于是拿到 `write` 授权的人：API 允许他管，但列表给他盖的 `canManage` 是 false
  // （前端据此不显示审批 / 编辑 / 归档按钮）。RFC-352 是结构迁移、不改行为，
  // 因此这里把这处**既存差异**锁住；要修它得单独立项并明确是产品行为变更。
  test('现状差异：write 授权者 canManageMemory=true，但列表 canManage 盖的是 false', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = actorOfRole('user', 'u_owner')
    const writer = actorOfRole('user', 'u_writer')
    const agentId = await seedAgent(db, owner.user.id)
    await seedWriteGrant(db, 'agent', agentId, writer.user.id, owner.user.id)
    const scope = { scopeType: 'agent' as const, scopeId: agentId }
    const authority = resourceScopeAuthority(db, writer)
    expect(await canManageMemory(db, authority, scope)).toBe(true)
    const [stamped] = await annotateMemoryManageRights(db, authority, [scope])
    expect(stamped?.canManage).toBe(false)
  })
})
