// RFC-099 ACL endpoints — cross-user enforcement for EVERY ACL'd resource type.
//
// WHY THIS EXISTS
// ---------------
// `GET/PUT /api/{resource}/:key/acl` is the write entry point for owner transfer
// and grant editing on six resource types. The 2026-07-21 test-guard audit found
// two compounding problems:
//
//   1. The endpoints are mounted through `mountAclEndpoints` with a COMPUTED
//      path, so the contract registry's route scanner (literal-only) never saw
//      them: all twelve were absent from the registry and had no 401 gate, no
//      shape check, nothing. Fixed in api-contract-coverage.test.ts + registry.
//   2. Behavioural coverage existed for exactly ONE of the six types (agents, in
//      rfc099-resource-routes.test.ts). skills / mcps / plugins / workflows /
//      workgroups had their ACL endpoints exercised only under the daemon token,
//      which resolves to a system admin and therefore short-circuits every check
//      being tested. A dropped `canViewResource` on any of those five would
//      expose private skill bodies, MCP credential shapes, plugin configs and
//      workgroup membership to every logged-in user — with the suite green.
//
// The fix shape follows the audit's prescription: replace per-resource ad-hoc
// tests with ONE table-driven matrix, so a SEVENTH ACL'd resource type is a
// single row here rather than a whole file somebody forgets to write. The table
// is cross-checked against the route sources at the top of the file, so adding
// `mountAclEndpoints` somewhere new fails here until it is enrolled.
//
// Rows are seeded straight into the DB rather than through each type's create
// endpoint: the ACL handlers only ever `load()` a row, and DB seeding keeps this
// file free of per-type creation quirks (skills touching the filesystem, plugins
// needing an install path) that have nothing to do with the boundary under test.
//
// See design/test-guard-audit-2026-07-21 Top-5 (B5-ACL-cluster) / 逃逸机制③.

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps, plugins, skills, workflows, workgroups } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ROUTES_DIR = resolve(import.meta.dir, '..', 'src', 'routes')

interface Harness {
  db: DbClient
  app: Hono
  alice: { id: string; token: string } // owner
  bob: { id: string; token: string } // grantee
  carol: { id: string; token: string } // stranger
  admin: { id: string; token: string }
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc099-matrix-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const mkUser = async (username: string, role: 'admin' | 'user') => {
    const u = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }
  return {
    db,
    app,
    alice: await mkUser('alice', 'user'),
    bob: await mkUser('bob', 'user'),
    carol: await mkUser('carol', 'user'),
    admin: await mkUser('root', 'admin'),
  }
}

async function req(
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

const KEY = 'acl-matrix-subject'

interface ResourceCase {
  type: string
  base: string
  /** Route param: the key used in the URL. */
  keyOf: (seeded: { id: string; name: string }) => string
  missingKey: string
  seed: (db: DbClient, ownerUserId: string) => Promise<{ id: string; name: string }>
}

const now = 1_700_000_000_000

const CASES: ResourceCase[] = [
  {
    type: 'agent',
    base: '/api/agents',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(agents).values({
        ...row,
        description: 'acl matrix subject',
        outputs: JSON.stringify(['answer']),
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    type: 'skill',
    base: '/api/skills',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(skills).values({
        ...row,
        description: 'acl matrix subject',
        sourceKind: 'managed',
        managedPath: `skills/${KEY}/files/`,
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    type: 'mcp',
    base: '/api/mcps',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(mcps).values({
        ...row,
        description: 'acl matrix subject',
        type: 'local',
        config: JSON.stringify({ command: ['echo'] }),
        enabled: true,
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    type: 'plugin',
    base: '/api/plugins',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(plugins).values({
        ...row,
        description: 'acl matrix subject',
        spec: 'fake-plugin@0.0.1',
        optionsJson: '{}',
        sourceKind: 'npm',
        cachedPath: join('/tmp', 'aw-acl-matrix-plugin'),
        resolvedVersion: '0.0.1',
        installedAt: now,
        enabled: true,
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    type: 'workflow',
    base: '/api/workflows',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(workflows).values({
        ...row,
        description: 'acl matrix subject',
        definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
        ownerUserId,
        visibility: 'private',
      })
      return row
    },
  },
  {
    type: 'workgroup',
    base: '/api/workgroups',
    keyOf: (s) => s.id,
    missingKey: ulid(),
    seed: async (db, ownerUserId) => {
      const row = { id: ulid(), name: KEY }
      await db.insert(workgroups).values({
        ...row,
        description: 'acl matrix subject',
        mode: 'free_collab',
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
]

describe('RFC-099 ACL endpoint matrix — enrolment', () => {
  test('every mountAclEndpoints call site is covered by a row in CASES', () => {
    // Without this, a seventh ACL'd resource type would ship with the same
    // silence that left five of the current six untested across users.
    const mounted: string[] = []
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(ROUTES_DIR, file), 'utf8')
      const re =
        /mountAclEndpoints\s*\(\s*app\s*,\s*deps\s*,\s*\{[\s\S]{0,400}?type:\s*['"]([^'"]+)['"]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) mounted.push(m[1]!)
    }
    expect(mounted.sort()).toEqual(CASES.map((c) => c.type).sort())
  })
})

for (const rc of CASES) {
  describe(`RFC-099 ACL endpoints — ${rc.type}`, () => {
    let h: Harness
    let key: string

    beforeEach(async () => {
      h = await buildHarness()
      key = rc.keyOf(await rc.seed(h.db, h.alice.id))
    })

    const aclPath = (k: string): string => `${rc.base}/${k}/acl`

    test('a stranger gets a 404 byte-identical to a non-existent resource (no existence oracle)', async () => {
      const invisible = await req(h.app, h.carol.token, aclPath(key))
      const missing = await req(h.app, h.carol.token, aclPath(rc.missingKey))
      expect(invisible.status).toBe(404)
      expect(missing.status).toBe(404)
      // Identical modulo the echoed key, not merely "both 404". The key itself
      // is attacker-supplied so echoing it reveals nothing; ANY other
      // difference — a distinct `code`, a "you lack access" phrasing, extra
      // fields — is precisely the oracle that tells an attacker which private
      // resources exist. Normalising just the key keeps the assertion strict
      // about everything else.
      const normalise = (text: string, k: string): string => text.split(k).join('<KEY>')
      expect(normalise(await invisible.text(), key)).toBe(
        normalise(await missing.text(), rc.missingKey),
      )
    })

    test('a stranger cannot grant themselves access, and the ACL is unchanged', async () => {
      const attack = await req(h.app, h.carol.token, aclPath(key), {
        method: 'PUT',
        body: JSON.stringify({ userIds: [h.carol.id], visibility: 'public' }),
      })
      expect(attack.status).toBe(404)

      // Asserting the status alone would still pass if the handler wrote first
      // and threw afterwards — re-read as the owner and prove nothing moved.
      const acl = (await (await req(h.app, h.alice.token, aclPath(key))).json()) as {
        ownerUserId: string
        visibility: string
        users: Array<{ id: string }>
      }
      expect(acl.ownerUserId).toBe(h.alice.id)
      expect(acl.visibility).toBe('private')
      expect(acl.users).toEqual([])
      // …and the stranger still cannot see it.
      expect((await req(h.app, h.carol.token, aclPath(key))).status).toBe(404)
    })

    test('owner and admin can read the ACL; owner can grant, grantee can read but not manage', async () => {
      // Positive controls: without these, a handler that refused everyone would
      // satisfy every negative case above and this matrix would have no teeth.
      expect((await req(h.app, h.alice.token, aclPath(key))).status).toBe(200)
      expect((await req(h.app, h.admin.token, aclPath(key))).status).toBe(200)

      const grant = await req(h.app, h.alice.token, aclPath(key), {
        method: 'PUT',
        body: JSON.stringify({ userIds: [h.bob.id] }),
      })
      expect(grant.status).toBe(200)

      const asBob = (await (await req(h.app, h.bob.token, aclPath(key))).json()) as {
        ownerUserId: string
        users: Array<{ id: string }>
        canManage: boolean
      }
      expect(asBob.ownerUserId).toBe(h.alice.id)
      expect(asBob.users.map((u) => u.id)).toEqual([h.bob.id])
      expect(asBob.canManage).toBe(false)

      const bobEscalates = await req(h.app, h.bob.token, aclPath(key), {
        method: 'PUT',
        body: JSON.stringify({ visibility: 'public' }),
      })
      expect(bobEscalates.status).toBe(403)

      // A grant must not make the resource visible to everyone else.
      expect((await req(h.app, h.carol.token, aclPath(key))).status).toBe(404)
    })

    test('granting an unknown or system user is refused with a typed 422', async () => {
      const unknown = await req(h.app, h.alice.token, aclPath(key), {
        method: 'PUT',
        body: JSON.stringify({ userIds: ['01HFAKEUSERID0000000000000'] }),
      })
      expect(unknown.status).toBe(422)
      expect(((await unknown.json()) as { code: string }).code).toBe('acl-user-invalid')

      const system = await req(h.app, h.alice.token, aclPath(key), {
        method: 'PUT',
        body: JSON.stringify({ userIds: ['__system__'] }),
      })
      expect(system.status).toBe(422)
    })
  })
}
