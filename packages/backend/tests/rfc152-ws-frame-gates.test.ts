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

import { beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '../src/db/query'
import {
  describeEachProviderWebSocketApplication,
  type ProviderWebSocketScope,
} from './helpers/providerWebSocketScope'
import { agents, memories, workflows } from '../src/db/schema'
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
  tempPrefix: 'aw-rfc152-frame-gates-',
} as const

interface Harness {
  db: ProviderNeutralDatabase
  url: string
  adminToken: string
  aliceToken: string
  aliceId: string
  carolToken: string
}

// RFC-359 AC-6 —— 整套「provider 应用 + 实时运行时 + ws 适配器 + 活的 server」由
// `describeEachProviderWebSocketApplication` 交出；这里只留本文件的种子用户。
async function buildHarness(scope: ProviderWebSocketScope): Promise<Harness> {
  const db = scope.harness.db
  const opened = await scope.open()
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
  return {
    db,
    url: opened.url,
    adminToken: (await createSession({ db, userId: admin.id })).token,
    aliceToken: (await createSession({ db, userId: alice.id })).token,
    aliceId: alice.id,
    carolToken: (await createSession({ db, userId: carol.id })).token,
  }
}

/**
 * Connect, wait for the hello frame, then hand control to `script` (which
 * fires broadcasts and may await conditions on the live `received` array).
 * Frames other than hello accumulate into `received`.
 *
 * RFC-359 AC-20 —— 这里原本在 script 之后固定睡 150ms「让漏网的帧落地」。
 * 睡眠不是同步手段：`gatedSubscribe` 起 frameGate 是 fire-and-forget
 * （`src/ws/registry.ts` 的 `.then(...)`），慢机器上 150ms 一样可能不够。
 * 现在由 **script 自己建立因果屏障**——播一帧该连接**有权**看见的控制帧、
 * 等它到达；同一条 socket、同一套 gate 都把它推过来了，说明排在它前面的
 * 那些（被丢掉的）帧早已判完。本文件 memories 那三条用例一直就是这么写的
 * （`fireSupersededThenControl` + 等 `memory.archived`），这里只是把
 * workflows 那条也对齐过来，并删掉那条多余的兜底睡眠。
 */
async function collectFrames(
  url: string,
  script: (received: Array<Record<string, unknown>>) => Promise<void>,
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

describeEachProviderWebSocketApplication(
  'RFC-152 — workflows frameGate keeps the deleted-uses-OLD-cache ordering',
  SCOPE_OPTIONS,
  (scope) => {
    let h: Harness
    let privateWfId = ''
    let publicWfId = ''

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
      // RFC-359 AC-20 因果屏障用：任何连接都有权看见的公共工作流。
      publicWfId = ulid()
      await h.db.insert(workflows).values({
        id: publicWfId,
        name: 'public-control-flow',
        definition: '{}',
        ownerUserId: h.aliceId,
        visibility: 'public',
      })
    })

    /** 控制帧：走同一条 socket、同一套 gate，但必定被放行。 */
    function fireControl(version: number) {
      workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
        type: 'workflow.updated',
        workflowId: publicWfId,
        clientMutationId: ulid(),
        version,
        snapshotHash: '0'.repeat(64),
        updatedAt: 456,
      })
    }

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
    function fireDeleted() {
      workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
        type: 'workflow.deleted',
        workflowId: privateWfId,
        clientMutationId: ulid(),
        deletedVersion: 2,
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
      const frames = await collectFrames(
        `${h.url}/ws/workflows?token=${h.carolToken}`,
        async (received) => {
          // 1. 私有 update —— 必须被丢掉（并把该连接的可见性缓存钉成 false）。
          fireUpdated()
          // 2. 屏障：等一帧有权看见的控制帧到达，才说明上面那帧的 gate 已经判完、
          //    缓存已经落成 false。这比「睡 100ms」强，而且随机器变慢一起变长。
          fireControl(11)
          await waitUntil(() => received.some((f) => f.version === 11))
          // 3. 私有 delete —— 这才是本 describe 要钉的「delete 吃旧缓存」那一步。
          fireDeleted()
          fireControl(12)
          await waitUntil(() => received.some((f) => f.version === 12))
        },
      )
      // 两帧控制帧都到了（屏障成立），私有工作流的帧一条都没到。
      expect(frames.map((f) => f.version)).toEqual([11, 12])
      expect(frames.some((f) => f.workflowId === privateWfId)).toBe(false)
    })
  },
)

describeEachProviderWebSocketApplication(
  'RFC-152 — memory.superseded keeps the non-admin drop (admin 收 / scoped 丢 / stranger 丢)',
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
  },
)
