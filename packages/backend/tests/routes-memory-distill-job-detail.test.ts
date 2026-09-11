// RFC-043 T4 — admin detail / session routes for distill jobs.
//
// Locks:
//   - GET /api/memory-distill-jobs/:id            admin 200 / user 403 / 404
//   - GET /api/memory-distill-jobs/:id/session    multi-attempt grouping +
//                                                 capture-failed marker handling

import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '../src/db/query'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { createUser } from '../src/services/users'
import { memoryDistillEvents, memoryDistillJobs } from '../src/db/schema'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { DISTILL_CAPTURE_FAILED_KIND } from '../src/services/runtime'

const DAEMON_TOKEN = 'a'.repeat(64)

interface Harness {
  db: ProviderNeutralDatabase
  app: Hono
  daemonToken: string
  userToken: string
}

async function buildHarness(scope: ProviderHttpApplicationScope): Promise<Harness> {
  const db = scope.harness.db
  const app = (await scope.open()).app
  const user = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const userToken = (await createSession({ db, userId: user.id })).token
  return { db, app, daemonToken: DAEMON_TOKEN, userToken }
}

function authed(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return new Request(`http://localhost${url}`, { ...init, headers })
}

async function seedJob(db: ProviderNeutralDatabase): Promise<string> {
  const id = ulid()
  await db.insert(memoryDistillJobs).values({
    id,
    debounceKey: 'k',
    sourceKind: 'feedback',
    sourceEventId: 'tf-1',
    taskId: null,
    scopeResolvedJson: '{"agentIds":[],"workflowId":null,"repoId":null,"includeGlobal":true}',
    status: 'done',
    attempts: 0,
    nextRunAt: Date.now(),
    createdAt: Date.now(),
    opencodeSessionId: 'sess-1',
    userPromptMd: 'prompt',
    exitCode: 0,
    stderrExcerpt: 'note',
  })
  return id
}

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'routes /api/memory-distill-jobs/:id (RFC-043)',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-distill-detail-',
  },
  (scope) => {
    let h: Harness
    beforeEach(async () => {
      resetBroadcastersForTests()
      h = await buildHarness(scope)
    })

    test('regular user → 403 on detail + session endpoints', async () => {
      const id = await seedJob(h.db)
      const a = await h.app.fetch(
        authed(h.userToken, `/api/memory-distill-jobs/${id}`, { method: 'GET' }),
      )
      expect(a.status).toBe(403)
      const b = await h.app.fetch(
        authed(h.userToken, `/api/memory-distill-jobs/${id}/session`, { method: 'GET' }),
      )
      expect(b.status).toBe(403)
    })

    test('admin GET /:id returns job + siblings + sourceEvents + dedupSnapshot + candidates', async () => {
      const id = await seedJob(h.db)
      const res = await h.app.fetch(
        authed(h.daemonToken, `/api/memory-distill-jobs/${id}`, { method: 'GET' }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        job: { id: string; opencodeSessionId: string | null }
        siblings: unknown[]
        sourceEvents: unknown[]
        dedupSnapshot: unknown[]
        candidates: unknown[]
      }
      expect(body.job.id).toBe(id)
      expect(body.job.opencodeSessionId).toBe('sess-1')
      expect(body.sourceEvents).toHaveLength(1)
      expect(body.candidates).toHaveLength(0)
    })

    test('admin GET /:id on missing job → 404', async () => {
      const res = await h.app.fetch(
        authed(h.daemonToken, '/api/memory-distill-jobs/nope/cap', { method: 'GET' }),
      )
      expect(res.status).toBe(404)
    })

    test('GET /:id/session groups events by attempt_index and excludes capture-failed marker from tree', async () => {
      const id = await seedJob(h.db)
      // attempt 0: 1 real event
      await h.db.insert(memoryDistillEvents).values({
        distillJobId: id,
        attemptIndex: 0,
        sessionId: 'sess-A',
        parentSessionId: null,
        ts: 10,
        kind: 'text',
        payload: JSON.stringify({
          type: 'text',
          sessionID: 'sess-A',
          messageID: 'm1',
          part: { id: 'p1', type: 'text', text: 'hi' },
          timestamp: 10,
        }),
      })
      // attempt 1: capture-failed marker only
      await h.db.insert(memoryDistillEvents).values({
        distillJobId: id,
        attemptIndex: 1,
        sessionId: 'sess-B',
        parentSessionId: null,
        ts: 20,
        kind: DISTILL_CAPTURE_FAILED_KIND,
        payload: '{"reason":"opencode-db-not-found"}',
      })
      const res = await h.app.fetch(
        authed(h.daemonToken, `/api/memory-distill-jobs/${id}/session`, { method: 'GET' }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        attempts: Array<{
          attemptIndex: number
          captureFailed: boolean
          tree: unknown | null
          rootSessionId: string | null
        }>
      }
      expect(body.attempts).toHaveLength(2)
      expect(body.attempts[0]?.attemptIndex).toBe(0)
      expect(body.attempts[0]?.captureFailed).toBe(false)
      expect(body.attempts[0]?.tree).not.toBeNull()
      expect(body.attempts[1]?.attemptIndex).toBe(1)
      expect(body.attempts[1]?.captureFailed).toBe(true)
      expect(body.attempts[1]?.tree).toBeNull()
    })

    test('GET /:id/session on job with zero captured events returns attempts:[]', async () => {
      const id = await seedJob(h.db)
      const res = await h.app.fetch(
        authed(h.daemonToken, `/api/memory-distill-jobs/${id}/session`, { method: 'GET' }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { attempts: unknown[] }
      expect(body.attempts).toHaveLength(0)
    })
  },
)
