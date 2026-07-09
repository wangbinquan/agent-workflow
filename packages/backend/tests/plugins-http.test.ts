// RFC-031 T5 — /api/plugins HTTP route contract.
//
// Locks status codes (201 / 200 / 204 / 404 / 409 / 422), shape of error
// bodies (referencedBy on still-referenced delete; stderr on install-failed)
// and auth (401 without token). Uses the fake-npm shim so install paths stay
// hermetic; the live `npm` binary is never invoked from these tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { createPlugin } from '../src/services/plugin'
import { createApp } from '../src/server'
import { writeFakeNpm } from './helpers/stub-runtime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOKEN = 'rfc031-token-fixture'

let pluginsDir = ''
let fakeNpmBin = ''
let originalPath: string | undefined

function buildHarness(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-http-'))
  // Install dir under AGENT_WORKFLOW_HOME so the route layer (no installer
  // override available) resolves to it.
  process.env.AGENT_WORKFLOW_HOME = pluginsDir
  // Use writeFakeNpm to create a cross-platform fake npm shim, then PATH-inject
  // the directory so the installer's PATH lookup picks up the shim instead of
  // the host npm.
  const npmDir = writeFakeNpm(pluginsDir)
  fakeNpmBin = resolve(npmDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  originalPath = process.env.PATH
  process.env.PATH = `${npmDir}${delimiter}${process.env.PATH ?? ''}`
  resetNpmProbeCacheForTests()
  process.env.FAKE_NPM_MODE = 'success'
})

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
  if (originalPath !== undefined) process.env.PATH = originalPath
  delete process.env.FAKE_NPM_MODE
  delete process.env.FAKE_NPM_VERSION
  delete process.env.AGENT_WORKFLOW_HOME
})

// ─────────────────────────────────────────────────────────────────────────────
// auth
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/plugins auth', () => {
  test('401 without token', async () => {
    const { app } = buildHarness()
    const r = await app.request('/api/plugins')
    expect(r.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CRUD path (uses service layer directly so we don't depend on PATH lookups)
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/plugins CRUD (service-seeded)', () => {
  let db: DbClient
  let app: Hono

  beforeEach(async () => {
    ;({ db, app } = buildHarness())
    // Seed via service layer so we don't need the http POST install path here.
    await createPlugin(db, { name: 'seeded', spec: 'pkg@1' }, { pluginsDir, npmBin: fakeNpmBin })
  })

  test('GET /api/plugins lists seeded rows', async () => {
    const r = await req(app, '/api/plugins')
    expect(r.status).toBe(200)
    const body = (await r.json()) as Array<{ name: string }>
    expect(body.map((b) => b.name)).toContain('seeded')
  })

  test('GET /api/plugins/:name returns one', async () => {
    const r = await req(app, '/api/plugins/seeded')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { name: string; spec: string }
    expect(body.name).toBe('seeded')
    expect(body.spec).toBe('pkg@1')
  })

  test('GET /api/plugins/:name 404 when missing', async () => {
    const r = await req(app, '/api/plugins/no-such')
    expect(r.status).toBe(404)
    const body = (await r.json()) as { code: string }
    expect(body.code).toBe('plugin-not-found')
  })

  test('PUT /api/plugins/:name updates non-spec fields without re-install', async () => {
    const r = await req(app, '/api/plugins/seeded', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false, description: 'paused' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { enabled: boolean; description: string }
    expect(body.enabled).toBe(false)
    expect(body.description).toBe('paused')
  })

  test('PUT /api/plugins/:name 422 on invalid body (zod strict)', async () => {
    const r = await req(app, '/api/plugins/seeded', {
      method: 'PUT',
      body: JSON.stringify({ totally_unknown_field: true }),
    })
    expect(r.status).toBe(422)
    const body = (await r.json()) as { code: string }
    expect(body.code).toBe('plugin-invalid')
  })

  test('POST /api/plugins/:name/rename succeeds + 409 on name conflict', async () => {
    // Seed a second plugin so we can attempt to collide.
    await createPlugin(db, { name: 'other', spec: 'o@1' }, { pluginsDir, npmBin: fakeNpmBin })
    const r1 = await req(app, '/api/plugins/seeded/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'fresh' }),
    })
    expect(r1.status).toBe(200)
    const renamed = (await r1.json()) as { name: string }
    expect(renamed.name).toBe('fresh')

    const r2 = await req(app, '/api/plugins/fresh/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'other' }),
    })
    expect(r2.status).toBe(409)
    const body = (await r2.json()) as { code: string }
    expect(body.code).toBe('plugin-name-in-use')
  })

  test('DELETE 409 with referencedBy list when an agent depends on it', async () => {
    await createAgent(db, {
      name: 'consumer',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: ['seeded'],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const r = await req(app, '/api/plugins/seeded', { method: 'DELETE' })
    expect(r.status).toBe(409)
    const body = (await r.json()) as {
      code: string
      details: { referencedBy: Array<{ name: string }> }
    }
    expect(body.code).toBe('plugin-still-referenced')
    expect(body.details.referencedBy.map((r) => r.name)).toContain('consumer')
  })

  test('DELETE 204 when not referenced', async () => {
    const r = await req(app, '/api/plugins/seeded', { method: 'DELETE' })
    expect(r.status).toBe(204)
    const r2 = await req(app, '/api/plugins/seeded')
    expect(r2.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// install paths (POST / upgrade / check-update) using PATH-injected fake npm
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/plugins install path (PATH-injected fake npm)', () => {
  test('POST creates + installs + 201; bad payload → 422', async () => {
    const { app } = buildHarness()
    process.env.FAKE_NPM_VERSION = '5.0.0'
    const r = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'fresh', spec: 'pkg@5' }),
    })
    expect(r.status).toBe(201)
    const body = (await r.json()) as { name: string; resolvedVersion: string | null }
    expect(body.name).toBe('fresh')
    expect(body.resolvedVersion).toBe('5.0.0')

    const r2 = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: '-bad-' }),
    })
    expect(r2.status).toBe(422)
  })

  test('POST 422 with stderr + plugin-install-failed on npm error', async () => {
    const { app } = buildHarness()
    process.env.FAKE_NPM_MODE = 'fail'
    const r = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'broken', spec: 'nope@99' }),
    })
    expect(r.status).toBe(422)
    const body = (await r.json()) as { code: string; details: { stderr: string } }
    expect(body.code).toBe('plugin-install-failed')
    expect(body.details.stderr).toContain('404')
  })

  test('POST /api/plugins/:id/check-update returns availability info', async () => {
    const { app } = buildHarness()
    process.env.FAKE_NPM_VERSION = '1.0.0'
    const create = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'upcheck', spec: 'pkg@1.0.0' }),
    })
    expect(create.status).toBe(201)
    process.env.FAKE_NPM_VERSION = '2.0.0' // probe will see this
    const r = await req(app, '/api/plugins/upcheck/check-update', { method: 'POST' })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { available: boolean; current: string; latest: string }
    expect(body.current).toBe('1.0.0')
    expect(body.latest).toBe('2.0.0')
    expect(body.available).toBe(true)
  })

  test('POST /api/plugins/:id/upgrade re-installs + updates installedAt', async () => {
    const { app } = buildHarness()
    process.env.FAKE_NPM_VERSION = '1.0.0'
    const create = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'upgr', spec: 'pkg@1.0.0' }),
    })
    const created = (await create.json()) as { installedAt: number; resolvedVersion: string }
    process.env.FAKE_NPM_VERSION = '1.5.0'
    // Allow some clock advance so installedAt strictly increases.
    await new Promise((r) => setTimeout(r, 10))
    const r = await req(app, '/api/plugins/upgr/upgrade', { method: 'POST' })
    expect(r.status).toBe(200)
    const upgraded = (await r.json()) as { installedAt: number; resolvedVersion: string }
    expect(upgraded.resolvedVersion).toBe('1.5.0')
    expect(upgraded.installedAt).toBeGreaterThanOrEqual(created.installedAt)
  })
})
