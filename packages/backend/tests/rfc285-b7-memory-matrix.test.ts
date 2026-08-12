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

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents } from '../src/db/schema'
import { canManageMemory, canViewMemory } from '../src/services/memory'

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

describe('RFC-285 B7 — 现状矩阵（读面）', () => {
  test('repo / repo_group / global：全员可读（含普通 user；Q3 锁 RFC-248 AC-29）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    for (const scopeType of ['repo', 'repo_group', 'global'] as const) {
      for (const role of ['admin', 'manager', 'user'] as const) {
        expect(await canViewMemory(db, actorOfRole(role), { scopeType, scopeId: 's1' })).toBe(true)
      }
    }
  })

  test('资源 scope（agent）：随资源可见性——owner 可读、外人不可读、资源管理员全读', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = actorOfRole('user', 'u_owner')
    const stranger = actorOfRole('user', 'u_stranger')
    const agentId = await seedAgent(db, owner.user.id)
    const scope = { scopeType: 'agent' as const, scopeId: agentId }
    expect(await canViewMemory(db, owner, scope)).toBe(true)
    expect(await canViewMemory(db, stranger, scope)).toBe(false)
    expect(await canViewMemory(db, actorOfRole('admin'), scope)).toBe(true)
    expect(await canViewMemory(db, actorOfRole('manager'), scope)).toBe(true)
  })

  test('资源 scope 资源行消失：非管理员 fail-closed、管理员保留（清理面）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const scope = { scopeType: 'agent' as const, scopeId: 'agt_vanished' }
    expect(await canViewMemory(db, actorOfRole('user'), scope)).toBe(false)
    expect(await canViewMemory(db, actorOfRole('admin'), scope)).toBe(true)
  })
})

describe('RFC-285 B7 — 现状矩阵（管理面）', () => {
  test('repo / repo_group / global：admin+manager 可管（isResourceAdminActor 兜底）、普通 user 不可', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    for (const scopeType of ['repo', 'repo_group', 'global'] as const) {
      const scope = { scopeType, scopeId: 's1' }
      expect(await canManageMemory(db, actorOfRole('admin'), scope)).toBe(true)
      expect(await canManageMemory(db, actorOfRole('manager'), scope)).toBe(true)
      expect(await canManageMemory(db, actorOfRole('user'), scope)).toBe(false)
    }
  })

  test('资源 scope：资源 owner 可管、可见非 owner 不可管、admin+manager 兜底', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = actorOfRole('user', 'u_owner')
    const stranger = actorOfRole('user', 'u_stranger')
    const agentId = await seedAgent(db, owner.user.id)
    const scope = { scopeType: 'agent' as const, scopeId: agentId }
    expect(await canManageMemory(db, owner, scope)).toBe(true)
    expect(await canManageMemory(db, stranger, scope)).toBe(false)
    expect(await canManageMemory(db, actorOfRole('manager'), scope)).toBe(true)
  })
})
