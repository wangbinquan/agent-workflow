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
  webhookTriggers,
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
    prompt: { kind: 'template', template: '修 {{trigger.webhook.repo_path}}' },
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
    // RFC-260 改判：读面全员开放（原 403），但 URL 明文只走 admin session——
    // 普通用户拿 null + 尾 4 hint，响应体不含 urlToken 明文。
    const readonly = await call(h.app, h.bob, 'GET', '/api/webhook-endpoints')
    expect(readonly.status).toBe(200)
    const bobRows = (await readonly.json()) as Array<Record<string, unknown>>
    expect(bobRows[0]!['urlToken']).toBeNull()
    expect(bobRows[0]!['ingressUrl']).toBeNull()
    expect((bobRows[0]!['urlTokenHint'] as string).length).toBe(4)
    expect(JSON.stringify(bobRows)).not.toContain(rows[0]!['urlToken'] as string)
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
  test('创建成功（保存期校验通过）；读全量可见（RFC-260 D1 改判原 AC-17 owner-404）、写 admin 独占', async () => {
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
    // RFC-260 D1 改判：触发器全量只读——user 也能列出他人的触发器（原 403/
    // owner-404 读语义显式退役）；写面仍被方法门挡（rfc260 矩阵测试锁定）。
    const bobList = await call(h.app, h.bob, 'GET', '/api/webhook-triggers')
    expect(bobList.status).toBe(200)
    expect(((await bobList.json()) as unknown[]).length).toBe(1)
    expect((await call(h.app, h.bob, 'GET', `/api/webhook-triggers/${tid}`)).status).toBe(200)
    // 写入口仍 admin-only（webhook-triggers:create 不在 user 基线）
    expect(
      (await call(h.app, h.bob, 'POST', '/api/webhook-triggers', triggerBody('ep-x', 'wf-x')))
        .status,
    ).toBe(403)
    // admin 旁路
    expect((await call(h.app, h.admin, 'GET', `/api/webhook-triggers/${tid}`)).status).toBe(200)
  })

  test('RFC-310 T104：新建 code-round 触发器被拒（writer 已退役）', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const res = await call(h.app, h.alice, 'POST', '/api/webhook-triggers', {
      ...triggerBody(ep.id, h.workflowId),
      launchKind: 'code-round',
      launchRefId: 'mr-review',
      launchPayload: { capability: 'mr-review' },
    })
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('webhook-trigger-kind-retired')
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
            prompt: {
              kind: 'template',
              template: '{{trigger.webhook.pipeline_status}}',
            },
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

  test('PUT 修复不可迁移的 v1 payload 后立即写成 canonical v2', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const id = ulid()
    await h.db.insert(webhookTriggers).values({
      id,
      name: '待修复旧触发器',
      endpointId: ep.id,
      ownerUserId: h.alice.id,
      repoScope: JSON.stringify({ kind: 'prefix', prefix: 'platform/' }),
      eventTypes: JSON.stringify(['mr_opened', 'mr_updated']),
      ignoreUsernames: '[]',
      launchKind: 'workflow',
      launchRefId: h.workflowId,
      launchPayload: JSON.stringify({
        inputs: {
          prompt: { kind: 'template', template: '{{nope}}' },
          mr_ref: { kind: 'event-branch' },
        },
      }),
      templateSyntaxVersion: 1,
    })

    const repaired = await call(h.app, h.alice, 'PUT', `/api/webhook-triggers/${id}`, {
      launchPayload: VALID_PAYLOAD,
    })
    expect(repaired.status).toBe(200)

    const stored = (
      await h.db.select().from(webhookTriggers).where(eq(webhookTriggers.id, id)).limit(1)
    )[0]!
    expect(stored.templateSyntaxVersion).toBe(2)
    expect(JSON.parse(stored.launchPayload)).toMatchObject({
      inputs: {
        prompt: {
          kind: 'template',
          template: '修 {{trigger.webhook.repo_path}}',
        },
      },
    })
  })

  test('RFC-268：scratch 创建必须显式关闭 auto-register；partial update 校验完整候选', async () => {
    const h = await harness()
    const ep = await createEndpoint(h.app, h.admin)
    const scratchPayload = { ...VALID_PAYLOAD, scratch: true }

    for (const autoRegisterRepos of [undefined, true]) {
      const body = triggerBody(ep.id, h.workflowId, {
        launchPayload: scratchPayload,
        ...(autoRegisterRepos !== undefined ? { autoRegisterRepos } : {}),
      })
      const rejected = await call(h.app, h.alice, 'POST', '/api/webhook-triggers', body)
      expect(rejected.status).toBe(422)
      expect((await rejected.json()) as Record<string, unknown>).toMatchObject({
        code: 'webhook-trigger-invalid',
      })
    }

    const created = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId, {
        launchPayload: scratchPayload,
        autoRegisterRepos: false,
      }),
    )
    expect(created.status).toBe(201)
    const scratch = (await created.json()) as {
      id: string
      launchPayload: Record<string, unknown>
      autoRegisterRepos: boolean
    }
    expect(scratch.launchPayload['scratch']).toBe(true)
    expect(scratch.autoRegisterRepos).toBe(false)

    const enableClone = await call(h.app, h.alice, 'PUT', `/api/webhook-triggers/${scratch.id}`, {
      autoRegisterRepos: true,
    })
    expect(enableClone.status).toBe(422)

    for (const remoteOnly of [
      { workingBranch: 'automation/test' },
      { autoCommitPush: true },
      { autoCommitPush: false },
    ]) {
      const rejected = await call(h.app, h.alice, 'PUT', `/api/webhook-triggers/${scratch.id}`, {
        launchPayload: { ...scratchPayload, ...remoteOnly },
      })
      expect(rejected.status).toBe(422)
      expect((await rejected.json()) as Record<string, unknown>).toMatchObject({
        code: 'webhook-trigger-invalid',
      })
    }

    const eventRepo = await call(
      h.app,
      h.alice,
      'POST',
      '/api/webhook-triggers',
      triggerBody(ep.id, h.workflowId),
    )
    const eventRepoId = ((await eventRepo.json()) as { id: string }).id
    const scratchOnlyPatch = await call(
      h.app,
      h.alice,
      'PUT',
      `/api/webhook-triggers/${eventRepoId}`,
      { launchPayload: scratchPayload },
    )
    expect(scratchOnlyPatch.status).toBe(422)

    const convertTogether = await call(
      h.app,
      h.alice,
      'PUT',
      `/api/webhook-triggers/${eventRepoId}`,
      { launchPayload: scratchPayload, autoRegisterRepos: false },
    )
    expect(convertTogether.status).toBe(200)
    expect((await convertTogether.json()) as Record<string, unknown>).toMatchObject({
      launchPayload: { scratch: true },
      autoRegisterRepos: false,
    })

    const backToEventRepo = await call(
      h.app,
      h.alice,
      'PUT',
      `/api/webhook-triggers/${eventRepoId}`,
      { launchPayload: VALID_PAYLOAD },
    )
    expect(backToEventRepo.status).toBe(200)
    const eventRepoAgain = (await backToEventRepo.json()) as {
      launchPayload: Record<string, unknown>
    }
    expect('scratch' in eventRepoAgain.launchPayload).toBe(false)
  })

  test('RFC-268：并发 launch-config PATCH 最多一代提交，另一请求返回 409', async () => {
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

    const [eventTypes, duration] = await Promise.all([
      call(h.app, h.alice, 'PUT', `/api/webhook-triggers/${tid}`, {
        eventTypes: ['mr_opened'],
      }),
      call(h.app, h.alice, 'PUT', `/api/webhook-triggers/${tid}`, {
        launchPayload: { ...VALID_PAYLOAD, maxDurationMs: 1234 },
      }),
    ])
    expect([eventTypes.status, duration.status].sort()).toEqual([200, 409])
    const conflict = eventTypes.status === 409 ? eventTypes : duration
    expect((await conflict.json()) as Record<string, unknown>).toMatchObject({
      code: 'webhook-trigger-update-conflict',
    })

    const current = await call(h.app, h.alice, 'GET', `/api/webhook-triggers/${tid}`)
    const row = (await current.json()) as {
      eventTypes: string[]
      launchPayload: Record<string, unknown>
    }
    const eventTypesWon = row.eventTypes.length === 1
    const durationWon = row.launchPayload['maxDurationMs'] === 1234
    expect(Number(eventTypesWon) + Number(durationWon)).toBe(1)
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
    // RFC-260 D2 改判：投递读面全员开放（原 403）；replay 仍 manage（rfc260 矩阵锁）。
    const bobRead = await call(h.app, h.bob, 'GET', '/api/webhook-deliveries')
    expect(bobRead.status).toBe(200)
    // RFC-261 改判：列表响应从裸数组封套化为 {items,total,...}。
    const list = (
      (await (await call(h.app, h.admin, 'GET', '/api/webhook-deliveries')).json()) as {
        items: Array<Record<string, unknown>>
      }
    ).items
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
