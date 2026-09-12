// RFC-033-T3: /ws/repo-imports/{batchId} channel.
// RFC-285 B6②：本频道自此有升级门（发起者 ∨ 资源管理员；缺行同形拒绝）——
// 正向用例先 seed 真批次（stub resolver，不触网），门矩阵见文件末 describe。

import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ProviderNeutralDatabase } from '../src/db/query'
import {
  describeEachProviderWebSocketApplication,
  type ProviderWebSocketScope,
} from './helpers/providerWebSocketScope'
import { REPO_IMPORT_CHANNEL, repoImportsBroadcaster } from '../src/ws/broadcaster'
import { __resetBatchImportForTests, startBatchImport } from '../src/services/repoBatchImport'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { createUser } from '../src/services/users'
import { createSession } from './helpers/auth/sessionStore'
import { composeSqliteRepositoryWorkspaceStore } from '../src/modules/source-control/composition'

const TOKEN = 'a'.repeat(64)

const SCOPE_OPTIONS = {
  token: TOKEN,
  daemonToken: TOKEN,
  opencodeVersion: '1.14.25',
  dbVersion: 1,
  tempPrefix: 'aw-ws-repo-imports-',
} as const

// RFC-359 AC-6 —— 整套「provider 应用 + 实时运行时 + ws 适配器 + 活的 server」交给
// `describeEachProviderWebSocketApplication`；这里只留本文件自己的批次状态复位。
interface Harness {
  db: ProviderNeutralDatabase
  url: string
  httpUrl: string
}

async function buildHarness(scope: ProviderWebSocketScope): Promise<Harness> {
  const opened = await scope.open()
  return { db: scope.harness.db, url: opened.url, httpUrl: opened.httpUrl }
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

function seedBatch(db: ProviderNeutralDatabase, ownerUserId: string): string {
  // stub resolver 永不返回：本套件只做频道语义，不跑真实 clone。
  const result = startBatchImport(
    {
      store: composeSqliteRepositoryWorkspaceStore(db),
      resolveCachedRepo: () => new Promise(() => {}) as never,
    },
    { urls: ['https://h/seed.git'] },
    { userId: ownerUserId },
  )
  return result.snapshot.batchId
}

describeEachProviderWebSocketApplication(
  '/ws/repo-imports/{batchId} (RFC-033)',
  SCOPE_OPTIONS,
  (scope) => {
    let h: Harness
    beforeEach(async () => {
      h = await buildHarness(scope)
    })
    afterEach(async () => {
      __resetBatchImportForTests()
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
      // RFC-359 AC-20 —— 负向断言改走因果屏障（此前是「睡 50ms 再断言」，注释还
      // 写着「cannot be predicate-driven」）。本频道**没有 frameGate**
      // （`src/ws/registry.ts` 的 repo-import 只有 upgradeGate），所以
      // `gatedSubscribe` 里走的是同步 `sendJson` 分支：`broadcast()` 一返回，
      // 该送的帧就已经进了 socket。于是在跨批次那帧**之后**、往**本批次**再播一帧，
      // 等它到达即可——它和被断言的那帧同一条 socket、同一条同步投递路径，
      // 跨批次帧若真被错误路由，一定排在它前面已经到了。这是因果关系，不是概率。
      repoImportsBroadcaster.broadcast(REPO_IMPORT_CHANNEL(myBatch), {
        type: 'batch.completed',
        batchId: myBatch,
        completedAt: '2026-05-17T00:00:02.000Z',
      })
      await waitUntil(() => hasType(received, 'batch.completed'))
      sock.close()

      // 屏障帧到了（本批次的），跨批次那帧一条都没到。
      const types = received.map((m) => m.type)
      expect(types).toEqual(['hello', 'batch.completed'])
      expect(received.some((m) => (m as { batchId?: string }).batchId === otherBatch)).toBe(false)
    })

    test('missing token returns 401 (no upgrade)', async () => {
      const res = await fetch(`${h.httpUrl}/ws/repo-imports/some-batch`)
      expect(res.status).toBe(401)
    })
  },
)

// ---------------------------------------------------------------------------
// RFC-285 B6② —— 升级门矩阵（此前该频道无任何门：RFC-152 D4 登记缺口）。
// 判定：发起者 ∨ 资源管理员（admin/manager）通过；非发起者与批次缺行**同形
// 拒绝**（batch-not-found，HTTP 403 传输面）——错误形态探测不出批次存在性。
// ---------------------------------------------------------------------------

describeEachProviderWebSocketApplication(
  'RFC-285 B6② — /ws/repo-imports upgrade gate',
  SCOPE_OPTIONS,
  (scope) => {
    let h: Harness
    beforeEach(async () => {
      h = await buildHarness(scope)
    })
    afterEach(async () => {
      __resetBatchImportForTests()
    })

    async function upgradeStatus(batchId: string, token: string): Promise<number> {
      const res = await fetch(`${h.httpUrl}/ws/repo-imports/${batchId}?token=${token}`)
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
        `${h.httpUrl}/ws/repo-imports/${batchId}?token=${strangerToken}`,
      )
      const missingRes = await fetch(
        `${h.httpUrl}/ws/repo-imports/no-such-batch?token=${strangerToken}`,
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
  },
)
