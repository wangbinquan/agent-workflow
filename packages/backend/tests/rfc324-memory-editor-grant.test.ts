// RFC-324 D9 —— 记忆管理权跟随资源的**写权**，而写权现在有两档。
//
// `canManageMemory` 的判据一直是「随 scope 资源的写权」（RFC-099 D12）。RFC-324 之
// 前那句话的实际含义是「owner 或 ACL bypass」，因为写权只有那一种。分档之后，用户
// 明确裁定（D9）：**能改这个 agent / workflow 的人，也能管它名下的记忆**——否则
// 「可编辑授权」会在记忆面留下一个说不清的缺口：内容改得动，与内容配套的记忆改不动。
//
// 本文件锁 AC-11 的三侧：write 档可管、read 档不可管、repo/global 分支逐字不变。
//
// 红→绿对：把 `services/memory.ts` 的 `canEditResource` 换回 `canGovernResource`，
// 「write 档可管」立刻红。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, resourceGrants, workflows } from '../src/db/schema'
import { canManageMemory, canViewMemory } from '../src/services/memory'
import { createUser } from '../src/services/users'
import { resourceScopeAuthority } from './helpers/resourceScopeAuthority'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

function actorFor(id: string, role: 'user' | 'manager' = 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-4)}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}

describe('RFC-324 D9 —— 记忆管理权随资源写权分档', () => {
  let db: DbClient
  let owner = ''
  let reader = ''
  let editor = ''
  let manager = ''
  const agentId = ulid()
  const workflowId = ulid()

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    const mk = async (username: string, role: 'user' | 'manager'): Promise<string> =>
      (
        await createUser(db, {
          username,
          displayName: username,
          role,
          password: 'pw12345678',
        })
      ).id
    owner = await mk('owner', 'user')
    reader = await mk('reader', 'user')
    editor = await mk('editor', 'user')
    manager = await mk('manager', 'manager')

    await db.insert(agents).values({
      id: agentId,
      name: `rfc324-agent-${agentId.slice(-6)}`,
      description: '',
      ownerUserId: owner,
      visibility: 'private',
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(workflows).values({
      id: workflowId,
      name: `rfc324-wf-${workflowId.slice(-6)}`,
      description: '',
      definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
      version: 1,
      ownerUserId: owner,
      visibility: 'private',
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(resourceGrants).values([
      {
        resourceType: 'agent',
        resourceId: agentId,
        userId: reader,
        level: 'read',
        addedBy: owner,
        addedAt: NOW,
      },
      {
        resourceType: 'agent',
        resourceId: agentId,
        userId: editor,
        level: 'write',
        addedBy: owner,
        addedAt: NOW,
      },
      {
        resourceType: 'workflow',
        resourceId: workflowId,
        userId: editor,
        level: 'write',
        addedBy: owner,
        addedAt: NOW,
      },
    ])
  })

  const agentScope = { scopeType: 'agent' as const, scopeId: agentId }
  const workflowScope = { scopeType: 'workflow' as const, scopeId: workflowId }
  const authorityFor = (id: string, role: 'user' | 'manager' = 'user') =>
    resourceScopeAuthority(db, actorFor(id, role))

  test('前提复核：两档被授权者都看得见这个 agent 的记忆（否则下面测的不是写权）', async () => {
    expect(await canViewMemory(db, authorityFor(reader), agentScope)).toBe(true)
    expect(await canViewMemory(db, authorityFor(editor), agentScope)).toBe(true)
  })

  test('write 档：可管 agent / workflow scope 的记忆（D9）', async () => {
    expect(await canManageMemory(db, authorityFor(editor), agentScope)).toBe(true)
    expect(await canManageMemory(db, authorityFor(editor), workflowScope)).toBe(true)
  })

  test('read 档：看得见但管不了', async () => {
    expect(await canManageMemory(db, authorityFor(reader), agentScope)).toBe(false)
  })

  test('owner 与 ACL bypass 照旧可管（分档不得动摇既有两条入口）', async () => {
    expect(await canManageMemory(db, authorityFor(owner), agentScope)).toBe(true)
    expect(await canManageMemory(db, authorityFor(manager, 'manager'), agentScope)).toBe(true)
  })

  test('repo / repo_group / global scope 逐字不变：仍只有 ACL bypass 可管', async () => {
    for (const scope of [
      { scopeType: 'repo' as const, scopeId: 'repo-1' },
      { scopeType: 'repo_group' as const, scopeId: 'group-1' },
      { scopeType: 'global' as const, scopeId: null },
    ]) {
      expect(
        await canManageMemory(db, authorityFor(editor), scope),
        `${scope.scopeType}：write 档不越界`,
      ).toBe(false)
      expect(
        await canManageMemory(db, authorityFor(owner), scope),
        `${scope.scopeType}：owner 也不例外`,
      ).toBe(false)
      expect(
        await canManageMemory(db, authorityFor(manager, 'manager'), scope),
        `${scope.scopeType}：bypass 仍是唯一入口`,
      ).toBe(true)
    }
  })
})
