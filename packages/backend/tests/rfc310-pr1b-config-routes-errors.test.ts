// RFC-310 PR-1B —— 配置路由错误码的行为点名（route-error-code-coverage 守卫
// 要求每个 route-local 错误码有测试点名；CI 32093049068 首扫照出三个漏点：
// `action-template-capability-required` / `development-adapter-purpose-required`
// / `resource-not-found`——本地此前 untracked 时 git ls-files 型守卫看不见，
// 正是 dev-gotchas「新增文件先 git add -N 再跑门禁」那条的又一次实证）。
// 全部经真实 HTTP app：错误码读 body.code，不读 message（dev-gotchas 定式）。

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  token: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'admin-310',
    displayName: 'Admin',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: admin.id })
  return { db, app, token }
}

async function reqAs(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

describe('rfc310 config routes — route-local error codes behave and are named', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('POST /api/code/action-templates without capabilityId → action-template-capability-required', async () => {
    const res = await reqAs(h.app, h.token, '/api/code/action-templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'no-capability', draft: {} }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('action-template-capability-required')
  })

  test('POST /api/integrations/development-adapters without purpose → development-adapter-purpose-required', async () => {
    const res = await reqAs(h.app, h.token, '/api/integrations/development-adapters', {
      method: 'POST',
      body: JSON.stringify({ name: 'no-purpose', draft: {} }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('development-adapter-purpose-required')
  })

  test('GET a missing mission id → mission-not-found (404)', async () => {
    const res = await reqAs(h.app, h.token, '/api/code/missions/01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('mission-not-found')
  })

  test('GET a foreign/missing resource id → resource-not-found (404 identical to absent)', async () => {
    const res = await reqAs(
      h.app,
      h.token,
      '/api/code/digital-employees/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('resource-not-found')
  })
})
