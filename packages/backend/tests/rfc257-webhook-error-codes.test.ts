// RFC-257 — 路由错误码逐个行为触发（route-error-code-coverage 锁要求每个新
// code 被测试点名——点名的正确姿势是把那条错误路径真的走一遍并断言 code）。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import { createUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'
import { webhookDeliveries, webhookEndpoints, webhookTriggers, workflows } from '../src/db/schema'
import type { WebhookDispatcher } from '../src/services/webhook/dispatcherTypes'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 11))

async function harness(opts?: { omitDispatcher?: boolean }) {
  const db = createInMemoryDb(MIGRATIONS)
  const admin = await createUser(db, {
    username: 'root',
    displayName: 'root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: admin.id })
  const dispatcher: WebhookDispatcher = {
    dispatch: async () => {},
    dispatchSubscription: async () => {},
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    version: 1,
    ownerUserId: admin.id,
    visibility: 'private',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(webhookEndpoints).values({
    id: 'ep-1',
    name: 'gl',
    provider: 'gitlab',
    urlToken: 'aw_whk_codes',
    secretEnc: box.seal('s'),
    enabled: true,
  })
  const app = createApp({
    token: 'a'.repeat(64),
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox: box,
    ...(opts?.omitDispatcher ? {} : { webhookDispatcher: dispatcher }),
  })
  const call = async (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  return { db, app, call, workflowId }
}

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code
}

async function seedDelivery(
  db: DbClient,
  overrides: Partial<typeof webhookDeliveries.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  await db.insert(webhookDeliveries).values({
    id,
    endpointId: 'ep-1',
    eventUuid: null,
    status: 'matched',
    bodyJson: JSON.stringify({
      object_kind: 'push',
      ref: 'refs/heads/main',
      user_username: 'u',
      project: {
        path_with_namespace: 'g/r',
        git_http_url: 'https://gl.example.com/g/r.git',
        git_ssh_url: 'git@gl.example.com:g/r.git',
      },
    }),
    ...overrides,
  })
  return id
}

describe('RFC-257 · 端点面错误码', () => {
  test('webhook-endpoint-invalid / webhook-endpoint-not-found / webhook-endpoint-has-triggers', async () => {
    const h = await harness()
    expect(await codeOf(await h.call('POST', '/api/webhook-endpoints', { nope: 1 }))).toBe(
      'webhook-endpoint-invalid',
    )
    expect(await codeOf(await h.call('GET', '/api/webhook-endpoints/nope'))).toBe(
      'webhook-endpoint-not-found',
    )
    await h.db.insert(webhookTriggers).values({
      id: 'tr-1',
      name: 't',
      endpointId: 'ep-1',
      ownerUserId: 'whoever',
      repoScope: '{"kind":"all"}',
      eventTypes: '["push"]',
      launchKind: 'workflow',
      launchRefId: h.workflowId,
      launchPayload: '{"inputs":{}}',
    })
    expect(await codeOf(await h.call('DELETE', '/api/webhook-endpoints/ep-1'))).toBe(
      'webhook-endpoint-has-triggers',
    )
  })

  test('webhook-endpoint-token-mint-failed：三连 urlToken 冲突的理论路径（256 位随机熵，无法行为触发——显式记载）', () => {
    // routes/webhookEndpoints.ts 的铸造重试穷尽后抛出；构造它需要连续三次
    // randomBytes(32) 碰撞既有 token，实际不可复现。此断言点名该码并锁定其
    // 存在于源码（消失即此测试失去意义，应一并删除）。
    // RFC-284 T28 改锚：端点 CRUD 正体迁 services/webhookEndpoints.ts（路由为薄壳）。
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'webhookEndpoints.ts'),
      'utf8',
    )
    expect(src.includes("'webhook-endpoint-token-mint-failed'")).toBe(true)
  })
})

describe('RFC-257 · 触发器面错误码', () => {
  test('not-found / invalid / kind-immutable / endpoint-immutable / stream-invalid', async () => {
    const h = await harness()
    expect(await codeOf(await h.call('GET', '/api/webhook-triggers/nope'))).toBe(
      'webhook-trigger-not-found',
    )
    expect(
      await codeOf(
        await h.call('POST', '/api/webhook-triggers', {
          name: 't',
          endpointId: 'ep-1',
          repoScope: { kind: 'all' },
          eventTypes: ['push'],
          launchKind: 'workflow',
          launchRefId: h.workflowId,
          launchPayload: { inputs: { x: { kind: 'template', template: '{{nope}}' } } },
        }),
      ),
    ).toBe('webhook-trigger-invalid')
    const created = await h.call('POST', '/api/webhook-triggers', {
      name: 't',
      endpointId: 'ep-1',
      repoScope: { kind: 'all' },
      eventTypes: ['push'],
      launchKind: 'workflow',
      launchRefId: h.workflowId,
      launchPayload: { inputs: {} },
    })
    const tid = ((await created.json()) as { id: string }).id
    expect(
      await codeOf(await h.call('PUT', `/api/webhook-triggers/${tid}`, { launchKind: 'agent' })),
    ).toBe('webhook-trigger-kind-immutable')
    expect(
      await codeOf(await h.call('PUT', `/api/webhook-triggers/${tid}`, { endpointId: 'other' })),
    ).toBe('webhook-trigger-endpoint-immutable')
    expect(
      await codeOf(await h.call('POST', `/api/webhook-triggers/${tid}/streams/reset`, {})),
    ).toBe('webhook-stream-invalid')
  })

  test('event-automation-rules:override-owner grant/revoke controls cross-owner mutation', async () => {
    const h = await harness()
    await h.db
      .update(workflows)
      .set({ visibility: 'public' })
      .where(sql`${workflows.id} = ${h.workflowId}`)

    const created = await h.call('POST', '/api/webhook-triggers', {
      name: 'owned-trigger',
      endpointId: 'ep-1',
      repoScope: { kind: 'all' },
      eventTypes: ['push'],
      launchKind: 'workflow',
      launchRefId: h.workflowId,
      launchPayload: { inputs: {} },
    })
    expect(created.status).toBe(201)
    const triggerId = ((await created.json()) as { id: string }).id

    const editor = await createUser(h.db, {
      username: 'trigger-editor',
      displayName: 'Trigger editor',
      role: 'user',
      password: 'longEnoughPassword',
      additionalPermissions: ['event-automation-rules:update'],
    })
    const editorToken = (await createSession({ db: h.db, userId: editor.id })).token
    const edit = (name: string) =>
      h.app.request(`/api/webhook-triggers/${triggerId}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${editorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name }),
      })

    expect((await edit('still-denied')).status).toBe(404)

    const identityAccess = composeIdentityAccess(h.db)
    const context = identityAccess.contexts.fromAuthenticatedPrincipal(
      { userId: SYSTEM_USER_ID, source: 'cli' },
      'cli',
      Date.now(),
    )
    await identityAccess.updateUserAccess.execute(context, {
      targetUserId: editor.id,
      access: {
        role: 'user',
        additionalPermissions: [
          'event-automation-rules:update',
          'event-automation-rules:override-owner',
        ],
        expectedRevision: 0,
      },
    })
    expect((await edit('granted')).status).toBe(200)

    await identityAccess.updateUserAccess.execute(context, {
      targetUserId: editor.id,
      access: {
        role: 'user',
        additionalPermissions: ['event-automation-rules:update'],
        expectedRevision: 1,
      },
    })
    expect((await edit('revoked')).status).toBe(404)
  })
})

describe('RFC-257 · 投递面错误码（replay 的每条拒绝路径）', () => {
  test('RFC-303 replay lineage is fail-closed; impossible duplicate result keeps an explicit invariant code', async () => {
    const h = await harness()
    const broken = await seedDelivery(h.db, { replayedFromDeliveryId: 'missing-root' })
    expect(await codeOf(await h.call('POST', `/api/webhook-deliveries/${broken}/replay`))).toBe(
      'webhook-delivery-replay-lineage-broken',
    )

    // `acceptVerifiedDelivery` excludes explicit replay rows from fact
    // dedupe, so the duplicate-result branch cannot be produced through the
    // public route today. Keep the invariant named and source-locked; if the
    // port later admits replay dedupe, replace this with a behavioral fake.
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'webhookDeliveries.ts'),
      'utf8',
    )
    expect(source).toContain("'webhook-delivery-replay-conflict'")
  })

  test('RFC-303 terminal replay requires the original durable revision and effect', async () => {
    const h = await harness()
    const terminalBody = JSON.stringify({
      object_kind: 'merge_request',
      event_type: 'merge_request',
      user: { username: 'u' },
      project: {
        id: 77,
        path_with_namespace: 'g/r',
        git_http_url: 'https://gl.example.com/g/r.git',
        git_ssh_url: 'git@gl.example.com:g/r.git',
      },
      object_attributes: {
        iid: 9,
        state: 'closed',
        action: 'close',
        source_branch: 'feature',
        target_branch: 'main',
      },
    })
    const legacy = await seedDelivery(h.db, {
      gitlabEventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
      eventType: 'mr_closed',
      bodyJson: terminalBody,
      mrStreamRevision: null,
    })
    expect(await codeOf(await h.call('POST', `/api/webhook-deliveries/${legacy}/replay`))).toBe(
      'webhook-terminal-replay-root-unprotected',
    )
    const missingEffect = await seedDelivery(h.db, {
      gitlabEventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
      eventType: 'mr_closed',
      bodyJson: terminalBody,
      mrStreamRevision: 3,
    })
    expect(
      await codeOf(await h.call('POST', `/api/webhook-deliveries/${missingEffect}/replay`)),
    ).toBe('webhook-terminal-replay-effect-missing')
  })

  test('not-found / rejected-not-replayable / in-flight / body-gone / body-invalid / unsupported / endpoint-not-found / provider-unknown', async () => {
    const h = await harness()
    expect(await codeOf(await h.call('GET', '/api/webhook-deliveries/nope'))).toBe(
      'webhook-delivery-not-found',
    )
    const rejected = await seedDelivery(h.db, { status: 'rejected' })
    expect(await codeOf(await h.call('POST', `/api/webhook-deliveries/${rejected}/replay`))).toBe(
      'webhook-delivery-rejected-not-replayable',
    )
    const inFlight = await seedDelivery(h.db, { status: 'processing' })
    expect(await codeOf(await h.call('POST', `/api/webhook-deliveries/${inFlight}/replay`))).toBe(
      'webhook-delivery-in-flight',
    )
    const pruned = await seedDelivery(h.db, { bodyJson: null })
    expect(await codeOf(await h.call('POST', `/api/webhook-deliveries/${pruned}/replay`))).toBe(
      'webhook-delivery-body-gone',
    )
    const badJson = await seedDelivery(h.db, { bodyJson: 'not-json{{' })
    expect(await codeOf(await h.call('POST', `/api/webhook-deliveries/${badJson}/replay`))).toBe(
      'webhook-delivery-body-invalid',
    )
    const unsupported = await seedDelivery(h.db, {
      bodyJson: JSON.stringify({ object_kind: 'release', project: { path_with_namespace: 'g/r' } }),
    })
    expect(
      await codeOf(await h.call('POST', `/api/webhook-deliveries/${unsupported}/replay`)),
    ).toBe('webhook-delivery-unsupported')
    // endpoint 被删（先清触发器）后 replay → endpoint-not-found
    const orphan = await seedDelivery(h.db, { endpointId: 'ep-gone' })
    expect(await codeOf(await h.call('POST', `/api/webhook-deliveries/${orphan}/replay`))).toBe(
      'webhook-endpoint-not-found',
    )
    // provider 列被手改成注册表外的值（raw SQL 绕过 enum 类型）→ provider-unknown
    await h.db.run(sql`UPDATE webhook_endpoints SET provider = 'gitea' WHERE id = 'ep-1'`)
    const strange = await seedDelivery(h.db)
    expect(await codeOf(await h.call('POST', `/api/webhook-deliveries/${strange}/replay`))).toBe(
      'webhook-provider-unknown',
    )
  })

  test('webhook-ingress-unavailable：装配缺 dispatcher 时 replay 拒绝', async () => {
    const h = await harness({ omitDispatcher: true })
    const id = await seedDelivery(h.db)
    expect(await codeOf(await h.call('POST', `/api/webhook-deliveries/${id}/replay`))).toBe(
      'webhook-ingress-unavailable',
    )
  })
})
