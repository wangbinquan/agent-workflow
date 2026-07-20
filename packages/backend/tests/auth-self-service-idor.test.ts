// Account self-service — horizontal privilege (IDOR) boundary.
//
// WHY THIS EXISTS
// ---------------
// The 2026-07-21 test-guard audit (gap B1-routes-1, P0) found that the three
// destructive self-service endpoints carry hand-written ownership checks in the
// route body …
//
//   POST   /api/auth/sessions/:id/revoke   row.userId !== actor.user.id → 403
//   DELETE /api/auth/pats/:id              WHERE id = :id AND user_id = me → 403
//   DELETE /api/auth/identities/:id        id ∉ listIdentitiesForUser(me) → 403
//
// … and that NOTHING exercised them with a second user. Every existing case in
// auth-routes.test.ts acts as a single user (or as the daemon token, which maps
// to a system admin and short-circuits nothing here but is still one identity).
// Repository-wide, only 41 of 764 backend test files ever create a second user,
// which is why this whole class of check was structurally unguarded.
//
// These ids are not secret: they appear in the sessions/PAT management UI, in
// audit columns and in logs. If any of these three checks is dropped during a
// refactor, any logged-in user can kick another user off their session, revoke
// their CI token, or unlink their SSO identity — and if that was the victim's
// only credential, lock them out permanently. None of it would turn a test red.
//
// Every case below is written as attack → refusal → *and the target survives*.
// Asserting only the 403 would still pass if the handler threw AFTER performing
// the deletion, so each test re-checks the victim's state afterwards. Positive
// controls at the end prove the 403s come from the ownership check and not from
// a blanket denial that would make the whole file vacuous.
//
// See design/test-guard-audit-2026-07-21 §1 (P0 list) / 逃逸机制③.

import { beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { oidcProviders } from '../src/db/schema'
import { createApp } from '../src/server'
import { createIdentity } from '../src/services/userIdentities'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const PASSWORD = 'correctPassword123'

interface Actor {
  id: string
  username: string
  token: string
}

interface Harness {
  db: DbClient
  app: Hono
  alice: Actor
  bob: Actor
  providerId: string
}

async function login(app: Hono, username: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`)
  const body = (await res.json()) as { sessionToken: string }
  return body.sessionToken
}

async function as(
  app: Hono,
  actor: Actor,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${actor.token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
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

  // Deliberately BOTH non-admin: an admin actor could legitimately be allowed
  // more, which would blur what these cases prove.
  const aliceRow = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    password: PASSWORD,
  })
  const bobRow = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: PASSWORD,
  })

  const now = Date.now()
  const providerId = ulid()
  await db.insert(oidcProviders).values({
    id: providerId,
    slug: 'idp',
    displayName: 'Test IdP',
    issuerUrl: 'https://idp.example.com',
    clientId: 'client-abc',
    clientSecretEnc: 'enc',
    createdAt: now,
    updatedAt: now,
  })

  const alice: Actor = {
    id: aliceRow.id,
    username: 'alice',
    token: await login(app, 'alice'),
  }
  const bob: Actor = { id: bobRow.id, username: 'bob', token: await login(app, 'bob') }
  return { db, app, alice, bob, providerId }
}

describe('account self-service is scoped to the calling user', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test("a user cannot revoke another user's session", async () => {
    // Alice opens a second session (the one she is browsing with must survive
    // for the "victim still works" assertion to mean anything).
    const victimToken = await login(h.app, 'alice')
    const listed = (await (await as(h.app, h.alice, '/api/auth/sessions')).json()) as Array<{
      id: string
    }>
    expect(listed.length).toBeGreaterThanOrEqual(2)

    for (const session of listed) {
      const res = await as(h.app, h.bob, `/api/auth/sessions/${session.id}/revoke`, {
        method: 'POST',
      })
      expect(`bob revoking alice session → ${res.status}`).toBe('bob revoking alice session → 403')
    }

    // The sessions must still be usable — a handler that revoked first and threw
    // afterwards would satisfy the status assertion above.
    const meVictim = await h.app.request('/api/auth/me', {
      headers: { authorization: `Bearer ${victimToken}` },
    })
    expect(meVictim.status).toBe(200)
    expect((await as(h.app, h.alice, '/api/auth/me')).status).toBe(200)
  })

  test("a user cannot revoke another user's personal access token", async () => {
    const created = await as(h.app, h.alice, '/api/auth/pats', {
      method: 'POST',
      body: JSON.stringify({ name: 'ci' }),
    })
    expect(created.status).toBe(201)
    const pat = (await created.json()) as { id: string; token: string }

    const res = await as(h.app, h.bob, `/api/auth/pats/${pat.id}`, { method: 'DELETE' })
    expect(res.status).toBe(403)

    // Alice's CI token still authenticates.
    const me = await h.app.request('/api/auth/me', {
      headers: { authorization: `Bearer ${pat.token}` },
    })
    expect(me.status).toBe(200)
    const stillListed = (await (await as(h.app, h.alice, '/api/auth/pats')).json()) as Array<{
      id: string
    }>
    expect(stillListed.some((row) => row.id === pat.id)).toBe(true)
  })

  test("a user cannot unlink another user's SSO identity", async () => {
    // Worst case of the three: for a user provisioned through SSO with no local
    // password, unlinking the only identity is an account lockout.
    const identity = await createIdentity(h.db, {
      userId: h.alice.id,
      providerId: h.providerId,
      subject: 'alice-at-idp',
      email: 'alice@example.com',
      emailVerified: true,
    })

    const res = await as(h.app, h.bob, `/api/auth/identities/${identity.id}`, { method: 'DELETE' })
    expect(res.status).toBe(403)

    const stillLinked = (await (await as(h.app, h.alice, '/api/auth/identities')).json()) as Array<{
      id: string
    }>
    expect(stillLinked.map((row) => row.id)).toEqual([identity.id])
  })

  test('listing endpoints only ever return the calling user’s own rows', async () => {
    await as(h.app, h.alice, '/api/auth/pats', {
      method: 'POST',
      body: JSON.stringify({ name: 'alice-ci' }),
    })
    await createIdentity(h.db, {
      userId: h.alice.id,
      providerId: h.providerId,
      subject: 'alice-at-idp',
      email: 'alice@example.com',
      emailVerified: true,
    })

    // Bob sees none of it — the projection, not just the mutation, is scoped.
    expect((await (await as(h.app, h.bob, '/api/auth/pats')).json()) as unknown[]).toEqual([])
    expect((await (await as(h.app, h.bob, '/api/auth/identities')).json()) as unknown[]).toEqual([])
    const bobSessions = (await (await as(h.app, h.bob, '/api/auth/sessions')).json()) as Array<{
      userId?: string
    }>
    expect(bobSessions.length).toBe(1)
  })

  // --- positive controls -----------------------------------------------------
  // Without these, a handler that rejected EVERY request would pass every case
  // above, and this file would be a guard with no teeth.

  test('a user can revoke their own session, token, and identity', async () => {
    const before = (await (await as(h.app, h.alice, '/api/auth/sessions')).json()) as Array<{
      id: string
    }>
    const doomedToken = await login(h.app, 'alice')
    const after = (await (await as(h.app, h.alice, '/api/auth/sessions')).json()) as Array<{
      id: string
    }>
    const doomed = after.find((s) => !before.some((b) => b.id === s.id))
    if (!doomed) throw new Error('could not identify the newly created session')

    // Revoke the session that is NOT the one we authenticate with, so the 204
    // cannot be confused with "the caller nuked its own credential".
    expect(
      (await h.app.request('/api/auth/me', { headers: { authorization: `Bearer ${doomedToken}` } }))
        .status,
    ).toBe(200)
    expect(
      (await as(h.app, h.alice, `/api/auth/sessions/${doomed.id}/revoke`, { method: 'POST' }))
        .status,
    ).toBe(204)
    expect(
      (await h.app.request('/api/auth/me', { headers: { authorization: `Bearer ${doomedToken}` } }))
        .status,
    ).toBe(401)
    // …and the caller's own session is untouched.
    expect((await as(h.app, h.alice, '/api/auth/me')).status).toBe(200)

    const alice: Actor = h.alice
    const pat = (await (
      await as(h.app, alice, '/api/auth/pats', {
        method: 'POST',
        body: JSON.stringify({ name: 'mine' }),
      })
    ).json()) as { id: string }
    expect((await as(h.app, alice, `/api/auth/pats/${pat.id}`, { method: 'DELETE' })).status).toBe(
      204,
    )

    const identity = await createIdentity(h.db, {
      userId: alice.id,
      providerId: h.providerId,
      subject: 'alice-at-idp',
      email: 'alice@example.com',
      emailVerified: true,
    })
    expect(
      (await as(h.app, alice, `/api/auth/identities/${identity.id}`, { method: 'DELETE' })).status,
    ).toBe(204)
    expect((await (await as(h.app, alice, '/api/auth/identities')).json()) as unknown[]).toEqual([])
  })

  // NOTE (documented, not asserted as desirable): the three handlers disagree on
  // what they reveal about ids they refuse. Sessions answer 404 for an id that
  // does not exist but 403 for one that belongs to somebody else — an existence
  // oracle. PATs and identities answer 403 for both, matching RFC-099's
  // "indistinguishable from not-found" rule. Locking the current shapes here so
  // the divergence is visible; unifying it is a product decision, not a
  // refactor, and is filed in design/test-guard-audit-2026-07-21.
  test('refusal shapes are locked so the sessions existence-oracle cannot spread', async () => {
    const unknownId = ulid()
    expect(
      (await as(h.app, h.bob, `/api/auth/sessions/${unknownId}/revoke`, { method: 'POST' })).status,
    ).toBe(404)
    expect(
      (await as(h.app, h.bob, `/api/auth/pats/${unknownId}`, { method: 'DELETE' })).status,
    ).toBe(403)
    expect(
      (await as(h.app, h.bob, `/api/auth/identities/${unknownId}`, { method: 'DELETE' })).status,
    ).toBe(403)
  })
})
