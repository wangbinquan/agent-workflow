// RFC-259 — GitHub 入站集成锁（proposal AC-1/3/8/9/10/14 的 HTTP 层）：
//   HMAC 验签两态落 rejected 行、404 provider 同形（未知 provider + 跨 provider
//   token）、ping 200 ignored、X-GitHub-Delivery 去重 bump（Redeliver 复用同
//   GUID 的官方语义）、三段式 received、form content-type 误配的诊断路径、
//   管理面创建 github 端点、以及 **AC-14：github 投递可 replay**（事件头从
//   审计列重建——不修则 GitHub replay 全体 parse-failed，实现期自查 P0）。
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'
import { webhookDeliveries, webhookEndpoints, webhookTriggers } from '../src/db/schema'
import type { WebhookDispatcher } from '../src/services/webhook/dispatcherTypes'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SECRET = 'gh-webhook-secret'
const box = createSecretBoxFromKey(Buffer.alloc(32, 9))

const REPOSITORY = {
  full_name: 'acme/api',
  clone_url: 'https://github.com/acme/api.git',
  ssh_url: 'git@github.com:acme/api.git',
}

function pushBody(): string {
  return JSON.stringify({
    ref: 'refs/heads/feature/x',
    after: 'abc123',
    deleted: false,
    repository: REPOSITORY,
    sender: { login: 'dev-a' },
  })
}

function sig(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`
}

function ghHeaders(body: string, event = 'push', delivery = 'guid-1'): Record<string, string> {
  return {
    'x-hub-signature-256': sig(body),
    'x-github-event': event,
    'x-github-delivery': delivery,
  }
}

async function harness(opts?: { dispatcher?: WebhookDispatcher; configPath?: string }) {
  const db = createInMemoryDb(MIGRATIONS)
  const calls: string[] = []
  const dispatcher: WebhookDispatcher = opts?.dispatcher ?? {
    dispatch: async () => {},
    dispatchSubscription: async (input) => {
      calls.push(input.deliveryId)
    },
  }
  await db.insert(webhookEndpoints).values({
    id: 'ep-gh',
    name: 'github',
    provider: 'github',
    urlToken: 'aw_whk_gh1',
    secretEnc: box.seal(SECRET),
    enabled: true,
  })
  await db.insert(webhookTriggers).values({
    id: 'trigger-github-fixture',
    name: 'GitHub 入口回归规则',
    endpointId: 'ep-gh',
    ownerUserId: 'fixture-owner',
    repoScope: JSON.stringify({ kind: 'all' }),
    eventTypes: JSON.stringify(['push', 'pipeline_failed']),
    ignoreUsernames: '[]',
    launchKind: 'workflow',
    launchRefId: 'fixture-workflow',
    launchPayload: JSON.stringify({ inputs: {}, scratch: true }),
    templateSyntaxVersion: 2,
  })
  const admin = await createUser(db, {
    username: 'root',
    displayName: 'root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: admin.id })
  const app = createApp({
    token: 'a'.repeat(64),
    configPath: opts?.configPath ?? '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox: box,
    webhookDispatcher: dispatcher,
  })
  return { db, app, calls, adminToken: token }
}

type H = Awaited<ReturnType<typeof harness>>

function post(
  app: H['app'],
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(app.request(path, { method: 'POST', body, headers }))
}

const URL_GH = '/webhooks/github/aw_whk_gh1'

async function rows(db: DbClient) {
  return db.select().from(webhookDeliveries)
}

describe('RFC-259 · GitHub 入站状态码语义', () => {
  test('正确 HMAC → 200 received + 摘要列（事件头/判别符/去重 id 全落库）', async () => {
    const { app, db, calls } = await harness()
    const body = pushBody()
    const res = await post(app, URL_GH, body, ghHeaders(body))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { status: string }).status).toBe('received')
    const all = await rows(db)
    expect(all.length).toBe(1)
    expect(all[0]?.eventUuid).toBe('guid-1')
    expect(all[0]?.gitlabEventHeader).toBe('push') // D8：列语义 = provider 原始事件头
    expect(all[0]?.objectKind).toBe('push')
    expect(all[0]?.eventType).toBe('push')
    expect(all[0]?.repoPath).toBe('acme/api')
    expect(all[0]?.streamHint).toBe('acme/api|branch:feature/x')
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.length).toBe(1)
  })

  test('401 + rejected 行：签名错 / 签名缺（AC-1 的 HTTP 面）', async () => {
    const { app, db, calls } = await harness()
    const body = pushBody()
    const bad = await post(app, URL_GH, body, {
      ...ghHeaders(body),
      'x-hub-signature-256': sig(body, 'wrong-secret'),
    })
    expect(bad.status).toBe(401)
    const missing = await post(app, URL_GH, body, {
      'x-github-event': 'push',
      'x-github-delivery': 'guid-2',
    })
    expect(missing.status).toBe(401)
    expect((await rows(db)).map((r) => [r.status, r.statusReason]).sort()).toEqual([
      ['rejected', 'invalid-token'],
      ['rejected', 'missing-token'],
    ])
    expect(calls.length).toBe(0)
  })

  test('404 同形：未知 provider（gitea）/ github token 走 gitlab 路径（AC-9）', async () => {
    const { app } = await harness()
    const body = pushBody()
    const bodies: string[] = []
    for (const path of ['/webhooks/gitea/aw_whk_gh1', '/webhooks/gitlab/aw_whk_gh1']) {
      const res = await post(app, path, body, ghHeaders(body))
      expect(res.status).toBe(404)
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size).toBe(1)
  })

  test('ping → 200 + ignored(unsupported-event)（AC-8：GitHub 连通性测试拿绿勾）', async () => {
    const { app, db, calls } = await harness()
    const body = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 })
    const res = await post(app, URL_GH, body, ghHeaders(body, 'ping', 'guid-ping'))
    expect(res.status).toBe(200)
    const all = await rows(db)
    expect(all[0]?.status).toBe('ignored')
    expect(all[0]?.statusReason).toBe('unsupported-event')
    expect(calls.length).toBe(0)
  })

  test('同 X-GitHub-Delivery 重投（Redeliver 复用 GUID）→ 原行 bump、不重复分发（AC-3）', async () => {
    const { app, db, calls } = await harness()
    const body = pushBody()
    const r1 = await post(app, URL_GH, body, ghHeaders(body))
    const id1 = ((await r1.json()) as { deliveryId: string }).deliveryId
    const r2 = await post(app, URL_GH, body, ghHeaders(body))
    const b2 = (await r2.json()) as { deliveryId: string; status: string; attemptCount: number }
    expect(b2.status).toBe('duplicate')
    expect(b2.deliveryId).toBe(id1)
    expect(b2.attemptCount).toBe(2)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.length).toBe(1)
    expect((await rows(db)).length).toBe(1)
  })

  test('曾 rejected 的 GUID 修正签名后重投能落地（AC-3 后半——去重索引排除 rejected，评审门 F-6）', async () => {
    const { app, db } = await harness()
    const body = pushBody()
    const bad = await post(app, URL_GH, body, {
      ...ghHeaders(body, 'push', 'guid-R'),
      'x-hub-signature-256': sig(body, 'wrong-secret'),
    })
    expect(bad.status).toBe(401)
    const good = await post(app, URL_GH, body, ghHeaders(body, 'push', 'guid-R'))
    expect(good.status).toBe(200)
    expect(((await good.json()) as { status: string }).status).toBe('received')
    expect((await rows(db)).map((r) => r.status).sort()).toEqual(['matched', 'rejected'])
  })

  test('X-GitHub-Delivery 缺失 → 无去重逐条处理（F-18 降级平移）', async () => {
    const { app, db } = await harness()
    const body = pushBody()
    for (let i = 0; i < 2; i++) {
      const res = await post(app, URL_GH, body, {
        'x-hub-signature-256': sig(body),
        'x-github-event': 'push',
      })
      expect(((await res.json()) as { status: string }).status).toBe('received')
    }
    expect((await rows(db)).length).toBe(2)
  })

  test('content type 误配（form-urlencoded）→ 验签过、解析 400 + parse-failed（proposal §9 诊断路径）', async () => {
    const { app, db } = await harness()
    const form = `payload=${encodeURIComponent(pushBody())}`
    const res = await post(app, URL_GH, form, ghHeaders(form, 'push', 'guid-form'))
    expect(res.status).toBe(400)
    const all = await rows(db)
    expect(all[0]?.status).toBe('ignored')
    expect(all[0]?.statusReason).toBe('parse-failed')
  })
})

describe('RFC-259 · 管理面 github 端点（AC-10）', () => {
  test('创建 provider=github → 持久化 + ingressUrl 含 /webhooks/github/ 路径段', async () => {
    // ingressUrl 只由 publicBaseUrl 拼装（禁 c.req.url）——喂真实 config 文件断言
    // 完整 URL 形态（评审门 F-3：此前无任何测试锁 github 的 ingressUrl 段）。
    const configPath = join(mkdtempSync(join(tmpdir(), 'rfc259-cfg-')), 'config.json')
    writeFileSync(configPath, JSON.stringify({ publicBaseUrl: 'https://aw.example.com' }))
    const { app, adminToken } = await harness({ configPath })
    const res = await app.request('/api/webhook-endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'GitHub.com', provider: 'github' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      provider: string
      urlToken: string
      secret: string
      ingressUrl: string | null
    }
    expect(body.provider).toBe('github')
    expect(body.secret.length).toBeGreaterThan(20)
    expect(body.ingressUrl).toBe(`https://aw.example.com/webhooks/github/${body.urlToken}`)
    // provider 不可变：strict PUT 对 provider 键 422（既有语义在 github 值域下同样成立）
    const created = body as unknown as { id: string }
    const put = await app.request(`/api/webhook-endpoints/${created.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gitlab' }),
    })
    expect(put.status).toBe(422)
  })
})

describe('RFC-259 · GitHub 投递 replay（AC-14——实现期自查 P0 回归锁）', () => {
  test('入站落库的 github 投递可 replay：事件头从审计列重建、新行指回原行、分发发生', async () => {
    const { app, db, calls, adminToken } = await harness()
    const body = JSON.stringify({
      action: 'completed',
      workflow_run: {
        head_branch: 'feature/x',
        head_sha: 'abc123',
        conclusion: 'failure',
        actor: { login: 'dev-a' },
        pull_requests: [],
      },
      repository: REPOSITORY,
      sender: { login: 'dev-a' },
    })
    const ingress = await post(app, URL_GH, body, ghHeaders(body, 'workflow_run', 'guid-wr'))
    expect(ingress.status).toBe(200)
    const deliveryId = ((await ingress.json()) as { deliveryId: string }).deliveryId
    // fake dispatcher 不推进状态；replay 前置要求终态——手动落 matched 模拟分发完成
    const { eq } = await import('drizzle-orm')
    await db
      .update(webhookDeliveries)
      .set({ status: 'matched' })
      .where(eq(webhookDeliveries.id, deliveryId))

    const replay = await app.request(`/api/webhook-deliveries/${deliveryId}/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(replay.status).toBe(200)
    const rb = (await replay.json()) as { deliveryId: string; replayedFrom: string }
    expect(rb.replayedFrom).toBe(deliveryId)
    const all = await rows(db)
    expect(all.length).toBe(2)
    const replayRow = all.find((r) => r.id === rb.deliveryId)
    expect(replayRow?.replayedFromDeliveryId).toBe(deliveryId)
    expect(replayRow?.eventUuid).toBeNull() // 绕过去重
    expect(replayRow?.eventType).toBe('pipeline_failed') // 归一化成功 = 事件头重建生效
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toContain(rb.deliveryId)
  })
})
