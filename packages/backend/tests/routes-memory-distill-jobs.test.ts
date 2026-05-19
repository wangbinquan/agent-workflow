// RFC-041 — admin REST surface for distill queue control.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { memoryDistillJobs } from '../src/db/schema'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  daemonToken: string
  userToken: string
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
  const user = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const userToken = (await createSession({ db, userId: user.id })).token
  return { db, app, daemonToken: DAEMON_TOKEN, userToken }
}

function seedJob(
  db: DbClient,
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled' = 'pending',
): string {
  const id = ulid()
  db.insert(memoryDistillJobs)
    .values({
      id,
      debounceKey: 'k',
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId: null,
      scopeResolvedJson: '{}',
      status,
      attempts: status === 'failed' ? 3 : 0,
      nextRunAt: Date.now(),
      lastError: status === 'failed' ? 'boom' : null,
      createdAt: Date.now(),
    })
    .run()
  return id
}

function authed(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return new Request(`http://localhost${url}`, { ...init, headers })
}

describe('routes-memory-distill-jobs', () => {
  let h: Harness
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
  })

  test('regular user → 403 on list, retry, cancel', async () => {
    const id = seedJob(h.db, 'failed')
    for (const path of [
      '/api/memory-distill-jobs',
      `/api/memory-distill-jobs/${id}/retry`,
      `/api/memory-distill-jobs/${id}/cancel`,
    ]) {
      const res = await h.app.fetch(
        authed(h.userToken, path, { method: path.endsWith('-jobs') ? 'GET' : 'POST' }),
      )
      expect(res.status).toBe(403)
    }
  })

  test('admin list + status filter', async () => {
    seedJob(h.db, 'pending')
    seedJob(h.db, 'failed')
    seedJob(h.db, 'done')
    const all = await h.app.fetch(
      authed(h.daemonToken, '/api/memory-distill-jobs', { method: 'GET' }),
    )
    const allBody = (await all.json()) as { items: unknown[] }
    expect(allBody.items.length).toBe(3)
    const failedOnly = await h.app.fetch(
      authed(h.daemonToken, '/api/memory-distill-jobs?status=failed', { method: 'GET' }),
    )
    const failedBody = (await failedOnly.json()) as { items: unknown[] }
    expect(failedBody.items.length).toBe(1)
  })

  test('retry only allowed on failed rows', async () => {
    const failed = seedJob(h.db, 'failed')
    const pending = seedJob(h.db, 'pending')
    const ok = await h.app.fetch(
      authed(h.daemonToken, `/api/memory-distill-jobs/${failed}/retry`, { method: 'POST' }),
    )
    expect(ok.status).toBe(200)
    const bad = await h.app.fetch(
      authed(h.daemonToken, `/api/memory-distill-jobs/${pending}/retry`, { method: 'POST' }),
    )
    expect(bad.status).toBe(409)
  })

  test('cancel only allowed on pending rows', async () => {
    const pending = seedJob(h.db, 'pending')
    const running = seedJob(h.db, 'running')
    const ok = await h.app.fetch(
      authed(h.daemonToken, `/api/memory-distill-jobs/${pending}/cancel`, { method: 'POST' }),
    )
    expect(ok.status).toBe(200)
    const bad = await h.app.fetch(
      authed(h.daemonToken, `/api/memory-distill-jobs/${running}/cancel`, { method: 'POST' }),
    )
    expect(bad.status).toBe(409)
  })

  test('bad status filter → 422', async () => {
    const res = await h.app.fetch(
      authed(h.daemonToken, '/api/memory-distill-jobs?status=bogus', { method: 'GET' }),
    )
    expect(res.status).toBe(422)
  })
})
