// RFC-036 — /api/auth/login + /me + /change-password + sessions + PATs + identities.

import { beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
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

async function buildHarness(
  bootstrap: 'ready' | 'required' = 'ready',
  configPath = '/tmp/aw-test-config-never-used.json',
): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS, { bootstrap })
  const secretBox = createSecretBoxFromKey(randomBytes(32))
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox,
  })
  return { db, app }
}

/** Writes a real config file so `isMcpSurfaceEnabled` reads a real value. */
function writeConfigWithSurface(enabled: boolean): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aw-rfc247-cfg-')), 'config.json')
  writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, mcpSurfaceEnabled: enabled }))
  return path
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
      profile: { displayName: string; email: string | null; gitCommitIdentity: unknown }
      source: string
      linkedIdentities: unknown[]
      pats: unknown[]
    }
    expect(body.source).toBe('daemon')
    expect(body.profile.displayName.length).toBeGreaterThan(0)
    expect(Array.isArray(body.linkedIdentities)).toBe(true)
    expect(Array.isArray(body.pats)).toBe(true)
  })

  test('session profile is private, self-editable as one complete Git identity pair, and audited', async () => {
    const alice = await createUser(h.db, {
      username: 'alice',
      displayName: 'Alice',
      email: 'alice@example.test',
      role: 'user',
      password: 'alicePassword123',
    })
    await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      email: 'bob@example.test',
      role: 'user',
      password: 'bobPassword123',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'alicePassword123' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    const authorization = { Authorization: `Bearer ${sessionToken}` }

    const before = await reqRaw(h.app, '/api/auth/me', {}, authorization)
    expect((await before.json()) as unknown).toMatchObject({
      user: { username: 'alice', displayName: 'Alice' },
      profile: {
        displayName: 'Alice',
        email: 'alice@example.test',
        gitCommitIdentity: { name: 'Alice', email: 'alice@example.test' },
      },
    })

    const updated = await reqRaw(
      h.app,
      '/api/auth/me/profile',
      {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: ' Alice Chen ',
          email: 'ALICE.CHEN@EXAMPLE.TEST',
        }),
      },
      authorization,
    )
    expect(updated.status).toBe(200)
    expect((await updated.json()) as unknown).toEqual({
      profile: {
        displayName: 'Alice Chen',
        email: 'alice.chen@example.test',
        gitCommitIdentity: { name: 'Alice Chen', email: 'alice.chen@example.test' },
      },
    })

    const audit = h.db.$client
      .query(
        `SELECT actor_user_id, actor_kind, before_role, after_role,
                added_permissions_json, removed_permissions_json
         FROM user_access_audit
         WHERE target_user_id = ? AND actor_user_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(alice.id, alice.id)
    expect(audit).toEqual({
      actor_user_id: alice.id,
      actor_kind: 'session',
      before_role: 'user',
      after_role: 'user',
      added_permissions_json: '[]',
      removed_permissions_json: '[]',
    })

    const conflict = await reqRaw(
      h.app,
      '/api/auth/me/profile',
      {
        method: 'PATCH',
        body: JSON.stringify({ displayName: 'Alice', email: 'bob@example.test' }),
      },
      authorization,
    )
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { code: string }).code).toBe('profile-email-conflict')

    const widened = await reqRaw(
      h.app,
      '/api/auth/me/profile',
      {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: 'Alice',
          email: 'alice@example.test',
          role: 'admin',
        }),
      },
      authorization,
    )
    expect(widened.status).toBe(422)
    expect(((await widened.json()) as { code: string }).code).toBe('profile-invalid')
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

    // RFC-247 D1 REOPENS creation. RFC-221 D1 had closed it globally because
    // there was no way to issue a NARROW token — `资源:write` covered delete
    // too, and an empty scope list silently meant "everything the owner has".
    // RFC-247 fixed both, which is what makes issuing safe again, so this test
    // now locks the ISSUING contract instead of the closure.
    const created = await reqRaw(
      h.app,
      '/api/auth/pats',
      { method: 'POST', body: JSON.stringify({ name: 'ci-launcher', scopes: ['tasks:execute'] }) },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(created.status).toBe(201)
    const issued = (await created.json()) as {
      token: string
      pat: { id: string; scopes: string[] }
    }
    // The raw token is returned exactly once; only its SHA-256 is stored, so no
    // later read path can surface it again.
    expect(issued.token.startsWith('aws_pat_')).toBe(true)
    expect(issued.pat.scopes).toEqual(['tasks:execute'])

    const { token, meta } = await createPat({
      db: h.db,
      userId: bob.id,
      name: 'legacy-ci-launcher',
      scopes: ['tasks:execute'],
      purpose: 'general',
    })
    expect(token.startsWith('aws_pat_')).toBe(true)

    const list = await reqRaw(
      h.app,
      '/api/auth/pats',
      {},
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(list.status).toBe(200)
    // the freshly issued one plus the directly-seeded one
    expect(((await list.json()) as unknown[]).length).toBe(2)

    const del = await reqRaw(
      h.app,
      `/api/auth/pats/${meta.id}`,
      { method: 'DELETE' },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(del.status).toBe(204)
    // After revoke the token no longer authenticates. Probed via /api/whoami:
    // RFC-247 D6 closes all of /api/auth/* to tokens, so /api/auth/me would 403
    // for a LIVE token too and could not distinguish revoked from forbidden.
    const auth = await reqRaw(h.app, '/api/whoami', {}, { Authorization: `Bearer ${token}` })
    expect(auth.status).toBe(401)
  })

  // RFC-247 D10 / AC-18 — the surviving half of RFC-221's intent. RFC-221 wanted
  // "no one mints a credential outside the sanctioned path"; RFC-247 replaces a
  // permanent closure with an operator-controlled switch, so the thing worth
  // locking is that the switch is REAL — i.e. that the route consults it rather
  // than merely having a config field somebody could believe in.
  test('creation is refused while the external surface switch is off (AC-18)', async () => {
    const h = await buildHarness('ready', writeConfigWithSurface(false))
    await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'admin',
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
      { method: 'POST', body: JSON.stringify({ name: 'blocked', scopes: [] }) },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(created.status).toBe(403)
    expect(((await created.json()) as { code: string }).code).toBe('token-issuance-disabled')

    // Zero side effects: nothing was written before the refusal.
    const list = await reqRaw(
      h.app,
      '/api/auth/pats',
      {},
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect((await list.json()) as unknown[]).toEqual([])

    // The SAME request succeeds with the switch on — otherwise this test would
    // also pass if creation were broken for an unrelated reason.
    const open = await buildHarness('ready', writeConfigWithSurface(true))
    await createUser(open.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'admin',
      password: 'pw12345678',
    })
    const openLogin = await reqRaw(open.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'pw12345678' }),
    })
    const openSession = ((await openLogin.json()) as { sessionToken: string }).sessionToken
    const openCreated = await reqRaw(
      open.app,
      '/api/auth/pats',
      { method: 'POST', body: JSON.stringify({ name: 'allowed', scopes: [] }) },
      { Authorization: `Bearer ${openSession}` },
    )
    expect(openCreated.status).toBe(201)
  })

  test('an over-reaching matrix is REFUSED, not silently narrowed (AC-7)', async () => {
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
        body: JSON.stringify({ name: 'overreach', scopes: ['users:read', 'tasks:execute'] }),
      },
      { Authorization: `Bearer ${sessionToken}` },
    )
    // `resolveTokenPermissions` would drop `users:read` anyway (a token never
    // exceeds its owner's role), so silently accepting would still be SAFE —
    // and would still be wrong. The user walks away believing they issued a
    // token that can read users, and finds out when the automation 403s hours
    // later, far from this decision.
    expect(created.status).toBe(422)
    const body = (await created.json()) as { code: string; details?: { ungrantable?: string[] } }
    expect(body.code).toBe('pat-scope-ungrantable')
    expect(body.details?.ungrantable).toEqual(['users:read'])
  })
})
