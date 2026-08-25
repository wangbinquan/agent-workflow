// RFC-324 —— `/acl` 端点的线上契约。
//
// 锁 proposal.md §7 的 AC-5 / AC-6 与 §6 的 I4：
//   - 响应用 `grants`（每项带 level）替换了裸 `users`，并新增 `canEdit`；
//   - 请求用 `grants` 替换了 `userIds`，**旧字段被删除而不是保留**——这个端点
//     `tokenAccess: 'never'`，没有 PAT 可能在调它，留一个并存字段只会让
//     「{userIds, grants} 同时出现时听谁的」变成每次请求都要回答的问题；
//   - 转移 owner 后前任落 `read` 档（与 RFC-324 之前「转移后前任只剩一条 grant」
//     的实际权限逐字相同；给他 `write` 会让一次转移悄悄多发一份编辑权）；
//   - `aclRevision` CAS 照旧，且**档位变更也走它**——否则一个停在编辑态的面板
//     可以把已经降档的人重新升回去。
//
// AC-16（bypass 判定不变）的完整证明在 rfc324-access-policy-equivalence 的穷举里；
// 这里补一条 HTTP 层的对照，确认那条纯函数结论真的接到了端点上。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

interface Principal {
  id: string
  token: string
}

interface AclBody {
  ownerUserId: string | null
  visibility: 'private' | 'public'
  grants: Array<{ user: { id: string }; level: 'read' | 'write' }>
  canManage: boolean
  canEdit: boolean
  aclRevision: number
}

interface Harness {
  db: DbClient
  app: Hono
  owner: Principal
  alice: Principal
  bob: Principal
  manager: Principal
  agentId: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc324-wire-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const mk = async (username: string, role: 'user' | 'manager'): Promise<Principal> => {
    const user = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: user.id })
    return { id: user.id, token }
  }
  const owner = await mk('owner', 'user')
  const agentId = ulid()
  await db
    .insert(agents)
    .values({
      id: agentId,
      name: `rfc324-wire-${agentId.slice(-6)}`,
      description: 'seeded',
      ownerUserId: owner.id,
      visibility: 'private',
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  return {
    db,
    app,
    owner,
    alice: await mk('alice', 'user'),
    bob: await mk('bob', 'user'),
    manager: await mk('boss', 'manager'),
    agentId,
  }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

async function readAcl(h: Harness, token: string): Promise<AclBody> {
  const res = await req(h.app, token, `/api/agents/${h.agentId}/acl`)
  expect(res.status).toBe(200)
  return (await res.json()) as AclBody
}

async function putAcl(h: Harness, token: string, body: unknown): Promise<Response> {
  return req(h.app, token, `/api/agents/${h.agentId}/acl`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

describe('RFC-324 —— /acl 契约', () => {
  test('GET：grants 带档位；canManage 与 canEdit 是两个独立的答案', async () => {
    const h = await buildHarness()
    const put = await putAcl(h, h.owner.token, {
      grants: [
        { userId: h.alice.id, level: 'read' },
        { userId: h.bob.id, level: 'write' },
      ],
      expectedResourceId: h.agentId,
      expectedAclRevision: 0,
    })
    expect(put.status).toBe(200)

    const asOwner = await readAcl(h, h.owner.token)
    expect(asOwner.grants.map((g) => [g.user.id, g.level]).sort()).toEqual(
      [
        [h.alice.id, 'read'],
        [h.bob.id, 'write'],
      ].sort(),
    )
    expect(asOwner).not.toHaveProperty('users') // 旧字段被删除，不是并存
    expect(asOwner.canManage).toBe(true)
    expect(asOwner.canEdit).toBe(true)

    const asReader = await readAcl(h, h.alice.token)
    expect(asReader.canEdit, 'read 档改不动内容').toBe(false)
    expect(asReader.canManage, 'read 档更改不动授权').toBe(false)

    const asEditor = await readAcl(h, h.bob.token)
    expect(asEditor.canEdit, 'write 档能改内容').toBe(true)
    expect(asEditor.canManage, '但改不了授权——这正是两个字段分开的意义').toBe(false)
  })

  test('PUT：grants 是全量替换，未列出的人被撤销', async () => {
    const h = await buildHarness()
    await putAcl(h, h.owner.token, {
      grants: [
        { userId: h.alice.id, level: 'write' },
        { userId: h.bob.id, level: 'write' },
      ],
      expectedResourceId: h.agentId,
      expectedAclRevision: 0,
    })
    const afterFirst = await readAcl(h, h.owner.token)
    expect(afterFirst.grants.length).toBe(2)

    await putAcl(h, h.owner.token, {
      grants: [{ userId: h.alice.id, level: 'read' }],
      expectedResourceId: h.agentId,
      expectedAclRevision: afterFirst.aclRevision,
    })
    const afterSecond = await readAcl(h, h.owner.token)
    expect(afterSecond.grants.map((g) => [g.user.id, g.level])).toEqual([[h.alice.id, 'read']])
    expect(
      await readAcl(h, h.bob.token).catch(() => null),
      'bob 被撤销后连 ACL 都读不到',
    ).toBeNull()
  })

  test('降档立刻生效：write → read 之后，本人读回的 canEdit 就是 false', async () => {
    const h = await buildHarness()
    await putAcl(h, h.owner.token, {
      grants: [{ userId: h.alice.id, level: 'write' }],
      expectedResourceId: h.agentId,
      expectedAclRevision: 0,
    })
    expect((await readAcl(h, h.alice.token)).canEdit).toBe(true)

    const current = await readAcl(h, h.owner.token)
    await putAcl(h, h.owner.token, {
      grants: [{ userId: h.alice.id, level: 'read' }],
      expectedResourceId: h.agentId,
      expectedAclRevision: current.aclRevision,
    })
    expect((await readAcl(h, h.alice.token)).canEdit, '降档不能只改数据库不改判定').toBe(false)
  })

  test('AC-5 转移 owner：前任自动落 read 档，不是 write', async () => {
    const h = await buildHarness()
    const before = await readAcl(h, h.owner.token)
    const res = await putAcl(h, h.owner.token, {
      ownerUserId: h.alice.id,
      expectedResourceId: h.agentId,
      expectedAclRevision: before.aclRevision,
    })
    expect(res.status).toBe(200)

    const after = (await res.json()) as AclBody
    expect(after.ownerUserId).toBe(h.alice.id)
    const previous = after.grants.find((g) => g.user.id === h.owner.id)
    expect(previous, '前任 owner 必须留在名单里，否则他会把自己锁在外面').toBeDefined()
    expect(previous!.level, '转移不该顺带发一份编辑权——那是新 owner 的决定').toBe('read')
  })

  test('AC-6 档位变更也走 aclRevision CAS：陈旧请求 409', async () => {
    const h = await buildHarness()
    const base = await readAcl(h, h.owner.token)
    const first = await putAcl(h, h.owner.token, {
      grants: [{ userId: h.alice.id, level: 'read' }],
      expectedResourceId: h.agentId,
      expectedAclRevision: base.aclRevision,
    })
    expect(first.status).toBe(200)

    // 一个停在编辑态的面板拿着旧 revision 想把 alice 升成 write：必须被拒。
    const stale = await putAcl(h, h.owner.token, {
      grants: [{ userId: h.alice.id, level: 'write' }],
      expectedResourceId: h.agentId,
      expectedAclRevision: base.aclRevision,
    })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { code: string }).code).toBe('acl-revision-conflict')
    expect((await readAcl(h, h.alice.token)).canEdit, '被 CAS 拒绝的升档不得落库').toBe(false)
  })

  test('旧 wire 被删除：带 userIds 的请求是 422，不是"当作没写"', async () => {
    const h = await buildHarness()
    const res = await putAcl(h, h.owner.token, {
      userIds: [h.alice.id],
      expectedResourceId: h.agentId,
      expectedAclRevision: 0,
    })
    expect(res.status, '静默忽略比报错更糟：调用方以为授权成功了').toBe(422)
    expect((await readAcl(h, h.owner.token)).grants).toEqual([])
  })

  test('AC-16 bypass 判定不变：manager 对别人的私有资源仍是 canManage + canEdit', async () => {
    const h = await buildHarness()
    const asManager = await readAcl(h, h.manager.token)
    expect(asManager.canManage).toBe(true)
    expect(asManager.canEdit).toBe(true)
    // 且它不需要任何 grant 行——这正是「bypass 不受档位约束」的含义。
    expect(asManager.grants).toEqual([])
  })
})
