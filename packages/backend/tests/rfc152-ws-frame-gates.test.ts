// RFC-152 PR-3 — frame-gate regression locks demanded by the design gate,
// written as PRE-migration behavior locks (they pass against the old
// hand-copied server.ts branches AND against the registry frameGates; the
// migration must not move them).
//
//   1. workflows bidirectional cache ordering, second cell: a connection
//      that could previously see a workflow (its per-connection visibility
//      cache holds true from an earlier frame) MUST receive the
//      'workflow.deleted' frame — the gate reads the OLD cache entry before
//      busting it. (First cell — same-connection grant starts receiving
//      after 'workflow.acl.updated' — is already locked by
//      rfc099-ws-acl-filter.test.ts and stays untouched there.)
//   2. memory.superseded (oldId/newId, NO memoryId) keeps the current
//      non-admin drop: admin receives / scope-visible user drops / stranger
//      drops. Zero-behavior-change migration; "stranger frontends may go
//      stale on supersede" is a registered known limitation (design.md §1),
//      improving it is explicitly out of scope for RFC-152.

import type { Server } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, memories, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import {
  MEMORY_CHANNEL,
  memoryBroadcaster,
  resetBroadcastersForTests,
  WORKFLOWS_CHANNEL,
  workflowsBroadcaster,
} from '../src/ws/broadcaster'
import { buildWebSocketAdapter } from '../src/ws/server'

type AnyServer = Server<unknown>

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  server: AnyServer
  url: string
  adminToken: string
  aliceToken: string
  aliceId: string
  carolToken: string
  cleanup: () => Promise<void>
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/__never_used__.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'root',
    displayName: 'Root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const alice = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const carol = await createUser(db, {
    username: 'carol',
    displayName: 'Carol',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const adminToken = (await createSession({ db, userId: admin.id })).token
  const aliceToken = (await createSession({ db, userId: alice.id })).token
  const carolToken = (await createSession({ db, userId: carol.id })).token
  const ws = buildWebSocketAdapter({ daemonToken: DAEMON_TOKEN, db })
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
    adminToken,
    aliceToken,
    aliceId: alice.id,
    carolToken,
    cleanup: async () => {
      server.stop(true)
      resetBroadcastersForTests()
    },
  }
}

/**
 * Connect, wait for the hello frame, then hand control to `script` (which
 * fires broadcasts and may await conditions on the live `received` array).
 * Frames other than hello accumulate into `received`; a short settle after
 * the script lets stragglers land before the socket closes.
 */
async function collectFrames(
  url: string,
  script: (received: Array<Record<string, unknown>>) => Promise<void>,
  settleMs = 150,
): Promise<Array<Record<string, unknown>>> {
  const received: Array<Record<string, unknown>> = []
  const sock = new WebSocket(url)
  await new Promise<void>((res, rej) => {
    sock.addEventListener('error', () => rej(new Error('ws error')))
    sock.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as Record<string, unknown>
      if (msg.type === 'hello') {
        res()
        return
      }
      received.push(msg)
    })
  })
  await script(received)
  await new Promise((r) => setTimeout(r, settleMs))
  sock.close()
  return received
}

/** Poll until `pred()` holds, capped — a missing frame then fails the assertion after. */
async function waitUntil(pred: () => boolean, capMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > capMs) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('RFC-152 — workflows frameGate keeps the deleted-uses-OLD-cache ordering', () => {
  let h: Harness
  let privateWfId = ''

  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
    privateWfId = ulid()
    await h.db.insert(workflows).values({
      id: privateWfId,
      name: 'private-flow',
      definition: '{}',
      ownerUserId: h.aliceId,
      visibility: 'private',
    })
  })
  afterEach(async () => h.cleanup())

  function fireUpdated() {
    workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
      type: 'workflow.updated',
      workflowId: privateWfId,
      version: 2,
      updatedAt: 123,
    })
  }
  function fireDeleted() {
    workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
      type: 'workflow.deleted',
      workflowId: privateWfId,
    })
  }

  test('previously-visible owner connection receives workflow.deleted', async () => {
    const frames = await collectFrames(
      `${h.url}/ws/workflows?token=${h.aliceToken}`,
      async (received) => {
        // 1. an update populates this connection's visibility cache (true).
        fireUpdated()
        await waitUntil(() => received.some((f) => f.type === 'workflow.updated'))
        // 2. the delete frame must ride the OLD cache entry.
        fireDeleted()
        await waitUntil(() => received.some((f) => f.type === 'workflow.deleted'))
      },
    )
    expect(frames.some((f) => f.type === 'workflow.updated')).toBe(true)
    expect(frames.some((f) => f.type === 'workflow.deleted')).toBe(true)
  })

  test('never-visible stranger connection receives neither update nor deleted', async () => {
    const frames = await collectFrames(`${h.url}/ws/workflows?token=${h.carolToken}`, async () => {
      fireUpdated()
      // Give the (dropped) update time to resolve its gate so the cache
      // holds false before the delete fires.
      await new Promise((r) => setTimeout(r, 100))
      fireDeleted()
    })
    expect(frames).toEqual([])
  })
})

describe('RFC-152 — memory.superseded keeps the non-admin drop (admin 收 / scoped 丢 / stranger 丢)', () => {
  let h: Harness
  let privateAgentId = ''
  let agentMemoryId = ''
  let globalMemoryId = ''

  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
    privateAgentId = ulid()
    await h.db.insert(agents).values({
      id: privateAgentId,
      name: `priv-${privateAgentId}`,
      ownerUserId: h.aliceId,
      visibility: 'private',
    })
    agentMemoryId = ulid()
    globalMemoryId = ulid()
    await h.db.insert(memories).values([
      {
        id: agentMemoryId,
        scopeType: 'agent',
        scopeId: privateAgentId,
        title: 'agent-scoped',
        bodyMd: 'b',
        tags: '[]',
        status: 'approved',
        sourceKind: 'manual',
        createdAt: Date.now(),
      },
      {
        id: globalMemoryId,
        scopeType: 'global',
        scopeId: null,
        title: 'global-scoped',
        bodyMd: 'b',
        tags: '[]',
        status: 'approved',
        sourceKind: 'manual',
        createdAt: Date.now(),
      },
    ])
  })
  afterEach(async () => h.cleanup())

  /** superseded (no memoryId) + a control frame every logged-in user can see. */
  function fireSupersededThenControl() {
    memoryBroadcaster.broadcast(MEMORY_CHANNEL, {
      type: 'memory.superseded',
      oldId: agentMemoryId,
      newId: ulid(),
    })
    memoryBroadcaster.broadcast(MEMORY_CHANNEL, {
      type: 'memory.archived',
      memoryId: globalMemoryId,
    })
  }

  test('admin receives the superseded frame', async () => {
    const frames = await collectFrames(
      `${h.url}/ws/memories?token=${h.adminToken}`,
      async (received) => {
        fireSupersededThenControl()
        await waitUntil(() => received.some((f) => f.type === 'memory.superseded'))
      },
    )
    expect(frames.some((f) => f.type === 'memory.superseded')).toBe(true)
  })

  test('scope-visible user (owner of the superseded memory scope) still drops it', async () => {
    const frames = await collectFrames(
      `${h.url}/ws/memories?token=${h.aliceToken}`,
      async (received) => {
        fireSupersededThenControl()
        // The control frame proves the socket is live and gated frames flow.
        await waitUntil(() => received.some((f) => f.type === 'memory.archived'))
      },
    )
    expect(frames.some((f) => f.type === 'memory.archived')).toBe(true)
    expect(frames.some((f) => f.type === 'memory.superseded')).toBe(false)
  })

  test('stranger drops the superseded frame too', async () => {
    const frames = await collectFrames(
      `${h.url}/ws/memories?token=${h.carolToken}`,
      async (received) => {
        fireSupersededThenControl()
        await waitUntil(() => received.some((f) => f.type === 'memory.archived'))
      },
    )
    expect(frames.some((f) => f.type === 'memory.archived')).toBe(true)
    expect(frames.some((f) => f.type === 'memory.superseded')).toBe(false)
  })
})
