// RFC-257 T5 — 入站端点集成锁：状态码语义矩阵逐行（design §3.3 / AC-1..5）+
// 三段式（响应先于分发完成返回）+ 去重（AC-3 含 rejected 后重投可落地）+
// 限流 fake clock + 未认证可达（本文件所有请求都不带任何平台凭据——路由在
// /api/* 之外、经 publicReason 声明公开，若有人把它挪进鉴权面，整个文件红）。
import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Hono } from 'hono'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { webhookDeliveries, webhookEndpoints, webhookTriggers } from '../src/db/schema'
import type {
  EventCenterCodeHostDeliveryDispatcher,
  WebhookDispatcher,
} from '../src/services/webhook/dispatcherTypes'
import type { EventCenterModule } from '../src/modules/event-center/composition'
import { createSqliteWebhookDeliveryPersistence } from '../src/modules/integration/infrastructure/sqliteWebhookDeliveryPersistence'
import { composeSqliteWebhookIngressPersistence } from '../src/modules/integration/composition/webhookIngress'
import { composeEventCenter } from '../src/modules/event-center/composition'
import {
  createCodeHostWebhookDeliveryConsumer,
  createCodeHostWebhookRoutingDirectory,
} from '../src/modules/integration/composition'
import { codeHostEventCatalogJson } from '../src/modules/integration/public/events'
import { mountWebhookIngressRoutes } from '../src/routes/webhooks'
import { createWebhookRateLimiters } from '../src/services/webhook/rateLimiter'
import { recoverInterruptedDeliveries } from '../src/services/webhook/deliveryStore'
import { eq } from 'drizzle-orm'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SECRET = 's3cret-token-for-gitlab'
const box = createSecretBoxFromKey(Buffer.alloc(32, 7))

type DispatchCall = { deliveryId: string }

type IngressDispatcher = WebhookDispatcher & EventCenterCodeHostDeliveryDispatcher

function fakeDispatcher(): { dispatcher: IngressDispatcher; calls: DispatchCall[] } {
  const calls: DispatchCall[] = []
  return {
    calls,
    dispatcher: {
      dispatch: async () => {},
      dispatchSubscription: async (input) => {
        calls.push({ deliveryId: input.deliveryId })
      },
    },
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

async function harness(opts?: {
  dispatcher?: IngressDispatcher
  enabled?: boolean
  omitDispatcher?: boolean
  digitalEmployeeEventCenter?: EventCenterModule
}): Promise<{
  db: DbClient
  app: Hono
  calls: DispatchCall[]
}> {
  const db = createInMemoryDb(MIGRATIONS)
  const fake = fakeDispatcher()
  await db.insert(webhookEndpoints).values({
    id: 'ep-1',
    name: 'gitlab',
    provider: 'gitlab',
    urlToken: 'aw_whk_tok1',
    secretEnc: box.seal(SECRET),
    enabled: opts?.enabled ?? true,
  })
  await db.insert(webhookTriggers).values({
    id: 'trigger-ingress-fixture',
    name: '入口回归规则',
    endpointId: 'ep-1',
    ownerUserId: 'fixture-owner',
    repoScope: JSON.stringify({ kind: 'all' }),
    eventTypes: JSON.stringify(['push', 'pipeline_failed']),
    ignoreUsernames: '[]',
    launchKind: 'workflow',
    launchRefId: 'fixture-workflow',
    launchPayload: JSON.stringify({ inputs: {}, scratch: true }),
    templateSyntaxVersion: 2,
  })
  const dispatcher = opts?.dispatcher ?? fake.dispatcher
  const eventCenter =
    opts?.digitalEmployeeEventCenter ??
    (await composeEventCenter({
      db,
      typePackageDescriptorJsons: [codeHostEventCatalogJson],
      routingSubscriptions: createCodeHostWebhookRoutingDirectory(db),
      deliveryConsumers: opts?.omitDispatcher
        ? []
        : [createCodeHostWebhookDeliveryConsumer(db, dispatcher)],
    }))
  const app = new Hono()
  mountWebhookIngressRoutes(app, {
    webhookIngressPersistence: composeSqliteWebhookIngressPersistence(db),
    secretBox: box,
    digitalEmployeeEventCenter: eventCenter,
    ...(opts?.omitDispatcher ? {} : { webhookDispatcher: dispatcher }),
  })
  return { db, app, calls: fake.calls }
}

function pushBody(): string {
  return JSON.stringify({
    object_kind: 'push',
    ref: 'refs/heads/feature/x',
    after: 'abc123',
    user_username: 'dev-a',
    project: {
      path_with_namespace: 'platform/api',
      git_http_url: 'https://gitlab.example.com/platform/api.git',
      git_ssh_url: 'git@gitlab.example.com:platform/api.git',
    },
  })
}

function post(
  app: Hono,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(app.request(path, { method: 'POST', body, headers }))
}

const URL_OK = '/webhooks/gitlab/aw_whk_tok1'
const H_OK = { 'x-gitlab-token': SECRET, 'x-gitlab-event-uuid': 'uuid-1' }

async function deliveryRows(db: DbClient) {
  return db.select().from(webhookDeliveries)
}

describe('RFC-257 T5 · 状态码语义矩阵', () => {
  test('404 同形：provider 未知 / token 不存在 / provider 与端点不匹配', async () => {
    const { app } = await harness()
    const bodies: string[] = []
    for (const path of ['/webhooks/github/aw_whk_tok1', '/webhooks/gitlab/nope']) {
      const res = await post(app, path, pushBody(), H_OK)
      expect(res.status).toBe(404)
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size).toBe(1) // 同形：响应体逐字节一致，不泄露端点存在性
  })

  test('401 + rejected 行：token 错 / token 缺（AC-1）', async () => {
    const { app, db, calls } = await harness()
    const bad = await post(app, URL_OK, pushBody(), { 'x-gitlab-token': 'wrong' })
    expect(bad.status).toBe(401)
    const missing = await post(app, URL_OK, pushBody(), {})
    expect(missing.status).toBe(401)
    const rows = await deliveryRows(db)
    expect(rows.map((r) => [r.status, r.statusReason]).sort()).toEqual([
      ['rejected', 'invalid-token'],
      ['rejected', 'missing-token'],
    ])
    expect(calls.length).toBe(0)
  })

  test('端点禁用 → 200 + ignored（绝不 4xx：GitLab auto-disable）', async () => {
    const { app, db, calls } = await harness({ enabled: false })
    const res = await post(app, URL_OK, pushBody(), H_OK)
    expect(res.status).toBe(200)
    const rows = await deliveryRows(db)
    expect(rows[0]?.status).toBe('ignored')
    expect(rows[0]?.statusReason).toBe('endpoint-disabled')
    expect(calls.length).toBe(0)
  })

  test('不支持的事件 → 200 + ignored(unsupported-event)；非 JSON → 400 + parse-failed', async () => {
    const { app, db } = await harness()
    const running = JSON.stringify({
      object_kind: 'pipeline',
      user: { username: 'u' },
      project: JSON.parse(pushBody()).project,
      object_attributes: { ref: 'x', status: 'running' },
    })
    const r1 = await post(app, URL_OK, running, H_OK)
    expect(r1.status).toBe(200)
    const r2 = await post(app, URL_OK, 'not-json{{', {
      'x-gitlab-token': SECRET,
      'x-gitlab-event-uuid': 'uuid-2',
    })
    expect(r2.status).toBe(400)
    const rows = await deliveryRows(db)
    expect(rows.map((r) => r.statusReason).sort()).toEqual(['parse-failed', 'unsupported-event'])
  })

  test('body 超限 → 413，不落行', async () => {
    const { app, db } = await harness()
    const big = `{"pad":"${'x'.repeat(1024 * 1024 + 10)}"}`
    const res = await post(app, URL_OK, big, H_OK)
    expect(res.status).toBe(413)
    expect((await deliveryRows(db)).length).toBe(0)
  })
})

describe('RFC-257 T5 · 三段式与去重', () => {
  test('MR webhook delegates its low-latency hint to Event Center observer control', async () => {
    const nudges: Array<{ id: string; revision: number }> = []
    const digitalEmployeeEventCenter = {
      observerControl: {
        nudgeSource(ref: { id: string; revision: number }) {
          nudges.push(ref)
          return true
        },
      },
      participant: {},
      commands: {
        observe() {
          return { eventId: 'event-stub', duplicate: false, deliveryCount: 0, deliveryIds: [] }
        },
      },
      queries: {},
      worker: {
        async runOneNotification() {
          return 'idle' as const
        },
      },
    } as unknown as EventCenterModule
    const { app } = await harness({ digitalEmployeeEventCenter })

    const push = await post(app, URL_OK, pushBody(), H_OK)
    expect(push.status).toBe(200)
    expect(nudges).toEqual([])

    const pipeline = await post(
      app,
      URL_OK,
      JSON.stringify({
        object_kind: 'pipeline',
        user: { username: 'aw-bot' },
        project: JSON.parse(pushBody()).project,
        object_attributes: { id: 1, ref: 'feature/x', status: 'failed', sha: 'abc' },
        merge_request: { iid: 42, source_branch: 'feature/x', target_branch: 'main' },
      }),
      {
        'x-gitlab-token': SECRET,
        'x-gitlab-event': 'Pipeline Hook',
        'x-gitlab-event-uuid': 'uuid-pipeline-nudge',
      },
    )
    expect(pipeline.status).toBe(200)
    expect(nudges).toEqual([{ id: 'code-host.activity', revision: 1 }])
  })

  test('接收成功：200 + matched 路由审计 + 独立事件投递（AC-5 前半）', async () => {
    const { app, db, calls } = await harness()
    const res = await post(app, URL_OK, pushBody(), H_OK)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deliveryId: string; status: string }
    expect(body.status).toBe('received')
    const rows = await deliveryRows(db)
    expect(rows[0]?.status).toBe('matched')
    expect(rows[0]?.eventType).toBe('push')
    expect(rows[0]?.repoPath).toBe('platform/api')
    expect(rows[0]?.streamHint).toBe('platform/api|branch:feature/x')
    // 异步分发在微任务里排队；推进事件循环一拍后应已到达 fake dispatcher
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.map((c) => c.deliveryId)).toEqual([body.deliveryId])
  })

  test('响应先于分发完成返回（AC-5：dispatch 挂起时响应已回）', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let started = false
    const { app } = await harness({
      dispatcher: {
        dispatch: async () => {},
        dispatchSubscription: async () => {
          started = true
          await gate
        },
      },
    })
    const res = await post(app, URL_OK, pushBody(), H_OK)
    expect(res.status).toBe(200) // dispatch 永久挂起中，响应已经回来了
    await new Promise((r) => setTimeout(r, 10))
    expect(started).toBe(true)
    release()
  })

  test('同 UUID 重投：不重复分发、原行 bump（AC-3）', async () => {
    const { app, db, calls } = await harness()
    const r1 = await post(app, URL_OK, pushBody(), H_OK)
    const id1 = ((await r1.json()) as { deliveryId: string }).deliveryId
    const r2 = await post(app, URL_OK, pushBody(), H_OK)
    expect(r2.status).toBe(200)
    const body2 = (await r2.json()) as { deliveryId: string; status: string; attemptCount: number }
    expect(body2.status).toBe('duplicate')
    expect(body2.deliveryId).toBe(id1)
    expect(body2.attemptCount).toBe(2)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.length).toBe(1)
    expect((await deliveryRows(db)).length).toBe(1)
  })

  test('业务事实发布失败释放 UUID 重投，已发布的兼容事实保持幂等', async () => {
    const observations: Array<{ dedupeKey: string }> = []
    const digitalEmployeeEventCenter = {
      observerControl: {
        nudgeSource() {
          return false
        },
      },
      participant: {},
      commands: {
        observe(input: { dedupeKey: string }) {
          observations.push(input)
          // The compatibility occurrence is already durable when publication
          // of the public business fact fails.
          if (observations.length === 2) throw new Error('fixture event publication failed')
          return {
            eventId: 'event-after-retry',
            duplicate: false,
            deliveryCount: 0,
            deliveryIds: [],
          }
        },
      },
      queries: {},
      worker: {
        async runOneNotification() {
          return 'idle' as const
        },
      },
    } as unknown as EventCenterModule
    const { app, db } = await harness({ digitalEmployeeEventCenter })

    const first = await post(app, URL_OK, pushBody(), H_OK)
    expect(first.status).toBe(500)
    expect(await deliveryRows(db)).toMatchObject([
      { status: 'failed', statusReason: 'internal-error' },
    ])

    const second = await post(app, URL_OK, pushBody(), H_OK)
    expect(second.status).toBe(200)
    expect((await second.json()) as { status: string }).toMatchObject({ status: 'received' })
    const rows = await deliveryRows(db)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    expect(rows.map((row) => row.status).sort()).toEqual(['failed', 'ignored'])
    expect(observations).toHaveLength(4)
    expect(observations[0]!.dedupeKey).toBe(observations[2]!.dedupeKey)
    expect(observations[1]!.dedupeKey).toBe(observations[3]!.dedupeKey)
    expect(observations[0]!.dedupeKey).toContain('uuid-1')
    expect(observations[1]!.dedupeKey).toContain('code-host-fact')
    expect(observations[1]!.dedupeKey).toContain('uuid-1')
  })

  test('rejected 后同 UUID 重投能落地（AC-3 · 去重索引排除 rejected）', async () => {
    const { app, db } = await harness()
    const bad = await post(app, URL_OK, pushBody(), {
      'x-gitlab-token': 'wrong',
      'x-gitlab-event-uuid': 'uuid-R',
    })
    expect(bad.status).toBe(401)
    const good = await post(app, URL_OK, pushBody(), {
      'x-gitlab-token': SECRET,
      'x-gitlab-event-uuid': 'uuid-R',
    })
    expect(good.status).toBe(200)
    expect(((await good.json()) as { status: string }).status).toBe('received')
    const rows = await deliveryRows(db)
    expect(rows.map((r) => r.status).sort()).toEqual(['matched', 'rejected'])
  })

  test('UUID 缺失 → 无去重，逐条处理（F-18 降级模式）', async () => {
    const { app, db, calls } = await harness()
    for (let i = 0; i < 2; i++) {
      const res = await post(app, URL_OK, pushBody(), { 'x-gitlab-token': SECRET })
      expect(((await res.json()) as { status: string }).status).toBe('received')
    }
    await new Promise((r) => setTimeout(r, 10))
    expect((await deliveryRows(db)).length).toBe(2)
    expect(calls.length).toBe(2)
  })
})

describe('RFC-257 T5 · 限流（fake clock）与装配自我跳过', () => {
  test('per-endpoint 300/min：超限 429，时间前进后恢复', async () => {
    let now = 1_000_000
    const limiters = createWebhookRateLimiters(() => now)
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookEndpoints).values({
      id: 'ep-1',
      name: 'gitlab',
      provider: 'gitlab',
      urlToken: 'aw_whk_tok1',
      secretEnc: box.seal(SECRET),
      enabled: true,
    })
    // 直接用路由模块 + 自建 app 注入 fake clock 限流器
    const fake = fakeDispatcher()
    const app = new Hono()
    mountWebhookIngressRoutes(
      app,
      {
        webhookIngressPersistence: composeSqliteWebhookIngressPersistence(db),
        secretBox: box,
        webhookDispatcher: fake.dispatcher,
        digitalEmployeeEventCenter: {
          commands: {
            observe() {
              return {
                eventId: 'limiter-event',
                duplicate: false,
                deliveryCount: 0,
                deliveryIds: [],
              }
            },
          },
          worker: {
            async runOneNotification() {
              return 'idle' as const
            },
          },
          observerControl: {
            nudgeSource() {
              return false
            },
          },
        } as unknown as EventCenterModule,
      },
      { limiters },
    )
    for (let i = 0; i < 300; i++) {
      const res = await post(app as never, URL_OK, pushBody(), { 'x-gitlab-token': SECRET })
      expect(res.status).toBe(200)
    }
    const blocked = await post(app as never, URL_OK, pushBody(), { 'x-gitlab-token': SECRET })
    expect(blocked.status).toBe(429)
    now += 61_000 // fake clock 前进一个窗口
    const recovered = await post(app as never, URL_OK, pushBody(), { 'x-gitlab-token': SECRET })
    expect(recovered.status).toBe(200)
  })

  test('装配缺 dispatcher → 路由不挂载（部分装配不暴露必 500 公开路由）', async () => {
    const { app } = await harness({ omitDispatcher: true })
    const res = await post(app, URL_OK, pushBody(), H_OK)
    expect(res.status).toBe(404)
  })
})

describe('RFC-257 T5 · daemon 重启恢复（D23）', () => {
  test('遗留 received/processing → failed(interrupted)；终态不动', async () => {
    const { db, app } = await harness()
    const accepted = await post(app, URL_OK, pushBody(), H_OK)
    const acceptedId = ((await accepted.json()) as { deliveryId: string }).deliveryId
    await db
      .update(webhookDeliveries)
      .set({ status: 'processing' })
      .where(eq(webhookDeliveries.id, acceptedId))
    await post(app, URL_OK, pushBody(), {
      'x-gitlab-token': 'wrong',
      'x-gitlab-event-uuid': 'uuid-X',
    }) // rejected（终态）
    const n = await recoverInterruptedDeliveries(createSqliteWebhookDeliveryPersistence(db))
    expect(n).toBe(1)
    const rows = await deliveryRows(db)
    const byStatus = rows.map((r) => [r.status, r.statusReason]).sort()
    expect(byStatus).toEqual([
      ['failed', 'interrupted'],
      ['rejected', 'invalid-token'],
    ])
  })
})
