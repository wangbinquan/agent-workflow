// RFC-windows PR-1 — POST /api/shutdown route (Windows graceful-stop channel).
//
// 为什么这条测试存在：Windows 无 SIGTERM 跨进程投递，`agent-workflow stop`
// 改走 token 守卫的 HTTP /api/shutdown 触发 daemon 的 shutdown() 闭包。这条
// 测试锁三件事：① 带 daemon token 的请求触发 shutdown 回调并返回 200；
// ② 无 token / 错 token → 401（multiAuth 守卫，不能让任意人停 daemon）；
// ③ deps.shutdown 未接线时返回 503 而非崩。POSIX 同样走该路由（行为一致），
// 但 POSIX 上 `stop` 仍优先用 SIGTERM——本路由是 Windows 的主通道、POSIX 的
// 兜底。

import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildApp(shutdown?: () => void): { app: Hono; db: DbClient } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    shutdown,
  })
  return { app, db }
}

async function reqAs(app: Hono, token: string | null, path: string): Promise<Response> {
  const headers = new Headers()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  return app.request(path, { method: 'POST', headers })
}

describe('RFC-windows PR-1 — POST /api/shutdown', () => {
  test('with daemon token: fires shutdown callback, returns 200', async () => {
    let called = 0
    const { app } = buildApp(() => {
      called++
    })
    const res = await reqAs(app, DAEMON_TOKEN, '/api/shutdown')
    expect(res.status).toBe(200)
    expect(called).toBe(1)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  test('without token: 401 (no anonymous shutdown)', async () => {
    const { app } = buildApp(() => {
      throw new Error('should not be called')
    })
    const res = await reqAs(app, null, '/api/shutdown')
    expect(res.status).toBe(401)
  })

  test('with wrong token: 401', async () => {
    const { app } = buildApp(() => {
      throw new Error('should not be called')
    })
    const res = await reqAs(app, 'b'.repeat(64), '/api/shutdown')
    expect(res.status).toBe(401)
  })

  test('shutdown not wired (no deps.shutdown): 503, no throw', async () => {
    const { app } = buildApp(undefined)
    const res = await reqAs(app, DAEMON_TOKEN, '/api/shutdown')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('shutdown-not-wired')
  })

  test('GET /api/shutdown is 404 (POST-only)', async () => {
    const { app } = buildApp(() => {})
    const res = await app.request('/api/shutdown', {
      method: 'GET',
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    expect(res.status).toBe(404)
  })
})
