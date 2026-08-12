// RFC-041 — HTTP layer for memory routes.
//
// Covers permission gating (daemon-admin vs regular user vs admin user vs
// unauthenticated) for all 7 endpoints, end-to-end promote / supersede /
// archive / delete flow, and the ?confirm=true guard on DELETE.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { Memory, MemorySummary } from '@agent-workflow/shared'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  daemonToken: string
  adminUserToken: string
  regularUserToken: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const user = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const adminUserToken = (await createSession({ db, userId: admin.id })).token
  const regularUserToken = (await createSession({ db, userId: user.id })).token
  // RFC-099 (D12): memory rights follow the scoped resource. Seed a real,
  // PUBLIC, admin-owned agents row for the fixture's scopeId='a1' so the
  // regular user can VIEW agent-scoped candidates (public) but cannot MANAGE
  // them (not the owner) — preserving this file's 403 assertions.
  const { agents } = await import('../src/db/schema')
  await db.insert(agents).values({
    id: 'a1',
    name: 'fixture-agent-a1',
    ownerUserId: admin.id,
    visibility: 'public',
  })
  return { db, app, daemonToken: DAEMON_TOKEN, adminUserToken, regularUserToken }
}

function authed(h: Harness, token: string, init: RequestInit & { url: string }): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return new Request(`http://localhost${init.url}`, { ...init, headers })
}

async function createCandidateViaAdmin(h: Harness, scopeId = 'a1'): Promise<Memory> {
  const res = await h.app.fetch(
    authed(h, h.daemonToken, {
      url: '/api/memories',
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'agent',
        scopeId,
        title: 'candidate-title',
        bodyMd: 'body',
      }),
    }),
  )
  expect(res.status).toBe(201)
  const j = (await res.json()) as { memory: Memory }
  return j.memory
}

describe('routes-memories — permission gates', () => {
  let h: Harness
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
  })

  test('unauthenticated GET /api/memories → 401', async () => {
    const res = await h.app.fetch(new Request('http://localhost/api/memories'))
    expect(res.status).toBe(401)
  })

  test('regular user GET /api/memories → 200 (memory:read in user baseline)', async () => {
    const res = await h.app.fetch(
      authed(h, h.regularUserToken, { url: '/api/memories', method: 'GET' }),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { items: unknown[] }
    expect(j.items).toEqual([])
  })

  test('regular user POST /api/memories → 403', async () => {
    const res = await h.app.fetch(
      authed(h, h.regularUserToken, {
        url: '/api/memories',
        method: 'POST',
        body: JSON.stringify({ scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b' }),
      }),
    )
    expect(res.status).toBe(403)
  })

  test('admin user (session) POST /api/memories → 201', async () => {
    const res = await h.app.fetch(
      authed(h, h.adminUserToken, {
        url: '/api/memories',
        method: 'POST',
        body: JSON.stringify({ scopeType: 'global', scopeId: null, title: 't', bodyMd: 'b' }),
      }),
    )
    expect(res.status).toBe(201)
  })

  test('regular user cannot archive / delete / promote', async () => {
    const cand = await createCandidateViaAdmin(h)
    for (const path of ['promote', 'archive', 'unarchive']) {
      const res = await h.app.fetch(
        authed(h, h.regularUserToken, {
          url: `/api/memories/${cand.id}/${path}`,
          method: 'POST',
          body: JSON.stringify({ action: 'approve' }),
        }),
      )
      expect(res.status).toBe(403)
    }
    const del = await h.app.fetch(
      authed(h, h.regularUserToken, {
        url: `/api/memories/${cand.id}?confirm=true`,
        method: 'DELETE',
      }),
    )
    expect(del.status).toBe(403)
  })
})

describe('routes-memories — happy paths via daemon token (admin)', () => {
  let h: Harness
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
  })

  test('POST create → GET list shows candidate', async () => {
    await createCandidateViaAdmin(h)
    const res = await h.app.fetch(
      authed(h, h.daemonToken, { url: '/api/memories?status=candidate', method: 'GET' }),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { items: MemorySummary[] }
    expect(j.items.length).toBe(1)
    expect(j.items[0]!.status).toBe('candidate')
    // Default summary shape strips bodyMd so the approval card cannot render
    // it without ?include=body — locks in the bug this test was added for.
    expect((j.items[0] as unknown as { bodyMd?: string }).bodyMd).toBeUndefined()
  })

  // Regression: the approval queue needs full Memory rows (bodyMd + source*
  // / supersedesId) to render the candidate body for admins to actually
  // approve. The default summary list strips those; ?include=body widens
  // every row to the full Memory shape.
  test('GET /api/memories?status=candidate&include=body → returns full Memory rows', async () => {
    await createCandidateViaAdmin(h)
    const res = await h.app.fetch(
      authed(h, h.daemonToken, {
        url: '/api/memories?status=candidate&include=body',
        method: 'GET',
      }),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { items: Memory[] }
    expect(j.items.length).toBe(1)
    const row = j.items[0]!
    expect(row.status).toBe('candidate')
    expect(row.bodyMd).toBe('body')
    expect(row.sourceKind).toBe('manual')
    expect(row.sourceEventId).toBeNull()
    expect(row.supersedesId).toBeNull()
  })

  test('GET /api/memories?include=bogus → 422', async () => {
    const res = await h.app.fetch(
      authed(h, h.daemonToken, { url: '/api/memories?include=full', method: 'GET' }),
    )
    expect(res.status).toBe(422)
  })

  test('promote(approve) flips status; subsequent promote → 409', async () => {
    const cand = await createCandidateViaAdmin(h)
    const ok = await h.app.fetch(
      authed(h, h.daemonToken, {
        url: `/api/memories/${cand.id}/promote`,
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
    )
    expect(ok.status).toBe(200)
    const dup = await h.app.fetch(
      authed(h, h.daemonToken, {
        url: `/api/memories/${cand.id}/promote`,
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
    )
    expect(dup.status).toBe(409)
  })

  test('promote(approve_and_supersede) walks chain via GET detail', async () => {
    const v1 = await createCandidateViaAdmin(h)
    await h.app.fetch(
      authed(h, h.daemonToken, {
        url: `/api/memories/${v1.id}/promote`,
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
    )
    const v2 = await createCandidateViaAdmin(h)
    const promote2 = await h.app.fetch(
      authed(h, h.daemonToken, {
        url: `/api/memories/${v2.id}/promote`,
        method: 'POST',
        body: JSON.stringify({ action: 'approve_and_supersede', supersedeIds: [v1.id] }),
      }),
    )
    expect(promote2.status).toBe(200)
    const detail = await h.app.fetch(
      authed(h, h.daemonToken, { url: `/api/memories/${v2.id}`, method: 'GET' }),
    )
    const j = (await detail.json()) as {
      memory: Memory
      ancestors: MemorySummary[]
    }
    expect(j.memory.version).toBe(2)
    expect(j.ancestors.map((a) => a.id)).toEqual([v1.id])
  })

  test('promote(reject) sets rejected without approvedAt', async () => {
    const cand = await createCandidateViaAdmin(h)
    const res = await h.app.fetch(
      authed(h, h.daemonToken, {
        url: `/api/memories/${cand.id}/promote`,
        method: 'POST',
        body: JSON.stringify({ action: 'reject' }),
      }),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { memory: Memory }
    expect(j.memory.status).toBe('rejected')
    expect(j.memory.approvedAt).toBeNull()
  })

  test('archive then unarchive', async () => {
    const cand = await createCandidateViaAdmin(h)
    await h.app.fetch(
      authed(h, h.daemonToken, {
        url: `/api/memories/${cand.id}/promote`,
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
    )
    const arc = await h.app.fetch(
      authed(h, h.daemonToken, { url: `/api/memories/${cand.id}/archive`, method: 'POST' }),
    )
    expect(arc.status).toBe(200)
    const unarc = await h.app.fetch(
      authed(h, h.daemonToken, { url: `/api/memories/${cand.id}/unarchive`, method: 'POST' }),
    )
    expect(unarc.status).toBe(200)
    const j = (await unarc.json()) as { memory: Memory }
    expect(j.memory.status).toBe('approved')
  })

  test('DELETE without confirm=true → 422', async () => {
    const cand = await createCandidateViaAdmin(h)
    const res = await h.app.fetch(
      authed(h, h.daemonToken, { url: `/api/memories/${cand.id}`, method: 'DELETE' }),
    )
    expect(res.status).toBe(422)
  })

  test('DELETE with confirm=true → 200 and row gone', async () => {
    const cand = await createCandidateViaAdmin(h)
    const res = await h.app.fetch(
      authed(h, h.daemonToken, {
        url: `/api/memories/${cand.id}?confirm=true`,
        method: 'DELETE',
      }),
    )
    expect(res.status).toBe(200)
    const after = await h.app.fetch(
      authed(h, h.daemonToken, { url: `/api/memories/${cand.id}`, method: 'GET' }),
    )
    expect(after.status).toBe(404)
  })

  test('POST /api/memories invalid body → 422', async () => {
    const res = await h.app.fetch(
      authed(h, h.daemonToken, {
        url: '/api/memories',
        method: 'POST',
        body: JSON.stringify({ scopeType: 'agent', scopeId: null, title: 't', bodyMd: 'b' }),
      }),
    )
    expect(res.status).toBe(422)
  })

  test('GET filter rejects garbage status → 422', async () => {
    const res = await h.app.fetch(
      authed(h, h.daemonToken, { url: '/api/memories?status=bogus', method: 'GET' }),
    )
    expect(res.status).toBe(422)
  })

  test('GET 404 on unknown id', async () => {
    const res = await h.app.fetch(
      authed(h, h.daemonToken, { url: '/api/memories/m_nope', method: 'GET' }),
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// RFC-285 B7（Q4 拍板，E12）—— candidate 读面收紧为仅资源管理员。
// candidate 是未经人审的蒸馏产物（含 body），此前全员可读；现与 distill 详情
// 门（E8）同一威胁模型：admin/manager 可见，普通用户 list 里被滤掉、detail
// 与不存在同形 404；人审发布（approved）后回到全员读面。
// ---------------------------------------------------------------------------

describe('RFC-285 B7 — candidate 读面收紧（Q4/E12）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('普通用户：list 滤掉 candidate（两读法）、detail 404 同形；admin 全见', async () => {
    const created = await createCandidateViaAdmin(h)

    // list（无 body）：普通用户看不到 candidate 行。
    const userList = (await (
      await h.app.fetch(authed(h, h.regularUserToken, { url: '/api/memories', method: 'GET' }))
    ).json()) as { items: Array<{ id: string }> }
    expect(userList.items.map((m) => m.id)).not.toContain(created.id)

    // list（include=body）：同收。
    const userBodyList = (await (
      await h.app.fetch(
        authed(h, h.regularUserToken, { url: '/api/memories?include=body', method: 'GET' }),
      )
    ).json()) as { items: Array<{ id: string }> }
    expect(userBodyList.items.map((m) => m.id)).not.toContain(created.id)

    // detail：与不存在同形 404（byte-oracle：归一 id 后与真缺失逐字节相等）。
    const invisible = await h.app.fetch(
      authed(h, h.regularUserToken, { url: `/api/memories/${created.id}`, method: 'GET' }),
    )
    const missing = await h.app.fetch(
      authed(h, h.regularUserToken, { url: '/api/memories/mem_no_such', method: 'GET' }),
    )
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    const norm = (s: string, id: string): string => s.replaceAll(id, '<ID>')
    expect(norm(await invisible.text(), created.id)).toBe(norm(await missing.text(), 'mem_no_such'))

    // admin 全见（list + detail）。
    const adminList = (await (
      await h.app.fetch(authed(h, h.adminUserToken, { url: '/api/memories', method: 'GET' }))
    ).json()) as { items: Array<{ id: string }> }
    expect(adminList.items.map((m) => m.id)).toContain(created.id)
    expect(
      (
        await h.app.fetch(
          authed(h, h.adminUserToken, { url: `/api/memories/${created.id}`, method: 'GET' }),
        )
      ).status,
    ).toBe(200)
  })

  test('人审发布后（approved）普通用户恢复可读', async () => {
    const created = await createCandidateViaAdmin(h)
    const approve = await h.app.fetch(
      authed(h, h.daemonToken, {
        url: `/api/memories/${created.id}/promote`,
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
    )
    expect(approve.status).toBe(200)
    const detail = await h.app.fetch(
      authed(h, h.regularUserToken, { url: `/api/memories/${created.id}`, method: 'GET' }),
    )
    expect(detail.status).toBe(200)
  })
})
