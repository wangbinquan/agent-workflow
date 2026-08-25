// RFC-324 —— 授权分档的行为矩阵（HTTP 面）。
//
// 锁的是本 RFC 的全部产品承诺，逐条对应 proposal.md §7：
//
//   AC-2  只读被授权人对写路由 403 `resource-read-only`（不是 404、不是裸 forbidden）
//   AC-3  可编辑被授权人过内容写门；治理写门仍 403 `resource-govern-owner-only`
//   AC-4  可编辑被授权人改名 403 `resource-rename-owner-only` 且零写入
//
// 两个被测资源是刻意选的，它们代表两种**结构**：
//   - agent：改名有独立路由，PUT body 不带 name ⇒ 内容/治理的边界在路由层就分开了；
//   - workflow：保存 body 里带 name（snapshot.name）⇒ 边界只能在写事务内画，
//     `assertNameUnchangedForEditor` 因此必须拿事务内的当前名字比对。
//
// 红→绿对：把 `routes/agents.ts` 的 PUT 换回 `requireResourceGovern`，可编辑档那组
// 立刻红；把 workflow 保存里的 `assertNameUnchangedForEditor` 删掉，改名那组立刻红。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, resourceGrants, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import type { ResourceGrantLevel } from '@agent-workflow/shared'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

interface Principal {
  id: string
  token: string
}

interface Harness {
  db: DbClient
  app: Hono
  owner: Principal
  reader: Principal
  editor: Principal
  stranger: Principal
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc324-matrix-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const mk = async (username: string): Promise<Principal> => {
    const user = await createUser(db, {
      username,
      displayName: username,
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: user.id })
    return { id: user.id, token }
  }
  return {
    db,
    app,
    owner: await mk('owner'),
    reader: await mk('reader'),
    editor: await mk('editor'),
    stranger: await mk('stranger'),
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

async function grant(
  db: DbClient,
  type: 'agent' | 'workflow',
  resourceId: string,
  userId: string,
  level: ResourceGrantLevel,
): Promise<void> {
  await db
    .insert(resourceGrants)
    .values({ resourceType: type, resourceId, userId, level, addedBy: 'seed', addedAt: NOW })
    .run()
}

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { code?: string }).code ?? '<no code>'
}

// ── agent ───────────────────────────────────────────────────────────────────

async function seedAgent(db: DbClient, ownerUserId: string): Promise<string> {
  const id = ulid()
  await db
    .insert(agents)
    .values({
      id,
      name: `rfc324-agent-${id.slice(-6)}`,
      description: 'seeded',
      ownerUserId,
      visibility: 'private',
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  return id
}

async function agentRow(db: DbClient, id: string): Promise<{ description: string; name: string }> {
  const rows = await db.select().from(agents).where(eq(agents.id, id)).all()
  const row = rows[0]
  expect(row, '种子 agent 必须存在，否则本用例零预言力').toBeDefined()
  return { description: row!.description, name: row!.name }
}

describe('RFC-324 —— agent：内容写与治理写分档', () => {
  test('read 档：能看见，PUT 得 403 resource-read-only，且零写入', async () => {
    const h = await buildHarness()
    const id = await seedAgent(h.db, h.owner.id)
    await grant(h.db, 'agent', id, h.reader.id, 'read')
    const before = await agentRow(h.db, id)

    // 前提复核：没有这一句，下面的 403 可能只是「看不见」被误读。
    const visible = await req(h.app, h.reader.token, `/api/agents/${id}`)
    expect(visible.status, '前提不成立：read 档必须看得见').toBe(200)

    const res = await req(h.app, h.reader.token, `/api/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        description: 'intruded',
        expectedUpdatedAt: NOW,
        expectedAclRevision: 0,
      }),
    })
    expect(res.status).toBe(403)
    expect(await codeOf(res), '只读拒绝要有自己的码，前端据它分流文案').toBe('resource-read-only')
    expect(await agentRow(h.db, id), '被拒后不得留下任何持久写入').toEqual(before)
  })

  test('write 档：PUT 放行并落库；DELETE 仍 403 resource-govern-owner-only', async () => {
    const h = await buildHarness()
    const id = await seedAgent(h.db, h.owner.id)
    await grant(h.db, 'agent', id, h.editor.id, 'write')
    const before = await agentRow(h.db, id)

    const put = await req(h.app, h.editor.token, `/api/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        description: 'edited by grantee',
        expectedUpdatedAt: NOW,
        expectedAclRevision: 0,
      }),
    })
    expect([403, 404], 'write 档必须被内容写门放行').not.toContain(put.status)
    expect(put.status).toBe(200)
    expect((await agentRow(h.db, id)).description, '放行后的写必须真的落库').toBe(
      'edited by grantee',
    )

    const del = await req(h.app, h.editor.token, `/api/agents/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: before.name }),
    })
    expect(del.status, '删除属治理面，可编辑授权不覆盖').toBe(403)
    expect(await codeOf(del)).toBe('resource-govern-owner-only')
    expect((await agentRow(h.db, id)).name, '删除被拒后行仍在').toBe(before.name)
  })

  test('write 档：改名路由仍 403（名字域是 owner 的）', async () => {
    const h = await buildHarness()
    const id = await seedAgent(h.db, h.owner.id)
    await grant(h.db, 'agent', id, h.editor.id, 'write')
    const before = await agentRow(h.db, id)

    const res = await req(h.app, h.editor.token, `/api/agents/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({
        newName: 'renamed-by-grantee',
        expectedUpdatedAt: NOW,
        expectedAclRevision: 0,
      }),
    })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('resource-govern-owner-only')
    expect(await agentRow(h.db, id)).toEqual(before)
  })

  test('未授权的陌生人：私有行是 404，与不存在同形（存在性不泄漏）', async () => {
    const h = await buildHarness()
    const id = await seedAgent(h.db, h.owner.id)
    const before = await agentRow(h.db, id)

    for (const [label, init] of [
      // body 必须合法，否则请求会先撞 422 而根本到不了 ACL 判据。
      [
        'PUT',
        {
          method: 'PUT',
          body: JSON.stringify({
            description: 'x',
            expectedUpdatedAt: NOW,
            expectedAclRevision: 0,
          }),
        },
      ],
      ['DELETE', { method: 'DELETE', body: JSON.stringify({ confirm: before.name }) }],
    ] as const) {
      const res = await req(h.app, h.stranger.token, `/api/agents/${id}`, init)
      expect(res.status, `${label}：不可见必须 404 而非 403`).toBe(404)
    }
    expect(await agentRow(h.db, id)).toEqual(before)
  })
})

// ── workflow ────────────────────────────────────────────────────────────────

const WF_DEFINITION = { $schema_version: 2, inputs: [], nodes: [], edges: [] }

async function seedWorkflow(db: DbClient, ownerUserId: string): Promise<string> {
  const id = ulid()
  await db
    .insert(workflows)
    .values({
      id,
      name: `rfc324-wf-${id.slice(-6)}`,
      description: 'seeded',
      definition: JSON.stringify(WF_DEFINITION),
      version: 1,
      ownerUserId,
      visibility: 'private',
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  return id
}

async function workflowRow(
  db: DbClient,
  id: string,
): Promise<{ name: string; description: string; version: number }> {
  const rows = await db.select().from(workflows).where(eq(workflows.id, id)).all()
  const row = rows[0]
  expect(row, '种子 workflow 必须存在，否则本用例零预言力').toBeDefined()
  return { name: row!.name, description: row!.description, version: row!.version }
}

function savePayload(name: string, description: string): string {
  return JSON.stringify({
    expectedVersion: 1,
    clientMutationId: ulid(),
    snapshot: { name, description, definition: WF_DEFINITION },
  })
}

describe('RFC-324 —— workflow：保存 body 里带 name，改名围栏只能在事务内画', () => {
  test('read 档：保存 403 resource-read-only 且零写入', async () => {
    const h = await buildHarness()
    const id = await seedWorkflow(h.db, h.owner.id)
    await grant(h.db, 'workflow', id, h.reader.id, 'read')
    const before = await workflowRow(h.db, id)

    const visible = await req(h.app, h.reader.token, `/api/workflows/${id}`)
    expect(visible.status, '前提不成立：read 档必须看得见').toBe(200)

    const res = await req(h.app, h.reader.token, `/api/workflows/${id}`, {
      method: 'PUT',
      body: savePayload(before.name, 'intruded'),
    })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('resource-read-only')
    expect(await workflowRow(h.db, id)).toEqual(before)
  })

  test('write 档：同名保存放行并落库（改内容不算改名）', async () => {
    const h = await buildHarness()
    const id = await seedWorkflow(h.db, h.owner.id)
    await grant(h.db, 'workflow', id, h.editor.id, 'write')
    const before = await workflowRow(h.db, id)

    const res = await req(h.app, h.editor.token, `/api/workflows/${id}`, {
      method: 'PUT',
      body: savePayload(before.name, 'edited by grantee'),
    })
    expect([403, 404], 'write 档必须被保存门放行').not.toContain(res.status)
    expect(res.status).toBe(200)
    const after = await workflowRow(h.db, id)
    expect(after.description, '放行后的写必须真的落库').toBe('edited by grantee')
    expect(after.name, '内容写不得顺带改名').toBe(before.name)
  })

  test('write 档：同一次保存里改名 → 403 resource-rename-owner-only，内容也不落库', async () => {
    const h = await buildHarness()
    const id = await seedWorkflow(h.db, h.owner.id)
    await grant(h.db, 'workflow', id, h.editor.id, 'write')
    const before = await workflowRow(h.db, id)

    const res = await req(h.app, h.editor.token, `/api/workflows/${id}`, {
      method: 'PUT',
      body: savePayload('renamed-by-grantee', 'sneaky rename carrying content'),
    })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('resource-rename-owner-only')
    expect(
      await workflowRow(h.db, id),
      '改名被拒时同一 body 里的内容也必须一起回滚——半截写入比拒绝更糟',
    ).toEqual(before)
  })

  test('owner 改名照常放行（围栏只对非 owner 生效）', async () => {
    const h = await buildHarness()
    const id = await seedWorkflow(h.db, h.owner.id)
    const before = await workflowRow(h.db, id)

    const res = await req(h.app, h.owner.token, `/api/workflows/${id}`, {
      method: 'PUT',
      body: savePayload('renamed-by-owner', before.description),
    })
    expect([403, 404]).not.toContain(res.status)
    expect(res.status).toBe(200)
    expect((await workflowRow(h.db, id)).name).toBe('renamed-by-owner')
  })

  test('write 档：删除仍 403 resource-govern-owner-only', async () => {
    const h = await buildHarness()
    const id = await seedWorkflow(h.db, h.owner.id)
    await grant(h.db, 'workflow', id, h.editor.id, 'write')
    const before = await workflowRow(h.db, id)

    const res = await req(h.app, h.editor.token, `/api/workflows/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: before.name, expectedVersion: before.version }),
    })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('resource-govern-owner-only')
    expect(await workflowRow(h.db, id)).toEqual(before)
  })
})
