// RFC-221 — admin login-method API and provider lifecycle protection.

import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createSession } from './helpers/auth/sessionStore'

import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { createOidcProvidersService } from '../src/services/oidcProviders'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'd'.repeat(64)

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

// RFC-359 AC-1（plan §5gt）：这里原来有一格 `no-secret deployment` —— 它**故意不传 secretBox**，
// 断言 OIDC 装配退化成 null 之后那两条 503。本轮把 `AppDeps.secretBox` 收成必填、删掉了那个
// null 分支，于是**被测状态不复存在**（改完实测：那两条断言从 503 变 404，因为路由现在真的
// 走到服务里、只是没有名叫 corp 的 provider）。
//
// 这一格是连同它锁的分支一起退役的，不是「测试删了」：该文件注释当年就写明「正解是把 SQLite 根的
// secretBox 收成必填、删掉 null 分支与那两个 503，那样这条用例连同本文件最后一条账本残留一起消失」。
// 现在正是那一刀。文件其余部分本来就在 `describeEachProviderHttpApplication` 上双引擎跑。
