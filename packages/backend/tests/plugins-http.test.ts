// RFC-031 T5 — /api/plugins HTTP route contract.
//
// Locks status codes (201 / 200 / 204 / 404 / 409 / 422), shape of error
// bodies (referencedBy on still-referenced delete; stderr on install-failed)
// and auth (401 without token). Uses the fake-npm shim so install paths stay
// hermetic; the live `npm` binary is never invoked from these tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { plugins } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { createPlugin } from '../src/services/plugin'
import { createApp } from '../src/server'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.sh')
const TOKEN = 'rfc031-token-fixture'

let pluginsDir = ''
let fakeNpmPathDir = ''
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

async function pluginRevision(app: Hono, path: string): Promise<string> {
  const response = await req(app, path)
  expect(response.status).toBe(200)
  return ((await response.json()) as { operationConfigHash: string }).operationConfigHash
}

function seedPluginRow(db: DbClient, name: string, spec: string): string {
  // CRUD route tests do not exercise installation. Seed the published row
  // directly so their beforeEach cannot inherit fake-npm process latency; the
  // dedicated install-path block below owns all subprocess coverage.
  const id = ulid()
  const now = Date.now()
  db.insert(plugins)
    .values({
      id,
      name,
      spec,
      optionsJson: '{}',
      description: '',
      enabled: true,
      sourceKind: 'npm',
      cachedPath: join(pluginsDir, id, 'node_modules', name),
      resolvedVersion: '1.0.0',
      installedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return id
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-http-'))
  // Install dir under AGENT_WORKFLOW_HOME so the route layer (no installer
  // override available) resolves to it.
  process.env.AGENT_WORKFLOW_HOME = pluginsDir
  // Prepend a PATH-shadow dir containing a private fake npm copy so the
  // installer's PATH lookup picks up the shim instead of the host npm. Avoid
  // a symlink here: Bun's test runner can intermittently hang while spawning
  // an executable script through a temporary symlink on macOS.
  fakeNpmPathDir = await mkdtemp(join(tmpdir(), 'rfc031-path-'))
  const fakeNpmPath = join(fakeNpmPathDir, 'npm')
  await copyFile(FAKE_NPM, fakeNpmPath)
  await chmod(fakeNpmPath, 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${fakeNpmPathDir}:${process.env.PATH ?? ''}`
  resetNpmProbeCacheForTests()
  process.env.FAKE_NPM_MODE = 'success'
})

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
  await rm(fakeNpmPathDir, { recursive: true, force: true }).catch(() => undefined)
  if (originalPath !== undefined) process.env.PATH = originalPath
  delete process.env.FAKE_NPM_MODE
  delete process.env.FAKE_NPM_VERSION
  delete process.env.FAKE_NPM_COUNTER_FILE
  delete process.env.FAKE_NPM_PAUSE_STARTED
  delete process.env.FAKE_NPM_PAUSE_RELEASE
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
// CRUD path (DB-seeded so it does not depend on PATH lookups)
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/plugins CRUD (DB-seeded)', () => {
  let db: DbClient
  let app: Hono
  let seededId: string

  beforeEach(() => {
    ;({ db, app } = buildHarness())
    seededId = seedPluginRow(db, 'seeded', 'pkg@1')
  })

  test('GET /api/plugins lists seeded rows', async () => {
    const r = await req(app, '/api/plugins')
    expect(r.status).toBe(200)
    const body = (await r.json()) as Array<{ name: string }>
    expect(body.map((b) => b.name)).toContain('seeded')
  })

  test('GET /api/plugins/:id returns one', async () => {
    const r = await req(app, `/api/plugins/${seededId}`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { name: string; spec: string }
    expect(body.name).toBe('seeded')
    expect(body.spec).toBe('pkg@1')
  })

  test('GET /api/plugins/:id 404 when missing', async () => {
    const r = await req(app, '/api/plugins/no-such')
    expect(r.status).toBe(404)
    const body = (await r.json()) as { code: string }
    expect(body.code).toBe('plugin-not-found')
  })

  test('legacy mutable-name URLs cannot read, mutate, delete, rename, or address ACL', async () => {
    const requests: Array<[string, RequestInit | undefined]> = [
      ['/api/plugins/seeded', undefined],
      [
        '/api/plugins/seeded',
        {
          method: 'PUT',
          body: JSON.stringify({
            description: 'must-not-land',
            expectedConfigHash: '0'.repeat(64),
          }),
        },
      ],
      [
        '/api/plugins/seeded/rename',
        {
          method: 'POST',
          body: JSON.stringify({
            newName: 'must-not-land',
            expectedConfigHash: '0'.repeat(64),
          }),
        },
      ],
      [
        '/api/plugins/seeded',
        {
          method: 'DELETE',
          body: JSON.stringify({
            confirm: 'seeded',
            expectedConfigHash: '0'.repeat(64),
          }),
        },
      ],
      ['/api/plugins/seeded/acl', undefined],
      [
        '/api/plugins/seeded/acl',
        {
          method: 'PUT',
          body: JSON.stringify({
            visibility: 'private',
            expectedResourceId: seededId,
            expectedAclRevision: 0,
          }),
        },
      ],
    ]

    for (const [path, init] of requests) {
      const response = await req(app, path, init)
      expect(response.status, `${init?.method ?? 'GET'} ${path}`).toBe(404)
      expect(((await response.json()) as { code: string }).code).toBe('plugin-not-found')
    }

    const canonical = await req(app, `/api/plugins/${seededId}`)
    expect(canonical.status).toBe(200)
    expect(await canonical.json()).toMatchObject({
      id: seededId,
      name: 'seeded',
      description: '',
      visibility: 'public',
    })
  })

  test('PUT /api/plugins/:id updates non-spec fields without re-install', async () => {
    const expectedConfigHash = await pluginRevision(app, `/api/plugins/${seededId}`)
    const r = await req(app, `/api/plugins/${seededId}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: false, description: 'paused', expectedConfigHash }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { enabled: boolean; description: string }
    expect(body.enabled).toBe(false)
    expect(body.description).toBe('paused')
  })

  test('ACL owner transfer invalidates a captured config-hash fence', async () => {
    const expectedConfigHash = await pluginRevision(app, `/api/plugins/${seededId}`)
    db.update(plugins)
      .set({ ownerUserId: 'other-owner', aclRevision: 1 })
      .where(eq(plugins.id, seededId))
      .run()

    const stale = await req(app, `/api/plugins/${seededId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'must not publish', expectedConfigHash }),
    })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { code: string }).code).toBe('resource-operation-stale')

    const current = (await (await req(app, `/api/plugins/${seededId}`)).json()) as {
      description: string
    }
    expect(current.description).toBe('')
  })

  test('PUT /api/plugins/:id 422 on invalid body (zod strict)', async () => {
    const r = await req(app, `/api/plugins/${seededId}`, {
      method: 'PUT',
      body: JSON.stringify({ totally_unknown_field: true }),
    })
    expect(r.status).toBe(422)
    const body = (await r.json()) as { code: string }
    expect(body.code).toBe('plugin-invalid')
  })

  test('POST /api/plugins/:id/rename succeeds + 409 on name conflict', async () => {
    // Seed a second plugin so we can attempt to collide.
    seedPluginRow(db, 'other', 'o@1')
    const expectedConfigHash = await pluginRevision(app, `/api/plugins/${seededId}`)
    const r1 = await req(app, `/api/plugins/${seededId}/rename`, {
      method: 'POST',
      body: JSON.stringify({ newName: 'fresh', expectedConfigHash }),
    })
    expect(r1.status).toBe(200)
    const renamed = (await r1.json()) as { name: string; operationConfigHash: string }
    expect(renamed.name).toBe('fresh')

    const r2 = await req(app, `/api/plugins/${seededId}/rename`, {
      method: 'POST',
      body: JSON.stringify({
        newName: 'other',
        expectedConfigHash: renamed.operationConfigHash,
      }),
    })
    expect(r2.status).toBe(409)
    const body = (await r2.json()) as { code: string }
    expect(body.code).toBe('plugin-name-in-use')
  })

  test('DELETE 409 with principal-aware visible list when an agent depends on it', async () => {
    await createAgent(db, {
      name: 'consumer',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [seededId],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const expectedConfigHash = await pluginRevision(app, `/api/plugins/${seededId}`)
    // RFC-222 (D5, N-5): confirm passes first, then the in-use refusal fires.
    const r = await req(app, `/api/plugins/${seededId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'seeded', expectedConfigHash }),
    })
    expect(r.status).toBe(409)
    // RFC-203 T6: principal-aware shape (visible[] + hiddenCount).
    const body = (await r.json()) as {
      code: string
      details: { visible: Array<{ name: string }>; hiddenCount: number }
    }
    expect(body.code).toBe('plugin-still-referenced')
    expect(body.details.visible.map((r) => r.name)).toContain('consumer')
    expect(body.details.hiddenCount).toBe(0)
  })

  test('DELETE 204 when not referenced', async () => {
    const expectedConfigHash = await pluginRevision(app, `/api/plugins/${seededId}`)
    // RFC-222 (D5): DELETE requires a { confirm } body echoing the plugin name.
    const r = await req(app, `/api/plugins/${seededId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'seeded', expectedConfigHash }),
    })
    expect(r.status).toBe(204)
    const r2 = await req(app, `/api/plugins/${seededId}`)
    expect(r2.status).toBe(404)
  })

  test('DELETE requires the mutation config-hash fence', async () => {
    const r = await req(app, `/api/plugins/${seededId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'seeded' }),
    })
    expect(r.status).toBe(422)
    expect(((await r.json()) as { code: string }).code).toBe('plugin-delete-invalid')
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
    const created = (await create.json()) as { id: string; operationConfigHash: string }
    const r = await req(app, `/api/plugins/${created.id}/check-update`, {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash: created.operationConfigHash }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      available: boolean
      current: string
      latest: string
      configHashUsed: string
    }
    expect(body.current).toBe('1.0.0')
    expect(body.latest).toBe('2.0.0')
    expect(body.available).toBe(true)
    expect(body.configHashUsed).toBe(created.operationConfigHash)
  })

  test('stale Check/Upgrade hash returns stable 409 and performs zero npm I/O', async () => {
    const { app } = buildHarness()
    const create = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'stale-check', spec: 'pkg@1' }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { id: string }
    const counter = join(pluginsDir, 'npm-counter.log')
    process.env.FAKE_NPM_COUNTER_FILE = counter
    for (const operation of ['check-update', 'upgrade']) {
      await writeFile(counter, '')
      const response = await req(app, `/api/plugins/${created.id}/${operation}`, {
        method: 'POST',
        body: JSON.stringify({ expectedConfigHash: '0'.repeat(64) }),
      })
      expect(response.status).toBe(409)
      expect(((await response.json()) as { code: string }).code).toBe('resource-operation-stale')
      expect(await readFile(counter, 'utf-8')).toBe('')
    }
    delete process.env.FAKE_NPM_COUNTER_FILE
  })

  test('same id+hash concurrent Check callers join one complete operation', async () => {
    const { app } = buildHarness()
    const create = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'joined-check', spec: 'pkg@1' }),
    })
    const created = (await create.json()) as { id: string; operationConfigHash: string }
    const counter = join(pluginsDir, 'npm-counter.log')
    await writeFile(counter, '')
    process.env.FAKE_NPM_COUNTER_FILE = counter
    const init = {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash: created.operationConfigHash }),
    }
    const [a, b] = await Promise.all([
      req(app, `/api/plugins/${created.id}/check-update`, init),
      req(app, `/api/plugins/${created.id}/check-update`, init),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect((await readFile(counter, 'utf-8')).trim().split('\n')).toHaveLength(1)
    delete process.env.FAKE_NPM_COUNTER_FILE
  })

  test('file source fails closed for Check and Upgrade', async () => {
    const { db, app } = buildHarness()
    const external = await mkdtemp(join(pluginsDir, 'external-'))
    const plugin = await createPlugin(
      db,
      { name: 'external', spec: external },
      { pluginsDir, npmBin: FAKE_NPM },
    )
    const detail = await req(app, `/api/plugins/${plugin.id}`)
    const wire = (await detail.json()) as { operationConfigHash: string }
    for (const suffix of ['check-update', 'upgrade']) {
      const response = await req(app, `/api/plugins/${plugin.id}/${suffix}`, {
        method: 'POST',
        body: JSON.stringify({ expectedConfigHash: wire.operationConfigHash }),
      })
      expect(response.status).toBe(422)
      expect(((await response.json()) as { code: string }).code).toBe(
        'plugin-operation-unsupported',
      )
    }
  })

  test('POST /api/plugins/:id/upgrade re-installs + updates installedAt', async () => {
    const { app } = buildHarness()
    process.env.FAKE_NPM_VERSION = '1.0.0'
    const create = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'upgr', spec: 'pkg@1.0.0' }),
    })
    const created = (await create.json()) as {
      id: string
      installedAt: number
      resolvedVersion: string
      operationConfigHash: string
    }
    process.env.FAKE_NPM_VERSION = '1.5.0'
    // Allow some clock advance so installedAt strictly increases.
    await new Promise((r) => setTimeout(r, 10))
    const r = await req(app, `/api/plugins/${created.id}/upgrade`, {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash: created.operationConfigHash }),
    })
    expect(r.status).toBe(200)
    const receipt = (await r.json()) as {
      configHashUsed: string
      resource: { installedAt: number; resolvedVersion: string; operationConfigHash: string }
    }
    expect(receipt.configHashUsed).toBe(created.operationConfigHash)
    expect(receipt.resource.resolvedVersion).toBe('1.5.0')
    expect(receipt.resource.installedAt).toBeGreaterThanOrEqual(created.installedAt)
    expect(receipt.resource.operationConfigHash).not.toBe(created.operationConfigHash)
  })

  test('PUT waits behind an in-flight Upgrade and publishes from the upgraded row', async () => {
    const { app } = buildHarness()
    process.env.FAKE_NPM_VERSION = '1.0.0'
    const create = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'serialized-upgrade', spec: 'pkg@1.0.0' }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { id: string; operationConfigHash: string }

    const pauseStarted = join(pluginsDir, 'upgrade-started')
    const pauseRelease = join(pluginsDir, 'upgrade-release')
    process.env.FAKE_NPM_MODE = 'pause'
    process.env.FAKE_NPM_VERSION = '2.0.0'
    process.env.FAKE_NPM_PAUSE_STARTED = pauseStarted
    process.env.FAKE_NPM_PAUSE_RELEASE = pauseRelease

    const upgradePromise = req(app, `/api/plugins/${created.id}/upgrade`, {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash: created.operationConfigHash }),
    })

    let updateSettled = false
    let updatePromise: Promise<Response> | undefined
    let settledBeforeRelease = false
    try {
      await waitForFile(pauseStarted)
      updatePromise = req(app, `/api/plugins/${created.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          description: 'edited while upgrade was running',
          expectedConfigHash: created.operationConfigHash,
        }),
      }).finally(() => {
        updateSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      settledBeforeRelease = updateSettled
    } finally {
      await writeFile(pauseRelease, '')
    }

    expect(updatePromise).toBeDefined()
    const [upgrade, update] = await Promise.all([upgradePromise, updatePromise!])
    expect(settledBeforeRelease).toBe(false)
    expect(upgrade.status).toBe(200)
    expect(update.status).toBe(409)
    expect(((await update.json()) as { code: string }).code).toBe('resource-operation-stale')

    const upgradeReceipt = (await upgrade.json()) as {
      resource: { operationConfigHash: string; resolvedVersion: string }
    }
    const retry = await req(app, `/api/plugins/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        description: 'edited while upgrade was running',
        expectedConfigHash: upgradeReceipt.resource.operationConfigHash,
      }),
    })
    expect(retry.status).toBe(200)
    const updated = (await retry.json()) as {
      description: string
      operationConfigHash: string
      resolvedVersion: string
    }
    expect(upgradeReceipt.resource.resolvedVersion).toBe('2.0.0')
    expect(updated.resolvedVersion).toBe('2.0.0')
    expect(updated.description).toBe('edited while upgrade was running')
    expect(updated.operationConfigHash).not.toBe(upgradeReceipt.resource.operationConfigHash)

    const final = await req(app, `/api/plugins/${created.id}`)
    expect(final.status).toBe(200)
    expect(await final.json()).toMatchObject(updated)
  })

  test('ACL mutation waits behind Upgrade and advances the exact resource hash', async () => {
    const { app } = buildHarness()
    process.env.FAKE_NPM_VERSION = '1.0.0'
    const create = await req(app, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'serialized-acl', spec: 'pkg@1.0.0' }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { id: string; operationConfigHash: string }
    const aclBefore = await req(app, `/api/plugins/${created.id}/acl`)
    expect(aclBefore.status).toBe(200)
    const aclSnapshot = (await aclBefore.json()) as { resourceId: string; aclRevision: number }

    const pauseStarted = join(pluginsDir, 'acl-upgrade-started')
    const pauseRelease = join(pluginsDir, 'acl-upgrade-release')
    process.env.FAKE_NPM_MODE = 'pause'
    process.env.FAKE_NPM_VERSION = '2.0.0'
    process.env.FAKE_NPM_PAUSE_STARTED = pauseStarted
    process.env.FAKE_NPM_PAUSE_RELEASE = pauseRelease

    const upgradePromise = req(app, `/api/plugins/${created.id}/upgrade`, {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash: created.operationConfigHash }),
    })

    let aclSettled = false
    let aclPromise: Promise<Response> | undefined
    let settledBeforeRelease = false
    try {
      await waitForFile(pauseStarted)
      aclPromise = req(app, `/api/plugins/${created.id}/acl`, {
        method: 'PUT',
        body: JSON.stringify({
          visibility: 'private',
          expectedResourceId: aclSnapshot.resourceId,
          expectedAclRevision: aclSnapshot.aclRevision,
        }),
      }).finally(() => {
        aclSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      settledBeforeRelease = aclSettled
    } finally {
      await writeFile(pauseRelease, '')
    }

    expect(aclPromise).toBeDefined()
    const [upgrade, aclUpdate] = await Promise.all([upgradePromise, aclPromise!])
    expect(settledBeforeRelease).toBe(false)
    expect(upgrade.status).toBe(200)
    expect(aclUpdate.status).toBe(200)

    const upgradeReceipt = (await upgrade.json()) as {
      resource: { operationConfigHash: string }
    }
    expect(await aclUpdate.json()).toMatchObject({
      resourceId: aclSnapshot.resourceId,
      visibility: 'private',
      aclRevision: aclSnapshot.aclRevision + 1,
    })
    const final = await req(app, `/api/plugins/${created.id}`)
    const finalResource = (await final.json()) as {
      visibility: string
      operationConfigHash: string
    }
    expect(finalResource.visibility).toBe('private')
    expect(finalResource.operationConfigHash).not.toBe(upgradeReceipt.resource.operationConfigHash)
  })
})
