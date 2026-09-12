// RFC-099 — per-frame ACL filtering on the /ws/workflows and /ws/memories
// channels (mirrors the RFC-054 W2-4 tasks-list pattern). A private
// workflow's frames must never reach a non-granted user's socket; granting
// access (signalled by the workflow.acl.updated frame, which also busts the
// per-connection visibility cache) restores delivery. Memory frames follow
// the scoped resource (D12).

import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '../src/db/query'
import {
  describeEachProviderWebSocketApplication,
  type ProviderWebSocketScope,
} from './helpers/providerWebSocketScope'
import { agents, memories, resourceGrants, workflows } from '../src/db/schema'
import { createUser } from '../src/services/users'
import {
  MEMORY_CHANNEL,
  memoryBroadcaster,
  resetBroadcastersForTests,
  WORKFLOWS_CHANNEL,
  workflowsBroadcaster,
} from '../src/ws/broadcaster'

const DAEMON_TOKEN = 'a'.repeat(64)

const SCOPE_OPTIONS = {
  token: DAEMON_TOKEN,
  daemonToken: DAEMON_TOKEN,
  opencodeVersion: '1.14.25',
  dbVersion: 1,
  tempPrefix: 'aw-rfc099-ws-acl-',
} as const

interface Harness {
  db: ProviderNeutralDatabase
  url: string
  httpUrl: string
  aliceToken: string
  aliceId: string
  carolToken: string
  carolId: string
  daveToken: string
}

// RFC-359 AC-6：本文件有 HTTP 回落（DELETE /api/workflows 走 app.fetch），所以要**应用**——
// 用 `describeEachProviderWebSocketApplication` 一次拿到 provider 应用 + 实时运行时 + ws 适配器
// + 活的 server。
async function buildHarness(scope: ProviderWebSocketScope): Promise<Harness> {
  const db = scope.harness.db
  const opened = await scope.open()
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
  return {
    db,
    url: opened.url,
    httpUrl: opened.httpUrl,
    aliceToken: (await createSession({ db, userId: alice.id })).token,
    aliceId: alice.id,
    carolToken: (await createSession({ db, userId: carol.id })).token,
    carolId: carol.id,
    daveToken: (await createSession({ db, userId: dave.id })).token,
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
  return fetch(`${h.httpUrl}/api/workflows/${workflowId}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${h.aliceToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion, clientMutationId, confirm }),
  })
}

describeEachProviderWebSocketApplication(
  'RFC-099 — /ws/workflows per-frame ACL filter',
  SCOPE_OPTIONS,
  (scope) => {
    let h: Harness
    let privateWfId = ''

    beforeEach(async () => {
      resetBroadcastersForTests()
      h = await buildHarness(scope)
      privateWfId = ulid()
      await h.db.insert(workflows).values({
        id: privateWfId,
        name: 'private-flow',
        definition: '{}',
        ownerUserId: h.aliceId,
        visibility: 'private',
      })
    })

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
      const aliceFrames = await framesSeen(
        `${h.url}/ws/workflows?token=${h.aliceToken}`,
        fireUpdated,
      )
      expect(aliceFrames.some((f) => f.type === 'workflow.updated')).toBe(true)

      const carolFrames = await framesSeen(
        `${h.url}/ws/workflows?token=${h.carolToken}`,
        fireUpdated,
      )
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
      // RFC-359 AC-20 因果屏障用：一个陌生人**有权**看见的公共工作流。
      const publicWfId = ulid()
      await h.db.insert(workflows).values({
        id: publicWfId,
        name: 'public-barrier-flow',
        definition: '{}',
        ownerUserId: h.aliceId,
        visibility: 'public',
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

        // RFC-359 AC-20 —— 断言「某帧没送到」不能靠睡一觉：`gatedSubscribe` 是
        // fire-and-forget 地起 frameGate（`src/ws/registry.ts` 的 `.then(...)`），
        // 跨帧送达**无序**，所以别人那两条到了并不代表陌生人这条已判完。
        // 改成走**陌生人自己这条 socket** 的因果屏障：在私有删除**之后**再播一帧
        // 他有权看见的公共工作流；他收到它，就说明他这条连接的 gate 管线已经
        // 把队列里前一帧（私有删除）推过去了。屏障帧和被断言的帧同一条 socket、
        // 同一套 gate，比固定 50ms 强。
        workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
          type: 'workflow.updated',
          workflowId: publicWfId,
          clientMutationId: ulid(),
          version: 2,
          snapshotHash: '0'.repeat(64),
          updatedAt: 456,
        })
        await waitUntil(() => stranger.frames.some((frame) => frame.workflowId === publicWfId))
        // 屏障本身必须真的到了，否则下面那条负向断言是空的。
        expect(stranger.frames.some((frame) => frame.workflowId === publicWfId)).toBe(true)

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
      await h.db
        .update(workflows)
        .set({ visibility: 'public' })
        .where(eq(workflows.id, privateWfId))
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
  },
)

describeEachProviderWebSocketApplication(
  'RFC-099 — /ws/memories per-frame scope filter (D12)',
  SCOPE_OPTIONS,
  (scope) => {
    let h: Harness
    let privateAgentId = ''
    let agentMemoryId = ''
    let globalMemoryId = ''

    beforeEach(async () => {
      resetBroadcastersForTests()
      h = await buildHarness(scope)
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
  },
)
