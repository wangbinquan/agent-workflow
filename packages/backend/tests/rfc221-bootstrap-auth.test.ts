// RFC-221 — route-level first-run ceremony. Fresh discovery exposes daemon
// token only; that actor is allow-listed to setup, and the admin insert commit
// immediately retires the credential before the new user logs in.

import { beforeEach, expect, test } from 'bun:test'

import type { Hono } from 'hono'

import type { ProviderNeutralDatabase } from '../src/db/query'
import { authLoginPolicy, users } from '../src/db/schema'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'

const DAEMON_TOKEN = 'b'.repeat(64)

interface Harness {
  db: ProviderNeutralDatabase
  app: Hono
}

// `bootstrap: 'required'` 由作用域直通给 harness（见下面的注册选项）——测的就是「还没有管理员」
// 这个状态，harness 默认会把 `auth_login_policy` 标成已 bootstrap，那样整条判据就没了。
async function buildHarness(scope: ProviderHttpApplicationScope): Promise<Harness> {
  const db = scope.harness.db
  const app = (await scope.open()).app
  return { db, app }
}

async function request(
  app: Hono,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (token !== undefined) headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return await app.request(path, { ...init, headers })
}

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-221 bootstrap auth routes',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: 'test',
    dbVersion: 110,
    tempPrefix: 'aw-bootstrap-auth-',
    bootstrap: 'required',
  },
  (scope) => {
    let h: Harness
    beforeEach(async () => {
      h = await buildHarness(scope)
    })

    test('fresh discovery is daemon-token-only and public login families are denied', async () => {
      const discovery = await request(h.app, '/api/auth/oidc/providers')
      expect(discovery.status).toBe(200)
      expect(await discovery.json()).toEqual({
        mode: 'bootstrap',
        providers: [],
        passwordLoginEnabled: false,
        daemonTokenEnabled: true,
      })
      const password = await request(h.app, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'x', password: 'x' }),
      })
      expect(password.status).toBe(403)
      expect(((await password.json()) as { code: string }).code).toBe('bootstrap-admin-required')
      const oidc = await request(h.app, '/api/auth/oidc/corp/login/start', {
        method: 'POST',
        body: '{}',
      })
      expect(oidc.status).toBe(403)
      expect(((await oidc.json()) as { code: string }).code).toBe('bootstrap-admin-required')
    })

    test('daemon actor can only call the exact setup allow-list', async () => {
      expect((await request(h.app, '/api/whoami', {}, DAEMON_TOKEN)).status).toBe(200)
      expect((await request(h.app, '/api/auth/bootstrap/status', {}, DAEMON_TOKEN)).status).toBe(
        200,
      )
      const business = await request(h.app, '/api/users', {}, DAEMON_TOKEN)
      expect(business.status).toBe(403)
      expect(((await business.json()) as { code: string }).code).toBe('bootstrap-admin-required')
    })

    test('admin creation commit retires daemon token before first password login', async () => {
      const created = await request(
        h.app,
        '/api/auth/bootstrap/admin',
        {
          method: 'POST',
          body: JSON.stringify({
            username: 'first-admin',
            displayName: 'First Admin',
            email: 'first@example.test',
            password: 'password123',
          }),
        },
        DAEMON_TOKEN,
      )
      expect(created.status).toBe(201)
      const body = (await created.json()) as { role: string; status: string; sessionToken?: string }
      expect(body.role).toBe('admin')
      expect(body.status).toBe('active')
      expect(body.sessionToken).toBeUndefined()
      const [policyRow] = await h.db.select().from(authLoginPolicy)
      expect(policyRow?.bootstrapCompletedAt).not.toBeNull()
      expect(
        (await h.db.select().from(users)).filter((row) => row.id !== '__system__'),
      ).toHaveLength(1)

      expect((await request(h.app, '/api/whoami', {}, DAEMON_TOKEN)).status).toBe(401)
      const discovery = (await (await request(h.app, '/api/auth/oidc/providers')).json()) as Record<
        string,
        unknown
      >
      expect(discovery).toEqual({
        mode: 'ready',
        providers: [],
        passwordLoginEnabled: true,
        daemonTokenEnabled: false,
      })
      const login = await request(h.app, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'first-admin', password: 'password123' }),
      })
      expect(login.status).toBe(200)
      expect(
        ((await login.json()) as { sessionToken: string }).sessionToken.startsWith('aws_s_'),
      ).toBe(true)
    })

    test('bootstrap wire rejects role/status injection with zero user insert', async () => {
      const res = await request(
        h.app,
        '/api/auth/bootstrap/admin',
        {
          method: 'POST',
          body: JSON.stringify({
            username: 'first-admin',
            displayName: 'First Admin',
            password: 'password123',
            role: 'user',
          }),
        },
        DAEMON_TOKEN,
      )
      expect(res.status).toBe(422)
      expect(
        (await h.db.select().from(users)).filter((row) => row.id !== '__system__'),
      ).toHaveLength(0)
    })
  },
)
