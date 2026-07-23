// RFC-221 — admin login-method API and provider lifecycle protection.

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import { createApp } from '../src/server'
import { createOidcProvidersService } from '../src/services/oidcProviders'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'd'.repeat(64)

describe('RFC-221 login policy routes', () => {
  test('OIDC enables password-off and protects the last enabled provider', async () => {
    const db = createInMemoryDb(MIGRATIONS)
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
    const app = createApp({
      token: DAEMON_TOKEN,
      configPath: '/tmp/aw-rfc221-config-never-used.json',
      opencodeVersion: 'test',
      dbVersion: 110,
      db,
      secretBox,
    })
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
})
