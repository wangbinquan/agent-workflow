// RFC-033-T3: /ws/repo-imports/{batchId} channel.
// RFC-285 B6②：本频道自此有升级门（发起者 ∨ 资源管理员；缺行同形拒绝）——
// 正向用例先 seed 真批次（stub resolver，不触网），门矩阵见文件末 describe。

import type { Server } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import {
  REPO_IMPORT_CHANNEL,
  repoImportsBroadcaster,
  resetBroadcastersForTests,
} from '../src/ws/broadcaster'
import { buildWebSocketAdapter } from '../src/ws/server'
import { __resetBatchImportForTests, startBatchImport } from '../src/services/repoBatchImport'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { createUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'

type AnyServer = Server<unknown>

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  server: AnyServer
  url: string
  cleanup: () => Promise<void>
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '/tmp/__never_used__.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const ws = buildWebSocketAdapter({ daemonToken: TOKEN, db })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req: Request, srv): Promise<Response> {
      const upgraded = await ws.tryUpgrade(req, srv)
      if (upgraded === true) return undefined as unknown as Response
      if (upgraded === false) return await app.fetch(req)
      return upgraded
    },
    websocket: ws.handlers,
  })
  return {
    db,
    server,
    url: `ws://${server.hostname}:${server.port}`,
    cleanup: async () => {
      server.stop(true)
      resetBroadcastersForTests()
      __resetBatchImportForTests()
    },
  }
}

/** Resolve as soon as `pred()` holds (polling), capped at `capMs`. */
async function waitUntil(pred: () => boolean, capMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > capMs) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

const hasType = (msgs: Array<{ type: string }>, type: string): boolean =>
  msgs.some((m) => m.type === type)

function seedBatch(db: DbClient, ownerUserId: string): string {
  // stub resolver 永不返回：本套件只做频道语义，不跑真实 clone。
  const result = startBatchImport(
    { db, resolveCachedRepo: () => new Promise(() => {}) as never },
    { urls: ['https://h/seed.git'] },
    { userId: ownerUserId },
  )
  return result.snapshot.batchId
}

describe('/ws/repo-imports/{batchId} (RFC-033)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  test('opens with hello frame and receives row.update + batch.completed broadcasts', async () => {
    const batchId = seedBatch(h.db, SYSTEM_USER_ID)
    const received: Array<{ type: string }> = []
    const sock = new WebSocket(`${h.url}/ws/repo-imports/${batchId}?token=${TOKEN}`)
    await new Promise<void>((res, rej) => {
      sock.addEventListener('open', () => res())
      sock.addEventListener('error', () => rej(new Error('ws error')))
    })
    sock.addEventListener('message', (e) => received.push(JSON.parse(String(e.data))))
    // Wait for hello frame.
    await waitUntil(() => hasType(received, 'hello'))

    repoImportsBroadcaster.broadcast(REPO_IMPORT_CHANNEL(batchId), {
      type: 'row.update',
      row: {
        rowId: 'r1',
        inputUrl: 'https://h/a.git',
        inputUrlRedacted: 'https://h/a.git',
        status: 'done',
        cold: true,
        fetchOk: null,
        cachedRepoId: 'cr1',
        errorCode: null,
        message: 'cloned',
        queuedAt: '2026-05-17T00:00:00.000Z',
        startedAt: '2026-05-17T00:00:01.000Z',
        finishedAt: '2026-05-17T00:00:02.000Z',
      },
    })
    repoImportsBroadcaster.broadcast(REPO_IMPORT_CHANNEL(batchId), {
      type: 'batch.completed',
      batchId,
      completedAt: '2026-05-17T00:00:03.000Z',
    })
    await waitUntil(() => hasType(received, 'row.update') && hasType(received, 'batch.completed'))
    sock.close()

    const types = received.map((m) => m.type)
    expect(types[0]).toBe('hello')
    expect(types).toContain('row.update')
    expect(types).toContain('batch.completed')
    const hello = received[0] as { type: string; channel: string }
    expect(hello.channel).toBe(`repo-imports/${batchId}`)
  })

  test('broadcast on a different batchId is not delivered', async () => {
    const myBatch = seedBatch(h.db, SYSTEM_USER_ID)
    const otherBatch = 'batch-B' // 不存在也无妨：只对它广播、不升级
    const received: Array<{ type: string }> = []
    const sock = new WebSocket(`${h.url}/ws/repo-imports/${myBatch}?token=${TOKEN}`)
    await new Promise<void>((res) => sock.addEventListener('open', () => res()))
    sock.addEventListener('message', (e) => received.push(JSON.parse(String(e.data))))
    await waitUntil(() => hasType(received, 'hello'))

    repoImportsBroadcaster.broadcast(REPO_IMPORT_CHANNEL(otherBatch), {
      type: 'batch.completed',
      batchId: otherBatch,
      completedAt: '2026-05-17T00:00:01.000Z',
    })
    // Negative assertion: we must give an *erroneous* cross-batch delivery a
    // bounded window to (wrongly) arrive before concluding it didn't. Unlike the
    // positive waits above, this one cannot be predicate-driven — keep a short
    // fixed settle.
    await new Promise((r) => setTimeout(r, 50))
    sock.close()

    // Only the hello frame should be present.
    const types = received.map((m) => m.type)
    expect(types).toEqual(['hello'])
  })

  test('missing token returns 401 (no upgrade)', async () => {
    const res = await fetch(
      `http://${h.server.hostname}:${h.server.port}/ws/repo-imports/some-batch`,
    )
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// RFC-285 B6② —— 升级门矩阵（此前该频道无任何门：RFC-152 D4 登记缺口）。
// 判定：发起者 ∨ 资源管理员（admin/manager）通过；非发起者与批次缺行**同形
// 拒绝**（batch-not-found，HTTP 403 传输面）——错误形态探测不出批次存在性。
// ---------------------------------------------------------------------------

describe('RFC-285 B6② — /ws/repo-imports upgrade gate', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  async function upgradeStatus(batchId: string, token: string): Promise<number> {
    const res = await fetch(
      `http://${h.server.hostname}:${h.server.port}/ws/repo-imports/${batchId}?token=${token}`,
    )
    return res.status
  }

  test('发起者可升级；陌生用户与缺行同形拒绝；admin 旁路', async () => {
    const owner = await createUser(h.db, {
      username: 'batch-owner',
      displayName: 'BO',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const stranger = await createUser(h.db, {
      username: 'batch-stranger',
      displayName: 'BS',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const admin = await createUser(h.db, {
      username: 'batch-admin',
      displayName: 'BA',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const ownerToken = (await createSession({ db: h.db, userId: owner.id })).token
    const strangerToken = (await createSession({ db: h.db, userId: stranger.id })).token
    const adminToken = (await createSession({ db: h.db, userId: admin.id })).token
    const batchId = seedBatch(h.db, owner.id)

    // 发起者：升级成功（fetch 对 ws upgrade 返回 101 之外的形态因 runtime 而异，
    // 用真 WebSocket 验证）。
    const sock = new WebSocket(`${h.url}/ws/repo-imports/${batchId}?token=${ownerToken}`)
    await new Promise<void>((res, rej) => {
      sock.addEventListener('open', () => res())
      sock.addEventListener('error', () => rej(new Error('owner upgrade refused')))
    })
    sock.close()

    // 陌生用户 vs 批次缺行：同形 403 + batch-not-found。
    const strangerRes = await fetch(
      `http://${h.server.hostname}:${h.server.port}/ws/repo-imports/${batchId}?token=${strangerToken}`,
    )
    const missingRes = await fetch(
      `http://${h.server.hostname}:${h.server.port}/ws/repo-imports/no-such-batch?token=${strangerToken}`,
    )
    expect(strangerRes.status).toBe(403)
    expect(missingRes.status).toBe(403)
    const strangerBody = (await strangerRes.json()) as { code: string }
    const missingBody = (await missingRes.json()) as { code: string }
    expect(strangerBody.code).toBe('batch-not-found')
    expect(missingBody.code).toBe('batch-not-found')

    // admin 旁路。
    expect(await upgradeStatus(batchId, adminToken)).not.toBe(403)
  })
})
