// RFC-041 — admin REST surface for distill queue control.

import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { createUser } from '../src/services/users'
import { memoryDistillJobs } from '../src/db/schema'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const DAEMON_TOKEN = 'a'.repeat(64)

interface Harness {
  db: ProviderNeutralDatabase
  app: Hono
  daemonToken: string
  userToken: string
}

async function buildHarness(
  scope: Parameters<Parameters<typeof describeEachProviderHttpApplication>[2]>[0],
): Promise<Harness> {
  const db = scope.harness.db
  const { app } = await scope.open()
  const user = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const userToken = (await createSession({ db, userId: user.id })).token
  return { db, app, daemonToken: DAEMON_TOKEN, userToken }
}

async function seedJob(
  db: ProviderNeutralDatabase,
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled' = 'pending',
): Promise<string> {
  const id = ulid()
  await db.insert(memoryDistillJobs).values({
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
  return id
}

function authed(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return new Request(`http://localhost${url}`, { ...init, headers })
}

// RFC-359 AC-6：整条 REST 面改成两个引擎各跑一遍——鉴权分档、列表、重试、取消都要走完整条装配。
describeEachProviderHttpApplication(
  'routes-memory-distill-jobs',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-distill-jobs-',
  },
  (scope) => {
    let h: Harness
    beforeEach(async () => {
      resetBroadcastersForTests()
      h = await buildHarness(scope)
    })

    test('regular user → 403 on list, retry, cancel', async () => {
      const id = await seedJob(h.db, 'failed')
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
      await seedJob(h.db, 'pending')
      await seedJob(h.db, 'failed')
      await seedJob(h.db, 'done')
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
      const failed = await seedJob(h.db, 'failed')
      const pending = await seedJob(h.db, 'pending')
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
      const pending = await seedJob(h.db, 'pending')
      const running = await seedJob(h.db, 'running')
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
  },
)
