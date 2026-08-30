// Regression test for the WS upgrade auth gap (RFC-036 follow-up).
//
// Before this fix, packages/backend/src/ws/server.ts only accepted the
// static daemon token via `timingSafeEquals(queryToken, deps.token)`. The
// HTTP path used `multiAuth` → `resolveActor()` which already supports
// session tokens (aws_s_…) and PATs (aws_pat_…), so every browser that
// signed in through OIDC got an `aws_s_…` token that *worked for /api but
// failed every WS upgrade with 401*. The task-detail page's `useTaskSync`
// would never invalidate React-Query, so the SessionTab looked stale until
// the user clicked another tab and bounced back (remount → refetch).
//
// Locks in: session token / PAT / daemon token all upgrade cleanly; an
// unrelated string is rejected. We don't assert on the WS payloads — the
// existing tests in ws.test.ts cover broadcast semantics. This file owns
// the upgrade-time auth surface.

import type { Server } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

type AnyServer = Server<unknown>

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { users } from '../src/db/schema'
import { createSession } from '../src/auth/sessionStore'
import { createPat } from '../src/auth/patStore'
import { buildWebSocketAdapter } from '../src/ws/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { createIdentityAccessRuntime } from '../src/modules/identity-access/composition'

const DAEMON_TOKEN = 'd'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  server: AnyServer
  baseUrl: string
  cleanup: () => Promise<void>
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const ws = buildWebSocketAdapter({
    daemonToken: DAEMON_TOKEN,
    db,
    identityAccess: createIdentityAccessRuntime({ db }),
  })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req: Request, srv): Promise<Response> {
      const upgraded = await ws.tryUpgrade(req, srv)
      if (upgraded === true) return undefined as unknown as Response
      if (upgraded === false) return new Response('not-ws', { status: 404 })
      return upgraded
    },
    websocket: ws.handlers,
  })
  return {
    db,
    server,
    baseUrl: `ws://${server.hostname}:${server.port}`,
    cleanup: async () => {
      server.stop(true)
      resetBroadcastersForTests()
    },
  }
}

async function seedUser(db: DbClient, role: 'admin' | 'user' = 'admin'): Promise<string> {
  const id = ulid()
  await db.insert(users).values({
    id,
    username: `u-${id.slice(-6)}`,
    displayName: 'Test User',
    passwordHash: null,
    role,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

/**
 * Open a WebSocket and resolve once it transitions out of CONNECTING. Returns
 * the first lifecycle event we observed — `'open'` on success or
 * `{code}` on close-before-open (which is what Bun emits when the upgrade
 * Response is 401, since the close handler fires synchronously after the
 * abnormal-close 1006). 800ms is plenty for a same-process socket.
 */
async function probeUpgrade(
  url: string,
): Promise<{ outcome: 'open' } | { outcome: 'closed'; code: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve({ outcome: 'closed', code: 0 })
    }, 800)
    ws.addEventListener('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve({ outcome: 'open' })
    })
    ws.addEventListener('close', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ outcome: 'closed', code: e.code })
    })
  })
}

describe('WS upgrade — RFC-036 multi-token auth', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  test('session token (aws_s_…) upgrades the connection', async () => {
    const userId = await seedUser(h.db)
    const { token } = await createSession({ db: h.db, userId })
    const out = await probeUpgrade(`${h.baseUrl}/ws/tasks?token=${encodeURIComponent(token)}`)
    expect(out.outcome).toBe('open')
  })

  test('PAT (aws_pat_…) upgrades the connection', async () => {
    const userId = await seedUser(h.db)
    const { token } = await createPat({ db: h.db, userId, name: 'test', purpose: 'general' })
    const out = await probeUpgrade(`${h.baseUrl}/ws/tasks?token=${encodeURIComponent(token)}`)
    expect(out.outcome).toBe('open')
  })

  test('legacy daemon token still upgrades (resolves to __system__)', async () => {
    const out = await probeUpgrade(
      `${h.baseUrl}/ws/tasks?token=${encodeURIComponent(DAEMON_TOKEN)}`,
    )
    expect(out.outcome).toBe('open')
  })

  test('unrelated token is rejected', async () => {
    const out = await probeUpgrade(
      `${h.baseUrl}/ws/tasks?token=${encodeURIComponent('not-a-real-token-1234567890')}`,
    )
    expect(out.outcome).toBe('closed')
    // Browser WS surfaces 1006 abnormal closure when the upgrade fails
    // with a non-101 HTTP response — same code the affected SessionTab
    // would have logged in its useWebSocket close handler.
    if (out.outcome === 'closed') {
      expect([1002, 1006]).toContain(out.code)
    }
  })

  test('expired/revoked session token is rejected', async () => {
    const userId = await seedUser(h.db)
    const { token } = await createSession({
      db: h.db,
      userId,
      ttlMs: -1, // already expired
    })
    const out = await probeUpgrade(`${h.baseUrl}/ws/tasks?token=${encodeURIComponent(token)}`)
    expect(out.outcome).toBe('closed')
  })

  test('missing token is rejected', async () => {
    const out = await probeUpgrade(`${h.baseUrl}/ws/tasks`)
    expect(out.outcome).toBe('closed')
  })
})

// RFC-152 P0 —— /ws/memory-distill-jobs admin 门禁回归。
//
// 为什么这条测试存在：该频道自 RFC-041 起被 4 处注释声明 admin-only
// （shared/schemas/ws.ts、broadcaster.ts、两个前端 hook），HTTP 侧
// routes/memoryDistillJobs.ts 全部 requireAdmin——但 WS upgrade 路径
// 从未 enforce，普通用户持有效 token 即可订阅蒸馏队列帧。锁定：
// 非 admin session 升级被 403 拒（close-before-open）、admin 正常升级。
describe('RFC-152 P0 — /ws/memory-distill-jobs admin-only upgrade gate', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  test('non-admin session token is rejected (close-before-open)', async () => {
    const userId = await seedUser(h.db, 'user')
    const { token } = await createSession({ db: h.db, userId })
    const r = await probeUpgrade(`${h.baseUrl}/ws/memory-distill-jobs?token=${token}`)
    expect(r.outcome).toBe('closed')
  })

  test('admin session token upgrades cleanly', async () => {
    const userId = await seedUser(h.db, 'admin')
    const { token } = await createSession({ db: h.db, userId })
    const r = await probeUpgrade(`${h.baseUrl}/ws/memory-distill-jobs?token=${token}`)
    expect(r.outcome).toBe('open')
  })

  test('daemon token（admin 语义）upgrades cleanly', async () => {
    const r = await probeUpgrade(`${h.baseUrl}/ws/memory-distill-jobs?token=${DAEMON_TOKEN}`)
    expect(r.outcome).toBe('open')
  })
})
