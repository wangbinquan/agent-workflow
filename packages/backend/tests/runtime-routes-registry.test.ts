// RFC-112 PR-B — runtime registry HTTP routes: GET open to any authed user;
// all writes + /probe admin-only (D3). Built-in read-only + in-use delete guards
// surface as 403 / 409. The deep-smoke /probe is exercised once with a mock
// binary (full smoke coverage lives in runtime-smoke.test.ts); CRUD cases use
// probe:false to stay fast and not spawn.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { loadConfig } from '../src/config'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { createRuntime, seedBuiltinRuntimes } from '../src/services/runtimeRegistry'
import { agents } from '../src/db/schema'
import { ulid } from 'ulid'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
// opencode protocol has NO credential bridge, so the route /probe test (which
// passes bridgeCredentials:true for production-fidelity) never touches a keychain.
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  app: Hono
  tmp: string
  userToken: string
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rt-reg-'))
  const configPath = join(tmp, 'config.json')
  loadConfig(configPath)
  const db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(db)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const bob = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: bob.id })
  return { db, app, tmp, userToken: token }
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

function wrapperFor(mockFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rt-bin-'))
  const wrapper = join(dir, 'runtime-bin')
  writeFileSync(wrapper, `#!/bin/sh\nexec bun run ${mockFile} "$@"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}

describe('runtime registry routes (RFC-112 PR-B)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => rmSync(h.tmp, { recursive: true, force: true }))

  test('GET /api/runtimes lists the seeded runtimes (open to any user)', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/runtimes')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { runtimes: Array<{ name: string }> }
    const names = json.runtimes.map((r) => r.name).sort()
    expect(names).toEqual(['claude-code', 'opencode'])
    // RFC-153: the built-in flag is gone from the wire shape entirely.
    expect(json.runtimes.some((r) => 'builtin' in r)).toBe(false)
  })

  test('POST /api/runtimes (admin, probe:false) registers a custom runtime → 201', async () => {
    const res = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes', {
      method: 'POST',
      body: JSON.stringify({
        name: 'my-oc',
        protocol: 'opencode',
        binaryPath: '/a/my-oc',
        probe: false,
      }),
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as { runtime: { name: string; protocol: string } }
    expect(json.runtime.name).toBe('my-oc')
    expect(json.runtime.protocol).toBe('opencode')
  })

  test('POST /api/runtimes is admin-only → 403 for a regular user', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/runtimes', {
      method: 'POST',
      body: JSON.stringify({ name: 'sneaky', protocol: 'opencode', probe: false }),
    })
    expect(res.status).toBe(403)
  })

  test('POST /api/runtimes with an existing preseeded name → 409 runtime-exists (not reserved)', async () => {
    // RFC-153: opencode is no longer a reserved name — it collides only because the
    // preseeded row already exists (name uniqueness), which reads as runtime-exists.
    const res = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes', {
      method: 'POST',
      body: JSON.stringify({ name: 'opencode', protocol: 'opencode', probe: false }),
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('runtime-exists')
  })

  test('PUT /api/runtimes/:name updates a custom binary; built-in PUT now ALLOWED (RFC-113 D8)', async () => {
    await createRuntime(h.db, { name: 'my-oc', protocol: 'opencode', binaryPath: '/a' })
    const ok = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/my-oc', {
      method: 'PUT',
      body: JSON.stringify({ binaryPath: '/b', model: 'opus' }),
    })
    expect(ok.status).toBe(200)
    const okJson = (await ok.json()) as { runtime: { binaryPath: string; model: string } }
    expect(okJson.runtime.binaryPath).toBe('/b')
    expect(okJson.runtime.model).toBe('opus')

    // RFC-113: built-in binary/model IS editable (config面). Only identity/delete locked.
    const builtin = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/opencode', {
      method: 'PUT',
      body: JSON.stringify({ binaryPath: '/x', model: 'sonnet' }),
    })
    expect(builtin.status).toBe(200)
    expect(((await builtin.json()) as { runtime: { model: string } }).runtime.model).toBe('sonnet')
  })

  test('DELETE custom ok; preseeded claude-code ok (RFC-153); in-use → 409', async () => {
    await createRuntime(h.db, { name: 'my-oc', protocol: 'opencode' })
    const del = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/my-oc', { method: 'DELETE' })
    expect(del.status).toBe(200)

    // RFC-153: claude-code is an ordinary row now — deletable (not the effective
    // default, not referenced). The default opencode stays protected (F1).
    const preseeded = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/claude-code', {
      method: 'DELETE',
    })
    expect(preseeded.status).toBe(200)

    await createRuntime(h.db, { name: 'used-rt', protocol: 'opencode' })
    await h.db.insert(agents).values({ id: ulid(), name: 'auditor', runtime: 'used-rt' })
    const inUse = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/used-rt', { method: 'DELETE' })
    expect(inUse.status).toBe(409)
    expect(((await inUse.json()) as { code: string }).code).toBe('runtime-in-use')
  })

  // RFC-118: enable/disable toggle.
  test('POST /:name/enabled: disable non-default built-in ok; default → 409; user → 403', async () => {
    // disable a non-default built-in (claude-code) → 200, enabled=false
    const dis = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/claude-code/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    })
    expect(dis.status).toBe(200)
    expect(((await dis.json()) as { runtime: { enabled: boolean } }).runtime.enabled).toBe(false)

    // disabling the effective default (opencode) → 409
    const def = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/opencode/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    })
    expect(def.status).toBe(409)
    expect(((await def.json()) as { code: string }).code).toBe('runtime-default-cannot-disable')

    // admin-only → 403 for a regular user
    const forbidden = await reqAs(h.app, h.userToken, '/api/runtimes/claude-code/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    expect(forbidden.status).toBe(403)
  })

  test('POST /api/runtimes/probe deep-smokes a mock binary → conforms', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    process.env.MOCK_OPENCODE_EMIT_SESSION_ID = '1'
    try {
      const res = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/probe', {
        method: 'POST',
        body: JSON.stringify({ protocol: 'opencode', binaryPath: wrapperFor(MOCK_OPENCODE) }),
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { smoke: { outcome: string; conforms: boolean } }
      expect(json.smoke.outcome).toBe('conforms')
      expect(json.smoke.conforms).toBe(true)
    } finally {
      delete process.env.MOCK_OPENCODE_ECHO_PROMPT
      delete process.env.MOCK_OPENCODE_EMIT_SESSION_ID
    }
  }, 30_000)
})
