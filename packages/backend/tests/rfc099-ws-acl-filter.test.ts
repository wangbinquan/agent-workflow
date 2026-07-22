// RFC-099 — per-frame ACL filtering on the /ws/workflows and /ws/memories
// channels (mirrors the RFC-054 W2-4 tasks-list pattern). A private
// workflow's frames must never reach a non-granted user's socket; granting
// access (signalled by the workflow.acl.updated frame, which also busts the
// per-connection visibility cache) restores delivery. Memory frames follow
// the scoped resource (D12).

import type { Server } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, memories, resourceGrants, workflows } from '../src/db/schema'
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
  aliceToken: string
  aliceId: string
  carolToken: string
  carolId: string
  daveToken: string
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
  const dave = await createUser(db, {
    username: 'dave',
    displayName: 'Dave',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const aliceToken = (await createSession({ db, userId: alice.id })).token
  const carolToken = (await createSession({ db, userId: carol.id })).token
  const daveToken = (await createSession({ db, userId: dave.id })).token
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
    aliceToken,
    aliceId: alice.id,
    carolToken,
    carolId: carol.id,
    daveToken,
    cleanup: async () => {
      server.stop(true)
      resetBroadcastersForTests()
    },
  }
}

/** Connect, wait for hello, run `fire`, collect frames for `windowMs`. */
async function framesSeen(
  url: string,
  fire: () => void,
  windowMs = 400,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      resolvePromise(out)
    }, windowMs + 200)
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as Record<string, unknown>
      if (msg.type === 'hello') {
        // Subscription is live — fire the broadcasts now.
        setTimeout(fire, 10)
        return
      }
      out.push(msg)
    })
    ws.addEventListener('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`ws error: ${String(e)}`))
    })
  })
}

interface LiveFrames {
  socket: WebSocket
  frames: Array<Record<string, unknown>>
}

/** Open a cold workflows connection and keep collecting after its hello. */
async function connectLiveFrames(url: string): Promise<LiveFrames> {
  const frames: Array<Record<string, unknown>> = []
  const socket = new WebSocket(url)
  await new Promise<void>((resolvePromise, reject) => {
    socket.addEventListener('error', () => reject(new Error('ws error')))
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (message.type === 'hello') {
        resolvePromise()
        return
      }
      frames.push(message)
    })
  })
  return { socket, frames }
}

async function waitUntil(predicate: () => boolean, capMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > capMs) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  }
}

async function deleteViaHttp(
  h: Harness,
  workflowId: string,
  expectedVersion: number,
  clientMutationId: string,
  confirm: string, // RFC-222 (D5): type-to-confirm — the workflow's name
): Promise<Response> {
  return fetch(`${h.url.replace(/^ws:/, 'http:')}/api/workflows/${workflowId}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${h.aliceToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion, clientMutationId, confirm }),
  })
}

describe('RFC-099 — /ws/workflows per-frame ACL filter', () => {
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
      clientMutationId: ulid(),
      version: 2,
      snapshotHash: '0'.repeat(64),
      updatedAt: 123,
    })
  }

  test('owner receives frames for their private workflow; stranger receives none', async () => {
    const aliceFrames = await framesSeen(`${h.url}/ws/workflows?token=${h.aliceToken}`, fireUpdated)
    expect(aliceFrames.some((f) => f.type === 'workflow.updated')).toBe(true)

    const carolFrames = await framesSeen(`${h.url}/ws/workflows?token=${h.carolToken}`, fireUpdated)
    expect(carolFrames.length).toBe(0)
  })

  test('acl.updated busts the cache: after a grant, the SAME connection starts receiving', async () => {
    const carolFrames = await framesSeen(
      `${h.url}/ws/workflows?token=${h.carolToken}`,
      () => {
        // 1. pre-grant frame — dropped (and caches visible=false).
        fireUpdated()
        // 2. grant lands + acl.updated busts the cached entry.
        setTimeout(() => {
          void h.db
            .insert(resourceGrants)
            .values({
              resourceType: 'workflow',
              resourceId: privateWfId,
              userId: h.carolId,
              addedBy: h.aliceId,
              addedAt: Date.now(),
            })
            .then(() => {
              workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
                type: 'workflow.acl.updated',
                workflowId: privateWfId,
              })
              // 3. post-grant frame — must now arrive.
              setTimeout(fireUpdated, 50)
            })
        }, 50)
      },
      600,
    )
    expect(carolFrames.some((f) => f.type === 'workflow.acl.updated')).toBe(true)
    expect(carolFrames.some((f) => f.type === 'workflow.updated')).toBe(true)
  })

  test('cold owner and grantee receive an exact private delete frame while a stranger learns nothing', async () => {
    await h.db.insert(resourceGrants).values({
      resourceType: 'workflow',
      resourceId: privateWfId,
      userId: h.carolId,
      addedBy: h.aliceId,
      addedAt: Date.now(),
    })
    const [owner, grantee, stranger] = await Promise.all([
      connectLiveFrames(`${h.url}/ws/workflows?token=${h.aliceToken}`),
      connectLiveFrames(`${h.url}/ws/workflows?token=${h.carolToken}`),
      connectLiveFrames(`${h.url}/ws/workflows?token=${h.daveToken}`),
    ])
    const clientMutationId = ulid()
    const exactFrame = {
      type: 'workflow.deleted',
      workflowId: privateWfId,
      clientMutationId,
      deletedVersion: 1,
    }
    try {
      const response = await deleteViaHttp(h, privateWfId, 1, clientMutationId, 'private-flow')
      expect(response.status).toBe(204)
      await waitUntil(
        () =>
          owner.frames.some((frame) => frame.type === 'workflow.deleted') &&
          grantee.frames.some((frame) => frame.type === 'workflow.deleted'),
      )

      expect(owner.frames).toContainEqual(exactFrame)
      expect(grantee.frames).toContainEqual(exactFrame)
      // Let every async frame-gate promise settle before asserting non-delivery.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      expect(stranger.frames.some((frame) => frame.type === 'workflow.deleted')).toBe(false)
      const ownerFrame = owner.frames.find((frame) => frame.type === 'workflow.deleted')
      expect(Object.keys(ownerFrame ?? {}).sort()).toEqual(Object.keys(exactFrame).sort())
    } finally {
      owner.socket.close()
      grantee.socket.close()
      stranger.socket.close()
    }
  })

  test('cold public viewers receive workflow.deleted without serializing its audience context', async () => {
    await h.db.update(workflows).set({ visibility: 'public' }).where(eq(workflows.id, privateWfId))
    const [owner, publicViewer] = await Promise.all([
      connectLiveFrames(`${h.url}/ws/workflows?token=${h.aliceToken}`),
      connectLiveFrames(`${h.url}/ws/workflows?token=${h.daveToken}`),
    ])
    const clientMutationId = ulid()
    const exactFrame = {
      type: 'workflow.deleted',
      workflowId: privateWfId,
      clientMutationId,
      deletedVersion: 1,
    }
    try {
      const response = await deleteViaHttp(h, privateWfId, 1, clientMutationId, 'private-flow')
      expect(response.status).toBe(204)
      await waitUntil(
        () =>
          owner.frames.some((frame) => frame.type === 'workflow.deleted') &&
          publicViewer.frames.some((frame) => frame.type === 'workflow.deleted'),
      )

      expect(owner.frames).toContainEqual(exactFrame)
      expect(publicViewer.frames).toContainEqual(exactFrame)
      const publicFrame = publicViewer.frames.find((frame) => frame.type === 'workflow.deleted')
      expect(Object.keys(publicFrame ?? {}).sort()).toEqual(Object.keys(exactFrame).sort())
    } finally {
      owner.socket.close()
      publicViewer.socket.close()
    }
  })
})

describe('RFC-099 — /ws/memories per-frame scope filter (D12)', () => {
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

  function fireBoth() {
    memoryBroadcaster.broadcast(MEMORY_CHANNEL, {
      type: 'memory.archived',
      memoryId: agentMemoryId,
    })
    memoryBroadcaster.broadcast(MEMORY_CHANNEL, {
      type: 'memory.archived',
      memoryId: globalMemoryId,
    })
  }

  test('stranger only receives the global-scoped frame; owner receives both', async () => {
    const carolFrames = await framesSeen(`${h.url}/ws/memories?token=${h.carolToken}`, fireBoth)
    expect(carolFrames.map((f) => f.memoryId)).toEqual([globalMemoryId])

    const aliceFrames = await framesSeen(`${h.url}/ws/memories?token=${h.aliceToken}`, fireBoth)
    expect(aliceFrames.map((f) => f.memoryId).sort()).toEqual(
      [agentMemoryId, globalMemoryId].sort(),
    )
  })
})
