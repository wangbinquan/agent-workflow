// RFC-036 — /api/users admin routes + /api/users/search public-field endpoint.

import { beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  bobToken: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const secretBox = createSecretBoxFromKey(randomBytes(32))
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox,
  })
  const bob = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: bob.id })
  return { db, app, bobToken: token }
}

async function reqAs(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const h = new Headers(init.headers)
  h.set('Authorization', `Bearer ${token}`)
  if (init.body && !h.has('content-type')) h.set('content-type', 'application/json')
  return app.request(path, { ...init, headers: h })
}

describe('/api/users (admin only)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('GET /api/users — daemon token OK; user token 403', async () => {
    const admin = await reqAs(h.app, DAEMON_TOKEN, '/api/users')
    expect(admin.status).toBe(200)
    const user = await reqAs(h.app, h.bobToken, '/api/users')
    expect(user.status).toBe(403)
  })

  test('POST /api/users — daemon token creates a user', async () => {
    const res = await reqAs(h.app, DAEMON_TOKEN, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'carol',
        displayName: 'Carol',
        role: 'user',
        password: 'longEnoughPassword',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { username: string; role: string }
    expect(body.username).toBe('carol')
  })

  test('PATCH /api/users/:id — daemon token updates displayName', async () => {
    const created = await reqAs(h.app, DAEMON_TOKEN, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'carol',
        displayName: 'Carol',
        role: 'user',
        password: 'longEnoughPassword',
      }),
    })
    const { id } = (await created.json()) as { id: string }
    const patched = await reqAs(h.app, DAEMON_TOKEN, `/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Carol Liu' }),
    })
    expect(patched.status).toBe(200)
    const body = (await patched.json()) as { displayName: string }
    expect(body.displayName).toBe('Carol Liu')
  })

  // Self-role lockout guard: an admin demoting themselves would lose the very
  // permission needed to undo it. PATCHing your own role → 422
  // self-role-change-forbidden; another admin's session can still do it.
  test('PATCH /api/users/:id — admin cannot change own role', async () => {
    const alice = await createUser(h.db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db: h.db, userId: alice.id })
    const res = await reqAs(h.app, token, `/api/users/${alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('self-role-change-forbidden')
    // Non-role self-edits still work.
    const rename = await reqAs(h.app, token, `/api/users/${alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Alice Liu' }),
    })
    expect(rename.status).toBe(200)
    // A different admin session can change Alice's role.
    const boss = await createUser(h.db, {
      username: 'boss',
      displayName: 'Boss',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const bossSession = await createSession({ db: h.db, userId: boss.id })
    const demoted = await reqAs(h.app, bossSession.token, `/api/users/${alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    })
    expect(demoted.status).toBe(200)
    expect(((await demoted.json()) as { role: string }).role).toBe('user')
  })

  test('DELETE /api/users/:id soft-disables', async () => {
    const created = await reqAs(h.app, DAEMON_TOKEN, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'dave',
        displayName: 'Dave',
        role: 'user',
        password: 'longEnoughPassword',
      }),
    })
    const { id } = (await created.json()) as { id: string }
    const del = await reqAs(h.app, DAEMON_TOKEN, `/api/users/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const get = await reqAs(h.app, DAEMON_TOKEN, `/api/users/${id}`)
    expect(get.status).toBe(200)
    const body = (await get.json()) as { status: string }
    expect(body.status).toBe('disabled')
  })

  // Self-disable lockout (mirrors self-role-change-forbidden): an admin's own
  // session cannot DELETE (soft-disable) itself; another admin's session can.
  test('DELETE /api/users/:id — admin cannot disable own account', async () => {
    const alice = await createUser(h.db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const boss = await createUser(h.db, {
      username: 'boss',
      displayName: 'Boss',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db: h.db, userId: alice.id })
    const selfDel = await reqAs(h.app, token, `/api/users/${alice.id}`, { method: 'DELETE' })
    expect(selfDel.status).toBe(422)
    expect(((await selfDel.json()) as { code: string }).code).toBe('self-disable-forbidden')
    // A different admin session CAN disable alice.
    const bossSession = await createSession({ db: h.db, userId: boss.id })
    const del = await reqAs(h.app, bossSession.token, `/api/users/${alice.id}`, {
      method: 'DELETE',
    })
    expect(del.status).toBe(200)
  })

  // last-admin-protection at the HTTP layer: __system__ must NOT count, so
  // disabling the only human admin is refused (regression for the 2026-06-24
  // incident). DAEMON_TOKEN acts as __system__ (a different id) so this isn't
  // the self-guard.
  test('DELETE /api/users/:id — refuses disabling the last human admin', async () => {
    const alice = await createUser(h.db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const res = await reqAs(h.app, DAEMON_TOKEN, `/api/users/${alice.id}`, { method: 'DELETE' })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('last-admin-protection')
  })

  // Re-enable path: a soft-disabled user is restored via PATCH {status:'active'}
  // (the inverse of the DELETE soft-disable), so accounts are never stranded.
  test('PATCH /api/users/:id — re-enables a disabled user', async () => {
    const created = await reqAs(h.app, DAEMON_TOKEN, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'dave',
        displayName: 'Dave',
        role: 'user',
        password: 'longEnoughPassword',
      }),
    })
    const { id } = (await created.json()) as { id: string }
    await reqAs(h.app, DAEMON_TOKEN, `/api/users/${id}`, { method: 'DELETE' })
    const reenabled = await reqAs(h.app, DAEMON_TOKEN, `/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    })
    expect(reenabled.status).toBe(200)
    expect(((await reenabled.json()) as { status: string }).status).toBe('active')
  })

  test('reset-password rejects low privilege and invalid bodies before revoking sessions', async () => {
    const carol = await createUser(h.db, {
      username: 'carol',
      displayName: 'Carol',
      role: 'user',
      password: 'oldLongEnoughPassword',
    })
    const oldSession = await createSession({ db: h.db, userId: carol.id })

    const forbidden = await reqAs(h.app, h.bobToken, `/api/users/${carol.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: 'newLongEnoughPassword' }),
    })
    expect(forbidden.status).toBe(403)

    const invalid = await reqAs(h.app, DAEMON_TOKEN, `/api/users/${carol.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: 'short' }),
    })
    expect(invalid.status).toBe(422)
    expect(((await invalid.json()) as { code: string }).code).toBe('reset-invalid')

    // Both rejected paths must be side-effect free: the user's existing session
    // remains valid until an authorized, schema-valid reset wins.
    expect((await reqAs(h.app, oldSession.token, '/api/auth/me')).status).toBe(200)

    const reset = await reqAs(h.app, DAEMON_TOKEN, `/api/users/${carol.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: 'newLongEnoughPassword', force: true }),
    })
    expect(reset.status).toBe(200)
    expect((await reqAs(h.app, oldSession.token, '/api/auth/me')).status).toBe(401)

    const login = await h.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'carol',
        password: 'newLongEnoughPassword',
      }),
    })
    expect(login.status).toBe(200)
    expect((await login.json()) as Record<string, unknown>).toMatchObject({
      mustChangePassword: true,
    })
  })
})

describe('/api/users/search — admin + user (public 5-field view)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
    await createUser(h.db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    await createUser(h.db, {
      username: 'carol',
      displayName: 'Carol',
      role: 'user',
      password: 'longEnoughPassword',
    })
  })

  test('regular user can call /search', async () => {
    const res = await reqAs(h.app, h.bobToken, '/api/users/search?q=a')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    // Bob does not match "a" prefix; "alice" does.
    expect(body.some((r) => r.username === 'alice')).toBe(true)
  })

  test('search response only contains the public 5 fields', async () => {
    const res = await reqAs(h.app, h.bobToken, '/api/users/search?q=a')
    const body = (await res.json()) as Array<Record<string, unknown>>
    for (const row of body) {
      expect(Object.keys(row).sort()).toEqual(['displayName', 'id', 'role', 'status', 'username'])
      expect(row.email).toBeUndefined()
      expect(row.lastLoginAt).toBeUndefined()
    }
  })

  test('excludeIds removes the given ids from results', async () => {
    const aliceId = (
      (await reqAs(h.app, DAEMON_TOKEN, '/api/users?q=alice').then((r) => r.json())) as Array<{
        id: string
        username: string
      }>
    ).find((r) => r.username === 'alice')!.id
    const res = await reqAs(h.app, h.bobToken, `/api/users/search?q=a&excludeIds=${aliceId}`)
    const body = (await res.json()) as Array<{ id: string }>
    expect(body.some((r) => r.id === aliceId)).toBe(false)
  })

  test('status=active filters before the requested result limit', async () => {
    await createUser(h.db, {
      username: 'aaron-disabled',
      displayName: 'Aaron Disabled',
      role: 'user',
      status: 'disabled',
    })
    const res = await reqAs(h.app, h.bobToken, '/api/users/search?q=a&status=active&limit=1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ username: string; status: string }>
    expect(body).toHaveLength(1)
    expect(body[0]?.status).toBe('active')
  })

  test('lookup accepts a mixed batch but returns each known user once with public fields only', async () => {
    const users = (await (await reqAs(h.app, DAEMON_TOKEN, '/api/users')).json()) as Array<{
      id: string
      username: string
    }>
    const alice = users.find((user) => user.username === 'alice')!

    const res = await reqAs(h.app, h.bobToken, '/api/users/lookup', {
      method: 'POST',
      body: JSON.stringify({
        ids: [alice.id, alice.id, '__system__', 'missing-user-id', 42, '', null],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(body).toHaveLength(1)
    expect(body[0]?.id).toBe(alice.id)
    expect(Object.keys(body[0] ?? {}).sort()).toEqual([
      'displayName',
      'id',
      'role',
      'status',
      'username',
    ])
    expect(JSON.stringify(body)).not.toContain('email')
    expect(JSON.stringify(body)).not.toContain('lastLoginAt')
  })

  test('lookup treats malformed or empty ids as an empty blind resolve', async () => {
    for (const payload of [{}, { ids: 'alice' }, { ids: [null, 1, ''] }]) {
      const res = await reqAs(h.app, h.bobToken, '/api/users/lookup', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
    }
  })
})
