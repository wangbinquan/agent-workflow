// RFC-260 — webhook 面「读全员、写 admin」+ hook URL 响应分层的权限矩阵锁
// （proposal AC-1..4）。核心不变量：**urlToken/ingressUrl 明文只出现在 admin 的
// session 响应里**——非 admin 与一切 PAT（含 admin 自己的 PAT）拿 null + 尾 4
// 位 hint；写动作对非 admin 一律 403（方法门）；触发器全量只读（D1 推翻
// owner-404 读语义）；投递列表+详情（含 body）全员可读、replay 仍 admin。
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb } from '../src/db/client'
import { createApp } from '../src/server'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'
import { createPat } from '../src/auth/patStore'
import { webhookDeliveries, webhookEndpoints, webhookTriggers, workflows } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 11))
const URL_TOKEN = 'aw_whk_visibility_tok_abcd'

async function harness() {
  const db = createInMemoryDb(MIGRATIONS)
  // 评审门 F-2：不喂 publicBaseUrl 时 ingressUrl 恒 null，「非 admin 拿 null」的
  // 负向断言平凡为真（退化实现也绿）。喂真实 config 让分层双向都非平凡。
  const configPath = join(mkdtempSync(join(tmpdir(), 'rfc260-cfg-')), 'config.json')
  writeFileSync(configPath, JSON.stringify({ publicBaseUrl: 'https://aw.example.com' }))
  const admin = await createUser(db, {
    username: 'root',
    displayName: 'root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const user = await createUser(db, {
    username: 'dev',
    displayName: 'dev',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const manager = await createUser(db, {
    username: 'mgr',
    displayName: 'mgr',
    role: 'manager',
    password: 'longEnoughPassword',
  })
  const adminSession = (await createSession({ db, userId: admin.id })).token
  const userSession = (await createSession({ db, userId: user.id })).token
  const managerSession = (await createSession({ db, userId: manager.id })).token
  const adminPat = (
    await createPat({ db, userId: admin.id, name: 'admin-pat', scopes: [], purpose: 'general' })
  ).token
  const userPat = (
    await createPat({ db, userId: user.id, name: 'user-pat', scopes: [], purpose: 'general' })
  ).token

  await db.insert(webhookEndpoints).values({
    id: 'ep-1',
    name: 'gitlab',
    provider: 'gitlab',
    urlToken: URL_TOKEN,
    secretEnc: box.seal('s3cret-value'),
    enabled: true,
  })
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
  // admin 名下的触发器——user 全量只读可见性的被测对象（D1）。
  await db.insert(webhookTriggers).values({
    id: 'tr-owned-by-admin',
    name: '别人的触发器',
    endpointId: 'ep-1',
    ownerUserId: admin.id,
    repoScope: JSON.stringify({ kind: 'all' }),
    eventTypes: JSON.stringify(['push']),
    ignoreUsernames: '[]',
    launchKind: 'workflow',
    launchRefId: workflowId,
    launchPayload: JSON.stringify({ inputs: {} }),
  })
  await db.insert(webhookDeliveries).values({
    id: 'dl-1',
    endpointId: 'ep-1',
    eventUuid: 'uuid-1',
    status: 'matched',
    bodyJson: '{"object_kind":"push","secret_free":"body"}',
  })
  const app = createApp({
    token: 'a'.repeat(64),
    configPath,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox: box,
  })
  return { db, app, adminSession, userSession, managerSession, adminPat, userPat }
}

type H = Awaited<ReturnType<typeof harness>>

function get(app: H['app'], path: string, token: string): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: { authorization: `Bearer ${token}` } }))
}

function send(
  app: H['app'],
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

type EndpointWire = {
  urlToken: string | null
  urlTokenHint: string | null
  ingressUrl: string | null
  secretHint: string | null
}

describe('RFC-260 · AC-1 端点读面与 URL 响应分层', () => {
  test('admin session：明文 urlToken；user/manager session 与两枚 PAT：null + 尾 4 hint', async () => {
    const h = await harness()
    const cases: Array<[string, boolean]> = [
      [h.adminSession, true], // 唯一明文通道
      [h.userSession, false],
      [h.managerSession, false],
      [h.adminPat, false], // D3：admin 的 PAT 也掩码——ingress 面不上令牌
      [h.userPat, false],
    ]
    for (const [token, reveal] of cases) {
      const res = await get(h.app, '/api/webhook-endpoints', token)
      expect(res.status).toBe(200)
      const rows = (await res.json()) as EndpointWire[]
      expect(rows.length).toBe(1)
      const row = rows[0]!
      expect(row.urlTokenHint).toBe(URL_TOKEN.slice(-4))
      if (reveal) {
        expect(row.urlToken).toBe(URL_TOKEN)
        expect(row.ingressUrl).toBe(`https://aw.example.com/webhooks/gitlab/${URL_TOKEN}`)
      } else {
        expect(row.urlToken).toBeNull()
        expect(row.ingressUrl).toBeNull()
        expect(JSON.stringify(rows)).not.toContain(URL_TOKEN)
      }
      // secret 明文任何 viewer 都没有（既有语义回归）
      expect(JSON.stringify(rows)).not.toContain('s3cret-value')
    }
    const detail = await get(h.app, '/api/webhook-endpoints/ep-1', h.userSession)
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as EndpointWire).urlToken).toBeNull()
  })
})

describe('RFC-260 · AC-2 写面仍 admin 独占', () => {
  test('user/manager 对端点写与 replay 全 403；admin 全通', async () => {
    const h = await harness()
    for (const token of [h.userSession, h.managerSession]) {
      expect(
        (await send(h.app, 'POST', '/api/webhook-endpoints', token, { name: 'x' })).status,
      ).toBe(403)
      expect(
        (await send(h.app, 'PUT', '/api/webhook-endpoints/ep-1', token, { enabled: false })).status,
      ).toBe(403)
      expect((await send(h.app, 'DELETE', '/api/webhook-endpoints/ep-1', token)).status).toBe(403)
      expect(
        (await send(h.app, 'POST', '/api/webhook-endpoints/ep-1/rotate-secret', token)).status,
      ).toBe(403)
      expect(
        (await send(h.app, 'POST', '/api/webhook-endpoints/ep-1/rotate-url-token', token)).status,
      ).toBe(403)
      expect(
        (
          await send(
            h.app,
            'POST',
            '/api/webhook-triggers/tr-owned-by-admin/streams/reset',
            token,
            {
              streamKey: 'acme/api|branch:main',
            },
          )
        ).status,
      ).toBe(403)
      expect((await send(h.app, 'POST', '/api/webhook-deliveries/dl-1/replay', token)).status).toBe(
        403,
      )
      expect(
        (
          await send(h.app, 'PUT', '/api/webhook-triggers/tr-owned-by-admin', token, {
            name: 'hijack',
          })
        ).status,
      ).toBe(403)
      expect(
        (await send(h.app, 'DELETE', '/api/webhook-triggers/tr-owned-by-admin', token)).status,
      ).toBe(403)
    }
    const ok = await send(h.app, 'PUT', '/api/webhook-endpoints/ep-1', h.adminSession, {
      enabled: false,
    })
    expect(ok.status).toBe(200)
  })
})

describe('RFC-260 · AC-3 触发器全量只读（D1 推翻 owner-404 读语义）', () => {
  test('user 能列出并读到 admin 名下触发器的详情与 fires；写仍被挡', async () => {
    const h = await harness()
    const list = await get(h.app, '/api/webhook-triggers', h.userSession)
    expect(list.status).toBe(200)
    const rows = (await list.json()) as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toContain('tr-owned-by-admin')

    const detail = await get(h.app, '/api/webhook-triggers/tr-owned-by-admin', h.userSession)
    expect(detail.status).toBe(200) // RFC-257 原语义是 404 同形——D1 显式改判

    const fires = await get(h.app, '/api/webhook-triggers/tr-owned-by-admin/fires', h.userSession)
    expect(fires.status).toBe(200)
  })
})

describe('RFC-260 · AC-4 投递读面', () => {
  test('user 读列表与详情（含 body）200；replay 403（AC-2 已锁，此处锁读）', async () => {
    const h = await harness()
    const list = await get(h.app, '/api/webhook-deliveries', h.userSession)
    expect(list.status).toBe(200)
    // RFC-261 改判：列表响应从裸数组封套化为 {items,total,...}。
    expect(((await list.json()) as { items: unknown[] }).items.length).toBe(1)
    const detail = await get(h.app, '/api/webhook-deliveries/dl-1', h.userSession)
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as { bodyJson: string }).bodyJson).toContain('secret_free')
    // PAT 读也开放（掩码后的元数据面）——列表与详情（含 body）都可读
    const patList = await get(h.app, '/api/webhook-deliveries', h.userPat)
    expect(patList.status).toBe(200)
    const patDetail = await get(h.app, '/api/webhook-deliveries/dl-1', h.userPat)
    expect(patDetail.status).toBe(200)
    expect(((await patDetail.json()) as { bodyJson: string }).bodyJson).toContain('secret_free')
  })
})
