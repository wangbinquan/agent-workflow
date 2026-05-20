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
