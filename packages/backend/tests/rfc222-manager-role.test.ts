// RFC-222 — the `manager` (资源管理员) role behavior matrix.
//
// manager = admin minus user management, system settings/ops, and task
// deletion; plus every resource-domain capability (row-level ACL bypass over
// any owner's resource). These tests pin both faces:
//   - POSITIVE: manager sees/manages others' private resources, reads all
//     tasks, reaches the distill-job ops surface, holds repos:write.
//   - NEGATIVE: manager is 403 on users / settings / oidc / backup / restore.
//   - resolveTaskRole attributes manager truthfully; buildActor keeps
//     tasks:delete out of a PAT unless explicitly scoped; last-admin protection
//     does not count manager as an admin.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor } from '../src/auth/actor'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents } from '../src/db/schema'
import { createApp } from '../src/server'
import { resolveTaskRole } from '../src/services/resourceAcl'
import { createUser, patchUser } from '../src/services/users'
import { ValidationError } from '../src/util/errors'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  adminToken: string
  managerToken: string
  userToken: string
  aliceId: string // owns a private agent
  managerId: string
}

async function tokenFor(db: DbClient, userId: string): Promise<string> {
  const { token } = await createSession({ db, userId })
  return token
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'root',
    displayName: 'Root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const manager = await createUser(db, {
    username: 'mgr',
    displayName: 'Manager',
    role: 'manager',
    password: 'longEnoughPassword',
  })
  const alice = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    password: 'longEnoughPassword',
  })
  // A second plain user (NOT the owner) for negative visibility checks.
  const bob = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  // A private agent owned by alice — the row a manager must be able to reach.
  const agId = ulid()
  await db.insert(agents).values({
    id: agId,
    name: `alice-secret-${agId}`,
    ownerUserId: alice.id,
    visibility: 'private',
  })
  return {
    db,
    app,
    adminToken: await tokenFor(db, admin.id),
    managerToken: await tokenFor(db, manager.id),
    userToken: await tokenFor(db, bob.id), // bob = stranger to alice's private agent
    aliceId: alice.id,
    managerId: manager.id,
  }
}

async function reqAs(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

describe('RFC-222 manager — denial face (system domain 403)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  const cases: Array<[string, string, RequestInit]> = [
    ['GET /api/users', '/api/users', {}],
    ['GET /api/config (settings:read)', '/api/config', {}],
    [
      'PUT /api/config (settings:write)',
      '/api/config',
      { method: 'PUT', body: '{"logLevel":"debug"}' },
    ],
    // (OIDC denial is locked by the shared permission snapshot — manager lacks
    // oidc:read/oidc:configure; the HTTP route path is owned by RFC-220.)
    ['POST /api/backup', '/api/backup', { method: 'POST' }],
    ['POST /api/restore', '/api/restore', { method: 'POST' }],
  ]
  for (const [name, path, init] of cases) {
    test(`manager ${name} → 403`, async () => {
      const res = await reqAs(h.app, h.managerToken, path, init)
      expect(res.status).toBe(403)
    })
  }

  test('manager POST /api/users/:id role change → 403 (no users:write)', async () => {
    const res = await reqAs(h.app, h.managerToken, `/api/users/${h.aliceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'manager' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('RFC-222 manager — positive resource / task / memory domain', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('manager sees alice’s private agent in the list (row bypass)', async () => {
    const res = await reqAs(h.app, h.managerToken, '/api/agents')
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<{ name: string; visibility?: string }>
    expect(list.some((a) => a.name.startsWith('alice-secret-'))).toBe(true)
  })

  test('a stranger user does NOT see alice’s private agent', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/agents')
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<{ name: string }>
    expect(list.some((a) => a.name.startsWith('alice-secret-'))).toBe(false)
  })

  test('manager GET /api/memory-distill-jobs → 200 (D3); stranger → 403', async () => {
    const mgr = await reqAs(h.app, h.managerToken, '/api/memory-distill-jobs')
    expect(mgr.status).toBe(200)
    const usr = await reqAs(h.app, h.userToken, '/api/memory-distill-jobs')
    expect(usr.status).toBe(403)
  })

  test('manager holds repos:write (POST /api/repos not 403); stranger → 403', async () => {
    const mgr = await reqAs(h.app, h.managerToken, '/api/repos', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(mgr.status).not.toBe(403) // gate open → 422/400 for empty body
    const usr = await reqAs(h.app, h.userToken, '/api/repos', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(usr.status).toBe(403)
  })

  test('manager GET /api/tasks?scope=all → 200 (tasks:read:all)', async () => {
    const res = await reqAs(h.app, h.managerToken, '/api/tasks?scope=all')
    expect(res.status).toBe(200)
  })
})

describe('RFC-222 manager — resolveTaskRole attribution', () => {
  test('non-member manager → "manager" (never folded into admin)', () => {
    const managerActor = buildActor({
      user: { id: 'm1', username: 'm', displayName: 'M', role: 'manager', status: 'active' },
      source: 'session',
    })
    expect(resolveTaskRole(managerActor, 'someone-else', false)).toBe('manager')
    // Membership still wins over the global manager identity.
    expect(resolveTaskRole(managerActor, 'someone-else', true)).toBe('user')
    expect(resolveTaskRole(managerActor, 'm1', false)).toBe('owner')
  })

  test('non-member admin → "admin"; plain user → null', () => {
    const adminActor = buildActor({
      user: { id: 'a1', username: 'a', displayName: 'A', role: 'admin', status: 'active' },
      source: 'session',
    })
    expect(resolveTaskRole(adminActor, 'other', false)).toBe('admin')
    const userActor = buildActor({
      user: { id: 'u1', username: 'u', displayName: 'U', role: 'user', status: 'active' },
      source: 'session',
    })
    expect(resolveTaskRole(userActor, 'other', false)).toBe(null)
  })
})

describe('RFC-222 — PAT explicit-only for tasks:delete (P1-3)', () => {
  test('empty-scoped admin PAT does NOT inherit tasks:delete', () => {
    const actor = buildActor({
      user: { id: 'a', username: 'a', displayName: 'A', role: 'admin', status: 'active' },
      source: 'pat',
      patScopes: [],
    })
    expect(actor.permissions.has('tasks:delete')).toBe(false)
    // …but a session admin keeps it (full role baseline).
    const sess = buildActor({
      user: { id: 'a', username: 'a', displayName: 'A', role: 'admin', status: 'active' },
      source: 'session',
    })
    expect(sess.permissions.has('tasks:delete')).toBe(true)
  })

  test('admin PAT that explicitly lists tasks:delete keeps it', () => {
    const actor = buildActor({
      user: { id: 'a', username: 'a', displayName: 'A', role: 'admin', status: 'active' },
      source: 'pat',
      patScopes: ['tasks:delete', 'tasks:read:all'],
    })
    expect(actor.permissions.has('tasks:delete')).toBe(true)
  })

  test('a user PAT listing tasks:delete never widens (not in role baseline)', () => {
    const actor = buildActor({
      user: { id: 'u', username: 'u', displayName: 'U', role: 'user', status: 'active' },
      source: 'pat',
      patScopes: ['tasks:delete'],
    })
    expect(actor.permissions.has('tasks:delete')).toBe(false)
  })
})

describe('RFC-222 — last-admin protection does not count manager', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('demoting the only admin to manager is rejected (no admin left)', async () => {
    const admin = await createUser(db, {
      username: 'solo',
      displayName: 'Solo',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    await createUser(db, {
      username: 'mgr',
      displayName: 'Mgr',
      role: 'manager',
      password: 'longEnoughPassword',
    })
    // If manager counted as an admin this demotion would succeed; it must not.
    await expect(patchUser(db, admin.id, { role: 'manager' })).rejects.toBeInstanceOf(
      ValidationError,
    )
    // A second real admin lifts the protection — demotion then succeeds.
    await createUser(db, {
      username: 'root2',
      displayName: 'Root2',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const demoted = await patchUser(db, admin.id, { role: 'manager' })
    expect(demoted.role).toBe('manager')
  })
})
