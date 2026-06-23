// RFC-103 T9 (调研报告 10-ACL MISSED, Codex) — 登录 constant-time（防账号枚举）。
//
// 为什么这条测试存在：/api/auth/login 注释自称 constant-time，但「未知用户 /
// inactive / 无 passwordHash」三条早退分支直接 401、不跑 argon2，只有有效用户的
// 错误密码才跑昂贵的 argon2 verify → 计时可区分「存在的活跃账号」与其他。修复后
// 三条早退分支也跑一次 dummy argon2 verify。本测试用「该分支也调用了 argon2
// verify」作为稳定的计时代理（不做脆弱的真实 timing 断言）。
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test'
import type { Hono } from 'hono'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { verifyPasswordDummy } from '../src/auth/passwords'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

async function buildApp(): Promise<{ db: DbClient; app: Hono }> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox: createSecretBoxFromKey(randomBytes(32)),
  })
  return { db, app }
}

async function login(app: Hono, username: string, password: string): Promise<Response> {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

describe('RFC-103 T9 verifyPasswordDummy', () => {
  test('总是返回 false 且实际跑了一次 argon2 verify', async () => {
    const spy = spyOn(Bun.password, 'verify')
    const result = await verifyPasswordDummy('whatever')
    expect(result).toBe(false)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1)
    spy.mockRestore()
  })
})

describe('RFC-103 T9 登录三条早退分支都跑 argon2（计时代理）', () => {
  let app: Hono
  let db: DbClient
  let spy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    ;({ db, app } = await buildApp())
    await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'correctPassword123',
    })
    // inactive：有 hash 但 status=disabled。
    await createUser(db, {
      username: 'bob-disabled',
      displayName: 'Bob',
      role: 'user',
      password: 'bobPassword123',
      status: 'disabled',
    })
    // 无 passwordHash：不传 password → status=invited、passwordHash=null。
    await createUser(db, { username: 'carol-invited', displayName: 'Carol', role: 'user' })
    spy = spyOn(Bun.password, 'verify')
  })
  afterEach(() => {
    spy.mockRestore()
  })

  test('未知用户 → 401 且跑了 argon2 verify', async () => {
    spy.mockClear()
    const res = await login(app, 'ghost', 'irrelevant')
    expect(res.status).toBe(401)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('inactive(disabled) 用户 → 401 且跑了 argon2 verify', async () => {
    spy.mockClear()
    const res = await login(app, 'bob-disabled', 'bobPassword123')
    expect(res.status).toBe(401)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('无 passwordHash(invited) 用户 → 401 且跑了 argon2 verify', async () => {
    spy.mockClear()
    const res = await login(app, 'carol-invited', 'whatever')
    expect(res.status).toBe(401)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('对照：有效用户错误密码同样 401 且跑 argon2', async () => {
    spy.mockClear()
    const res = await login(app, 'alice', 'wrong-pw')
    expect(res.status).toBe(401)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('对照：有效用户正确密码 → 200', async () => {
    const res = await login(app, 'alice', 'correctPassword123')
    expect(res.status).toBe(200)
  })
})
