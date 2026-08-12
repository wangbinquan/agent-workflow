// RFC-036 — three-track auth middleware integration.

import { beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { READ_POINTS, type Permission } from '@agent-workflow/shared'
import { actorOf, SYSTEM_USER_ID } from '../src/auth/actor'
import { createPat } from '../src/auth/patStore'
import { multiAuth } from '../src/auth/session'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { users } from '../src/db/schema'
import { errorHandler } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

function buildApp(db: DbClient): Hono {
  const app = new Hono()
  app.use('/api/*', multiAuth({ db, daemonToken: DAEMON_TOKEN }))
  app.get('/api/whoami', (c) => {
    const a = actorOf(c)
    return c.json({
      id: a.user.id,
      role: a.user.role,
      source: a.source,
      permissions: [...a.permissions],
    })
  })
  app.onError(errorHandler)
  return app
}

async function seedUser(db: DbClient, id: string, role: 'admin' | 'user' = 'user') {
  await db.insert(users).values({
    id,
    username: id.toLowerCase(),
    email: `${id.toLowerCase()}@example.com`,
    displayName: id,
    passwordHash: null,
    role,
    status: 'active',
    forcePasswordChange: false,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
    lastLoginAt: null,
    schemaVersion: 1,
  })
}

describe('multiAuth — daemon token track', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('valid daemon token resolves to __system__ admin actor', async () => {
    const app = buildApp(db)
    const res = await app.request('/api/whoami', {
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; role: string; source: string }
    expect(body.id).toBe(SYSTEM_USER_ID)
    expect(body.role).toBe('admin')
    expect(body.source).toBe('daemon')
  })

  test('64-char hex but wrong token → 401', async () => {
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
    })
    expect(res.status).toBe(401)
  })

  test('arbitrary unrelated tokens → 401 (no leak of daemon token shape)', async () => {
    expect(
      (await buildApp(db).request('/api/whoami', { headers: { Authorization: 'Bearer xxx' } }))
        .status,
    ).toBe(401)
    expect(
      (
        await buildApp(db).request('/api/whoami', {
          headers: { Authorization: `Bearer ${'a'.repeat(63)}` },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await buildApp(db).request('/api/whoami', {
          headers: { Authorization: `Bearer ${'a'.repeat(65)}` },
        })
      ).status,
    ).toBe(401)
  })
})

describe('multiAuth — session token track', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('valid session token → user actor with role permissions', async () => {
    await seedUser(db, '01HQALICE', 'admin')
    const { token } = await createSession({ db, userId: '01HQALICE' })
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; role: string; source: string }
    expect(body.id).toBe('01HQALICE')
    expect(body.role).toBe('admin')
    expect(body.source).toBe('session')
  })

  // RFC-285 B4（红→绿对）：REST 面不再接受 ?token=——即便凭据有效也 401。
  // query 通道只保留在 WS 升级（extractUpgradeToken）；此前这里断言 200。
  test('valid session token via ?token= → 401 (B4: REST query channel closed)', async () => {
    await seedUser(db, '01HQBOB')
    const { token } = await createSession({ db, userId: '01HQBOB' })
    const res = await buildApp(db).request(`/api/whoami?token=${token}`)
    expect(res.status).toBe(401)
    // 同一凭据走 Authorization 头照常 200——关的是通道不是凭据。
    const viaHeader = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(viaHeader.status).toBe(200)
  })

  test('mistyped session prefix is not interpreted as daemon token', async () => {
    // aws_s_<63 chars> -> not a known token; daemon token regex never matches
    // because of leading non-hex letters.
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer aws_s_${'a'.repeat(63)}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('multiAuth — PAT track', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('PAT narrows permissions to the configured scopes', async () => {
    await seedUser(db, '01HQCAROL', 'user')
    const { token } = await createPat({
      db,
      userId: '01HQCAROL',
      name: 'ci',
      scopes: ['tasks:execute'],
      purpose: 'general',
    })
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      role: string
      source: string
      permissions: string[]
    }
    expect(body.id).toBe('01HQCAROL')
    expect(body.role).toBe('user')
    expect(body.source).toBe('pat')
    // RFC-247: a token's grants are (READ_POINTS ∪ matrix) ∩ role baseline.
    // Reads ride along unconditionally (D3 "读恒开"), so the assertion is
    // "exactly the ticked write verb, plus reads, and nothing else".
    expect(body.permissions).toContain('tasks:execute')
    const nonRead = body.permissions.filter((p) => !READ_POINTS.includes(p as Permission))
    expect(nonRead).toEqual(['tasks:execute'])
  })

  test('PAT cannot widen beyond role (admin-only scope on user PAT is dropped)', async () => {
    await seedUser(db, '01HQDAVE', 'user')
    const { token } = await createPat({
      db,
      userId: '01HQDAVE',
      name: 'overreach',
      // RFC-099: agents:write moved to the user baseline; users:read is the
      // canonical admin-only scope this widening test needs.
      scopes: ['users:read', 'tasks:execute'],
      purpose: 'general',
    })
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as { permissions: string[] }
    // `users:read` is admin-only AND system-domain — dropped on both counts.
    expect(body.permissions).not.toContain('users:read')
    const nonRead = body.permissions.filter((p) => !READ_POINTS.includes(p as Permission))
    expect(nonRead.sort()).toEqual(['tasks:execute'])
  })
})

describe('multiAuth — no token / malformed header', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('missing Authorization → 401', async () => {
    const res = await buildApp(db).request('/api/whoami')
    expect(res.status).toBe(401)
  })

  test('Authorization without Bearer prefix → 401', async () => {
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: DAEMON_TOKEN },
    })
    expect(res.status).toBe(401)
  })

  test('empty token query → 401', async () => {
    const res = await buildApp(db).request('/api/whoami?token=')
    expect(res.status).toBe(401)
  })

  // RFC-285 B4 源码文本锁：REST 面（auth/session + 全部 routes/）不得 import
  // WS 专用的 extractUpgradeToken；auth/token.ts 的 tokenAuth 死体不得复活。
  test('B4 双入口边界文本锁：REST 不碰 upgrade 入口，tokenAuth 不复活', () => {
    const src = (rel: string): string =>
      readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')
    expect(src('auth/session.ts')).toContain('export function extractBearerToken')
    expect(src('auth/session.ts')).toContain('export function extractUpgradeToken')
    // REST 主链只认 Bearer：query 读取在 session.ts 里只允许出现于 upgrade 入口。
    const sessionSrc = src('auth/session.ts')
    const queryReads = sessionSrc.match(/searchParams\.get\('token'\)|req\.query\('token'\)/g) ?? []
    expect(queryReads.length).toBe(1) // 仅 extractUpgradeToken 内一处
    expect(src('auth/token.ts')).not.toContain('export function tokenAuth') // 死体不复活（注释可提及）
    expect(src('ws/server.ts')).toContain('extractUpgradeToken(url)')
    for (const route of readdirSync(resolve(import.meta.dir, '..', 'src', 'routes'))) {
      if (!route.endsWith('.ts')) continue
      expect(src(join('routes', route)).includes('extractUpgradeToken')).toBe(false)
    }
  })
})
