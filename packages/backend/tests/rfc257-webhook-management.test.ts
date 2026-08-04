// RFC-257 T7/T8/T9 — 管理面集成锁：
//   端点（manage 权限、secret 一次性明文 + 掩码 hint、轮换、restrict 删除）；
//   触发器（owner 制 404 同形、保存期三层校验、kind/endpoint 不可变、级联）；
//   投递（manage 读、replay 三规则）。AC-14/15/16/17 的落点。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'
import {
  webhookDeliveries,
  webhookTriggerFires,
  webhookTriggerStreams,
  workflows,
} from '../src/db/schema'
import type { WebhookDispatcher } from '../src/services/webhook/dispatcherTypes'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 5))

type User = { id: string; token: string }

async function mkUser(db: DbClient, username: string, role: 'admin' | 'user'): Promise<User> {
  const u = await createUser(db, {
    username,
    displayName: username,
    role,
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: u.id })
  return { id: u.id, token }
}

async function harness() {
  const db = createInMemoryDb(MIGRATIONS)
  const admin = await mkUser(db, 'root', 'admin')
  const alice = await mkUser(db, 'alice', 'admin')
  const bob = await mkUser(db, 'bob', 'user')
  const dispatched: string[] = []
  const dispatcher: WebhookDispatcher = {
    dispatch: async (input) => {
      dispatched.push(input.deliveryId)
    },
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify({
      $schema_version: 1,
      inputs: [
        { kind: 'text', key: 'prompt', label: 'p', required: true },
        { kind: 'git', key: 'mr_ref', label: 'g', required: true },
        { kind: 'enum', key: 'mode', label: 'm', required: false, values: ['a'] },
      ],
      nodes: [],
      edges: [],
    }),
    version: 1,
    ownerUserId: alice.id,
    visibility: 'private', // RFC-231 语义（raw insert 的 public default 是 legacy 兼容）
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const app = createApp({
    token: 'a'.repeat(64),
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox: box,
    webhookDispatcher: dispatcher,
  })
  return { db, app, admin, alice, bob, workflowId, dispatched }
}

type App = Awaited<ReturnType<typeof harness>>['app']

async function call(
  app: App,
  user: User,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${user.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const VALID_PAYLOAD = {
  inputs: {
    prompt: { kind: 'template', template: '修 {{repo_path}}' },
    mr_ref: { kind: 'event-branch' },
  },
}

async function createEndpoint(app: App, admin: User): Promise<{ id: string; secret: string }> {
  const res = await call(app, admin, 'POST', '/api/webhook-endpoints', { name: '内网 GitLab' })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { id: string; secret: string }
  return body
}

function triggerBody(endpointId: string, workflowId: string, overrides: object = {}) {
  return {
    name: 'MR 审计',
    endpointId,
    repoScope: { kind: 'prefix', prefix: 'platform/' },
    eventTypes: ['mr_opened', 'mr_updated'],
    launchKind: 'workflow',
    launchRefId: workflowId,
    launchPayload: VALID_PAYLOAD,
    ...overrides,
  }
}

describe('RFC-257 T7 · 端点管理', () => {
  test('创建：201 + 一次性 secret；GET 只有掩码 hint；普通用户 403（AC-15 权限面）', async () => {
    const h = await harness()
    const res = await call(h.app, h.admin, 'POST', '/api/webhook-endpoints', { name: 'gl' })
    expect(res.status).toBe(201)
    const created = (await res.json()) as Record<string, unknown>
    expect(typeof created['secret']).toBe('string')
    expect((created['urlToken'] as string).startsWith('aw_whk_')).toBe(true)
    const list = await call(h.app, h.admin, 'GET', '/api/webhook-endpoints')
    const rows = (await list.json()) as Array<Record<string, unknown>>
    expect(rows.length).toBe(1)
    expect('secret' in rows[0]!).toBe(false) // 全出口掩码（AC-15）
    expect(rows[0]!['hasSecret']).toBe(true)
    expect((rows[0]!['secretHint'] as string).length).toBe(4)
    expect((created['secret'] as string).endsWith(rows[0]!['secretHint'] as string)).toBe(true)
    // 普通用户无 manage 权限
    const denied = await call(h.app, h.bob, 'GET', '/api/webhook-endpoints')
    expect(denied.status).toBe(403)
  })

  test('轮换 secret：新明文一次性返回且 hint 更新；轮换 url token 改变入站地址', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const rot = await call(h.app, h.admin, 'POST', `/api/webhook-endpoints/${ep.id}/rotate-secret`)
    expect(rot.status).toBe(200)
    const rotated = (await rot.json()) as { secret: string; secretHint: string }
    expect(rotated.secret).not.toBe(ep.secret)
    expect(rotated.secret.endsWith(rotated.secretHint)).toBe(true)
    const tok = await call(
      h.app,
      h.admin,
      'POST',
      `/api/webhook-endpoints/${ep.id}/rotate-url-token`,
    )
    expect(tok.status).toBe(200)
  })

  test('删除 restrict：有触发器引用 → 409；清空后可删', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const t = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId),
    )
    expect(t.status).toBe(201)
    const tid = ((await t.json()) as { id: string }).id
    const del = await call(h.app, h.admin, 'DELETE', `/api/webhook-endpoints/${ep.id}`)
    expect(del.status).toBe(409)
    await call(h.app, h.alice, 'DELETE', `/api/webhook-triggers/${tid}`)
    const del2 = await call(h.app, h.admin, 'DELETE', `/api/webhook-endpoints/${ep.id}`)
    expect(del2.status).toBe(200)
  })
})

describe('RFC-257 T8 · 触发器管理（owner 制）', () => {
  test('创建成功（保存期校验通过）；owner 可见、他人 404 同形、admin 旁路（AC-17）', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const res = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId),
    )
    expect(res.status).toBe(201)
    const tid = ((await res.json()) as { id: string }).id
    // owner 列表可见
    const mine = (await (
      await call(h.app, h.alice, 'GET', '/api/webhook-triggers')
    ).json()) as unknown[]
    expect(mine.length).toBe(1)
    // UI 修订收紧：webhook 面 admin-only —— user 角色连方法门都过不去（403），
    // 行级 owner 语义只在 admin 间保留（resource-admin 旁路全可见）。
    expect((await call(h.app, h.bob, 'GET', '/api/webhook-triggers')).status).toBe(403)
    expect((await call(h.app, h.bob, 'GET', `/api/webhook-triggers/${tid}`)).status).toBe(403)
    expect(
      (await call(h.app, h.bob, 'POST', '/api/webhook-triggers', triggerBody('ep-x', 'wf-x')))
        .status,
    ).toBe(403)
    // admin 旁路
    expect((await call(h.app, h.admin, 'GET', `/api/webhook-triggers/${tid}`)).status).toBe(200)
  })

  test('保存期校验组（AC-14）：未知变量 / 必填未映射 / enum 映射 / 目标不可见', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    // 未知模板变量
    const badVar = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId, {
        launchPayload: {
          inputs: {
            prompt: { kind: 'template', template: '{{nope}}' },
            mr_ref: { kind: 'event-branch' },
          },
        },
      }),
    )
    expect(badVar.status).toBe(422)
    // 交集外变量：mr_* 事件不提供 pipeline_status
    const unavailable = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId, {
        launchPayload: {
          inputs: {
            prompt: { kind: 'template', template: '{{pipeline_status}}' },
            mr_ref: { kind: 'event-branch' },
          },
        },
      }),
    )
    expect(unavailable.status).toBe(422)
    // 必填输入未映射
    const missingRequired = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId, {
        launchPayload: { inputs: { prompt: { kind: 'template', template: 'x' } } },
      }),
    )
    expect(missingRequired.status).toBe(422)
    // enum 输入不可映射
    const enumMapped = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId, {
        launchPayload: {
          inputs: {
            ...VALID_PAYLOAD.inputs,
            mode: { kind: 'template', template: 'a' },
          },
        },
      }),
    )
    expect(enumMapped.status).toBe(422)
    // 目标 workflow 不存在 → 彩排 gate 404（admin 对存量全可见，剩余拒绝面
    // 是存在性/builtin/upload——「保存者身份」在 admin-only 下由 gate 的
    // canViewResource 继续承载）
    const missingTarget = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, 'missing-wf'),
    )
    expect(missingTarget.status).toBe(404)
  })

  test('PUT：kind/endpoint 不可变 422；合法 patch 生效；DELETE 级联 fires/streams', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const created = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId),
    )
    const tid = ((await created.json()) as { id: string }).id
    const kindChange = await call(h.app, h.alice, 'PUT', `/api/webhook-triggers/${tid}`, {
      launchKind: 'agent',
    })
    expect(kindChange.status).toBe(422)
    const ok = await call(h.app, h.alice, 'PUT', `/api/webhook-triggers/${tid}`, {
      name: '改名',
      maxConsecutiveFires: 5,
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { maxConsecutiveFires: number }).maxConsecutiveFires).toBe(5)
    // 级联：手工塞 fires/streams 后 DELETE
    await h.db.insert(webhookTriggerFires).values({
      id: ulid(),
      deliveryId: 'd-x',
      triggerId: tid,
      streamKey: 's',
      outcome: 'launched',
    })
    await h.db.insert(webhookTriggerStreams).values({
      triggerId: tid,
      streamKey: 's',
      consecutiveFires: 2,
    })
    expect((await call(h.app, h.alice, 'DELETE', `/api/webhook-triggers/${tid}`)).status).toBe(200)
    expect((await h.db.select().from(webhookTriggerFires)).length).toBe(0)
    expect((await h.db.select().from(webhookTriggerStreams)).length).toBe(0)
  })

  test('streams reset：owner 归零计数并记审计（AC-10 人工重置源）', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const created = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId),
    )
    const tid = ((await created.json()) as { id: string }).id
    await h.db.insert(webhookTriggerStreams).values({
      triggerId: tid,
      streamKey: 'platform/api|mr:7',
      consecutiveFires: 3,
    })
    const res = await call(h.app, h.alice, 'POST', `/api/webhook-triggers/${tid}/streams/reset`, {
      streamKey: 'platform/api|mr:7',
    })
    expect(res.status).toBe(200)
    const row = (await h.db.select().from(webhookTriggerStreams))[0]
    expect(row?.consecutiveFires).toBe(0)
    expect(row?.resetBy).toBe(h.alice.id)
  })
})

describe('RFC-257 T9 · 投递观测与重放', () => {
  async function seedDelivery(
    db: DbClient,
    endpointId: string,
    overrides: Partial<typeof webhookDeliveries.$inferInsert> = {},
  ): Promise<string> {
    const id = ulid()
    await db.insert(webhookDeliveries).values({
      id,
      endpointId,
      eventUuid: overrides.eventUuid ?? null,
      status: overrides.status ?? 'matched',
      bodyJson:
        overrides.bodyJson !== undefined
          ? overrides.bodyJson
          : JSON.stringify({
              object_kind: 'push',
              ref: 'refs/heads/main',
              user_username: 'dev-a',
              project: {
                path_with_namespace: 'platform/api',
                git_http_url: 'https://gitlab.example.com/platform/api.git',
                git_ssh_url: 'git@gitlab.example.com:platform/api.git',
              },
            }),
      ...overrides,
    })
    return id
  }

  test('列表/详情：manage 权限；列表不含 body、详情含（AC-16 面）', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const id = await seedDelivery(h.db, ep.id)
    const denied = await call(h.app, h.bob, 'GET', '/api/webhook-deliveries')
    expect(denied.status).toBe(403)
    const list = (await (
      await call(h.app, h.admin, 'GET', '/api/webhook-deliveries')
    ).json()) as Array<Record<string, unknown>>
    expect(list.length).toBe(1)
    expect('bodyJson' in list[0]!).toBe(false)
    const detail = (await (
      await call(h.app, h.admin, 'GET', `/api/webhook-deliveries/${id}`)
    ).json()) as Record<string, unknown>
    expect(typeof detail['bodyJson']).toBe('string')
  })

  test('replay 三规则：rejected 409 / body-gone 409 / 正常 → 新行 received + dispatcher（AC-16）', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const rejected = await seedDelivery(h.db, ep.id, { status: 'rejected' })
    expect(
      (await call(h.app, h.admin, 'POST', `/api/webhook-deliveries/${rejected}/replay`)).status,
    ).toBe(409)
    const pruned = await seedDelivery(h.db, ep.id, { bodyJson: null })
    expect(
      (await call(h.app, h.admin, 'POST', `/api/webhook-deliveries/${pruned}/replay`)).status,
    ).toBe(409)
    const good = await seedDelivery(h.db, ep.id, { eventUuid: 'uuid-orig' })
    const res = await call(h.app, h.admin, 'POST', `/api/webhook-deliveries/${good}/replay`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deliveryId: string; replayedFrom: string }
    expect(body.replayedFrom).toBe(good)
    const newRow = (
      await h.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, body.deliveryId))
    )[0]
    expect(newRow?.eventUuid).toBeNull() // 规则 3：绕过去重
    expect(newRow?.replayedFromDeliveryId).toBe(good) // 规则 2：指回原行
    await new Promise((r) => setTimeout(r, 10))
    expect(h.dispatched).toEqual([body.deliveryId])
  })
})
