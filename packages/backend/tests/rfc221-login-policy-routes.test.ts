// RFC-221 — admin login-method API and provider lifecycle protection.

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createSession } from './helpers/auth/sessionStore'
import { createInMemoryDb } from '../src/db/client'
import { createApp } from '../src/server'

import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { createOidcProvidersService } from '../src/services/oidcProviders'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'd'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-221 login policy routes',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: 'test',
    dbVersion: 110,
    tempPrefix: 'aw-login-policy-',
  },
  (scope) => {
    test('OIDC enables password-off and protects the last enabled provider', async () => {
      const db = scope.harness.db
      const secretBox = createSecretBoxFromKey(randomBytes(32))
      const provider = await createOidcProvidersService({ db, secretBox }).create({
        slug: 'corp',
        displayName: 'Corporate SSO',
        issuerUrl: 'https://idp.example.test',
        clientId: 'client',
        clientSecret: 'secret',
        scopes: 'openid',
        provisioning: 'invite',
        allowedEmailDomains: [],
        iconUrl: null,
        enabled: true,
      })
      const app = (await scope.open()).app
      const admin = (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${DAEMON_TOKEN}`)
        if (init.body !== undefined) headers.set('content-type', 'application/json')
        return app.request(path, { ...init, headers })
      }

      const off = await admin('/api/oidc/login-policy', {
        method: 'PUT',
        body: JSON.stringify({ passwordLoginEnabled: false }),
      })
      expect(off.status).toBe(200)
      expect(((await off.json()) as { passwordLoginEnabled: boolean }).passwordLoginEnabled).toBe(
        false,
      )
      const userDefault = await admin('/api/oidc/login-policy', {
        method: 'PUT',
        body: JSON.stringify({ oidcDefaultRole: 'user' }),
      })
      expect(userDefault.status).toBe(200)
      expect(((await userDefault.json()) as { oidcDefaultRole: string }).oidcDefaultRole).toBe(
        'user',
      )
      const discovery = (await (await app.request('/api/auth/oidc/providers')).json()) as {
        mode: string
        passwordLoginEnabled: boolean
        providers: unknown[]
      }
      expect(discovery.mode).toBe('ready')
      expect(discovery.passwordLoginEnabled).toBe(false)
      expect(discovery.providers).toHaveLength(1)

      const disabled = await admin(`/api/oidc/providers/${provider.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      })
      expect(disabled.status).toBe(409)
      expect(((await disabled.json()) as { code: string }).code).toBe('last-enabled-oidc-required')
      const removed = await admin(`/api/oidc/providers/${provider.id}`, { method: 'DELETE' })
      expect(removed.status).toBe(409)
      expect(((await removed.json()) as { code: string }).code).toBe('last-enabled-oidc-required')

      const on = await admin('/api/oidc/login-policy', {
        method: 'PUT',
        body: JSON.stringify({ passwordLoginEnabled: true }),
      })
      expect(on.status).toBe(200)
      expect((await admin(`/api/oidc/providers/${provider.id}`, { method: 'DELETE' })).status).toBe(
        204,
      )
    })

    test('disabled providers stay undiscoverable and cannot mint a login flow', async () => {
      const db = scope.harness.db
      const secretBox = createSecretBoxFromKey(randomBytes(32))
      await createOidcProvidersService({ db, secretBox }).create({
        slug: 'disabled-corp',
        displayName: 'Disabled Corporate SSO',
        issuerUrl: 'https://idp.example.test',
        clientId: 'client',
        clientSecret: 'secret',
        scopes: 'openid',
        provisioning: 'invite',
        allowedEmailDomains: [],
        iconUrl: null,
        enabled: false,
      })
      const app = (await scope.open()).app
      const discovery = (await (await app.request('/api/auth/oidc/providers')).json()) as {
        providers: Array<{ slug: string }>
      }
      expect(discovery.providers).toEqual([])

      const start = await app.request('/api/auth/oidc/disabled-corp/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(start.status).toBe(404)
      expect((await start.json()) as Record<string, unknown>).toMatchObject({
        ok: false,
        code: 'provider-not-found',
      })

      const callback = await app.request('/api/auth/oidc/disabled-corp/callback')
      expect(callback.status).toBe(400)
      expect(await callback.text()).toContain('OIDC callback is missing required parameters.')
    })

    test('provider management rejects regular users and never returns the client secret', async () => {
      const db = scope.harness.db
      const secretBox = createSecretBoxFromKey(randomBytes(32))
      const provider = await createOidcProvidersService({ db, secretBox }).create({
        slug: 'redacted-corp',
        displayName: 'Redacted Corporate SSO',
        issuerUrl: 'https://idp.example.test',
        clientId: 'client',
        clientSecret: 'super-secret-value',
        scopes: 'openid',
        provisioning: 'invite',
        allowedEmailDomains: [],
        iconUrl: null,
        enabled: true,
      })
      const app = (await scope.open()).app
      const user = await createUser(db, {
        username: 'plain-user',
        displayName: 'Plain User',
        role: 'user',
        password: 'longEnoughPassword',
      })
      const session = await createSession({ db, userId: user.id })

      const forbidden = await app.request('/api/oidc/providers', {
        headers: { Authorization: `Bearer ${session.token}` },
      })
      expect(forbidden.status).toBe(403)

      for (const path of ['/api/oidc/providers', `/api/oidc/providers/${provider.id}`]) {
        const response = await app.request(path, {
          headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
        })
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).not.toContain('super-secret-value')
        expect(text).toContain('"clientSecret":"***"')
      }
    })
  },
)

// RFC-359 AC-6 例外：单引擎。理由见块内注释——被测状态（无 secretBox 的装配）在 PostgreSQL
// 的组合根上按构造不存在。
describe('RFC-221 login policy routes — no-secret deployment', () => {
  test('public OIDC routes fail closed when runtime support or callback inputs are missing', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // **故意不给 secretBox**：这条判据测的就是「部署没有密钥 ⇒ OIDC 运行时不可用」这个状态。
    // 共用 HTTP 作用域装配的应用**总是**带一个 secretBox，接不进去；而
    // `composePostgresqlApplication` 的入参里 `secretBox` 是**必填**的，这个状态在
    // PostgreSQL 上按构造就不存在——不是「还没迁」，是两侧的装配合同本来就不对称
    // （已记进 RFC-359 plan §5u）。所以这一条留在单引擎 `createApp` 上。
    const app = createApp({
      token: DAEMON_TOKEN,
      configPath: '/tmp/aw-rfc221-no-secret-config-never-used.json',
      opencodeVersion: 'test',
      dbVersion: 110,
      db,
    })
    const discovery = await app.request('/api/auth/oidc/providers')
    expect(discovery.status).toBe(200)
    expect((await discovery.json()) as Record<string, unknown>).toMatchObject({
      mode: 'ready',
      providers: [],
      daemonTokenEnabled: false,
    })

    const start = await app.request('/api/auth/oidc/corp/login/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(start.status).toBe(503)
    expect((await start.json()) as Record<string, unknown>).toMatchObject({
      ok: false,
      code: 'oidc-not-configured',
    })

    const callback = await app.request('/api/auth/oidc/corp/callback')
    expect(callback.status).toBe(503)
    expect(await callback.text()).toContain('OIDC is not configured on this server.')
  })
})
