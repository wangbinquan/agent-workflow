// RFC-036 — /api/auth/login + /me + /change-password + sessions + PATs + identities.

import { beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createPat } from '../src/auth/patStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { oidcProviders } from '../src/db/schema'
import { createApp } from '../src/server'
import { createIdentity } from '../src/services/userIdentities'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
}

async function buildHarness(bootstrap: 'ready' | 'required' = 'ready'): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS, { bootstrap })
  const secretBox = createSecretBoxFromKey(randomBytes(32))
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox,
  })
  return { db, app }
}

describe('RFC-221 bootstrap and login-policy route contracts', () => {
  test('bootstrap endpoints require the daemon actor and validate the admin payload', async () => {
    const fresh = await buildHarness('required')
    const invalid = await reqRaw(
      fresh.app,
      '/api/auth/bootstrap/admin',
      { method: 'POST', body: JSON.stringify({}) },
      { Authorization: `Bearer ${DAEMON_TOKEN}` },
    )
    expect(invalid.status).toBe(422)
    expect(((await invalid.json()) as { code: string }).code).toBe('bootstrap-admin-invalid')

    const ready = await buildHarness()
    await createUser(ready.db, {
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      password: 'correctPassword123',
    })
    const login = await reqRaw(ready.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'correctPassword123' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    const wrongActor = await reqRaw(
      ready.app,
      '/api/auth/bootstrap/status',
      {},
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(wrongActor.status).toBe(403)
    expect(((await wrongActor.json()) as { code: string }).code).toBe('bootstrap-daemon-required')
  })

  test('login-policy rejects an invalid payload with its stable route code', async () => {
    const h = await buildHarness()
    await createUser(h.db, {
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      password: 'correctPassword123',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'correctPassword123' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    const invalid = await reqRaw(
      h.app,
      '/api/oidc/login-policy',
      { method: 'PUT', body: JSON.stringify({ passwordLoginEnabled: 'no' }) },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(invalid.status).toBe(422)
    expect(((await invalid.json()) as { code: string }).code).toBe('login-policy-invalid')
  })
})

async function reqRaw(
  app: Hono,
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('content-type')) h.set('content-type', 'application/json')
  return app.request(path, { ...init, headers: h })
}

describe('POST /api/auth/login', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
    await createUser(h.db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'correctPassword123',
    })
  })

  test('happy path returns sessionToken + user', async () => {
    const res = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'correctPassword123' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionToken: string; user: { username: string } }
    expect(body.sessionToken.startsWith('aws_s_')).toBe(true)
    expect(body.user.username).toBe('alice')
  })

  test('wrong password → 401 (constant-time response)', async () => {
    const res = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'wrong-pw' }),
    })
    expect(res.status).toBe(401)
  })

  test('unknown user → 401 (no leakage)', async () => {
    const res = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'ghost', password: 'irrelevant' }),
    })
    expect(res.status).toBe(401)
  })

  test('invalid body → 422', async () => {
    const res = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: '' }),
    })
    expect(res.status).toBe(422)
  })
})

describe('/api/auth/me', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('returns the resolved actor + linked identities + pats (admin via daemon token)', async () => {
    const res = await reqRaw(h.app, '/api/auth/me', {}, { Authorization: `Bearer ${DAEMON_TOKEN}` })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user: { id: string }
      source: string
      linkedIdentities: unknown[]
      pats: unknown[]
    }
    expect(body.source).toBe('daemon')
    expect(Array.isArray(body.linkedIdentities)).toBe(true)
    expect(Array.isArray(body.pats)).toBe(true)
  })
})

describe('Change-password round-trip', () => {
  test('user can change password + revoke other sessions', async () => {
    const h = await buildHarness()
    await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'oldOldOldOld',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'oldOldOldOld' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    const change = await reqRaw(
      h.app,
      '/api/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify({ oldPassword: 'oldOldOldOld', newPassword: 'newNewNewNew' }),
      },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(change.status).toBe(200)
    const body = (await change.json()) as { sessionToken: string }
    expect(body.sessionToken.startsWith('aws_s_')).toBe(true)
    // Old session is now revoked
    const me = await reqRaw(h.app, '/api/auth/me', {}, { Authorization: `Bearer ${sessionToken}` })
    expect(me.status).toBe(401)
    // New session works
    const me2 = await reqRaw(
      h.app,
      '/api/auth/me',
      {},
      { Authorization: `Bearer ${body.sessionToken}` },
    )
    expect(me2.status).toBe(200)
  })

  test('wrong old password → 403', async () => {
    const h = await buildHarness()
    await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'goodGoodGood',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'goodGoodGood' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    const change = await reqRaw(
      h.app,
      '/api/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'newNewNewNew' }),
      },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(change.status).toBe(403)
  })
})

describe('RFC-221 OIDC-managed account restrictions', () => {
  test('linked identity blocks local password changes and self-unlink', async () => {
    const h = await buildHarness()
    const bob = await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'goodGoodGood',
    })
    const providerId = ulid()
    const now = Date.now()
    await h.db.insert(oidcProviders).values({
      id: providerId,
      slug: 'managed-idp',
      displayName: 'Managed IdP',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-abc',
      clientSecretEnc: 'enc',
      createdAt: now,
      updatedAt: now,
    })
    const identity = await createIdentity(h.db, {
      userId: bob.id,
      providerId,
      subject: 'bob-at-idp',
      email: 'bob@example.com',
      emailVerified: true,
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'goodGoodGood' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }

    const change = await reqRaw(
      h.app,
      '/api/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify({ oldPassword: 'goodGoodGood', newPassword: 'newNewNewNew' }),
      },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(change.status).toBe(403)
    expect(((await change.json()) as { code: string }).code).toBe('oidc-password-managed')

    const unlink = await reqRaw(
      h.app,
      `/api/auth/identities/${identity.id}`,
      { method: 'DELETE' },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(unlink.status).toBe(403)
    expect(((await unlink.json()) as { code: string }).code).toBe('identity-unlink-disabled')
    const identities = await reqRaw(
      h.app,
      '/api/auth/identities',
      {},
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(((await identities.json()) as Array<{ id: string }>).map((row) => row.id)).toEqual([
      identity.id,
    ])
  })
})

describe('PATs', () => {
  test('creation is disabled while existing tokens remain listable and revocable', async () => {
    const h = await buildHarness()
    const bob = await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'pw12345678' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }

    const created = await reqRaw(
      h.app,
      '/api/auth/pats',
      { method: 'POST', body: JSON.stringify({ name: 'ci-launcher', scopes: ['tasks:launch'] }) },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(created.status).toBe(403)
    expect(((await created.json()) as { code: string }).code).toBe('pat-creation-disabled')

    // RFC-221 deliberately keeps the retirement path for pre-existing PATs.
    const { token, meta } = await createPat({
      db: h.db,
      userId: bob.id,
      name: 'legacy-ci-launcher',
      scopes: ['tasks:launch'],
    })
    expect(token.startsWith('aws_pat_')).toBe(true)

    const list = await reqRaw(
      h.app,
      '/api/auth/pats',
      {},
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(list.status).toBe(200)
    expect(((await list.json()) as unknown[]).length).toBe(1)

    const del = await reqRaw(
      h.app,
      `/api/auth/pats/${meta.id}`,
      { method: 'DELETE' },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(del.status).toBe(204)
    // After revoke, PAT token cannot be used.
    const auth = await reqRaw(h.app, '/api/auth/me', {}, { Authorization: `Bearer ${token}` })
    expect(auth.status).toBe(401)
  })

  test('creation denial happens before payload scope processing', async () => {
    const h = await buildHarness()
    await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'pw12345678' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    const created = await reqRaw(
      h.app,
      '/api/auth/pats',
      {
        method: 'POST',
        // RFC-099: agents:write moved to user baseline; users:read stays admin-only.
        body: JSON.stringify({ name: 'overreach', scopes: ['users:read', 'tasks:launch'] }),
      },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(created.status).toBe(403)
    const body = (await created.json()) as { code: string }
    expect(body.code).toBe('pat-creation-disabled')
  })
})
