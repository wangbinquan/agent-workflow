// RFC-031 T5 — /api/plugins HTTP route contract.
//
// Locks status codes (201 / 200 / 204 / 404 / 409 / 422), shape of error
// bodies (referencedBy on still-referenced delete; stderr on install-failed)
// and auth (401 without token). Uses the fake-npm shim so install paths stay
// hermetic; the live `npm` binary is never invoked from these tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { createInMemoryDb, type DbClient } from '../src/db/client'
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
  // Prepend a PATH-shadow dir that aliases `npm` → fake-npm.sh so the
  // installer's PATH lookup picks up the shim instead of the host npm.
  fakeNpmPathDir = await mkdtemp(join(tmpdir(), 'rfc031-path-'))
  await symlink(FAKE_NPM, join(fakeNpmPathDir, 'npm'))
  await chmod(FAKE_NPM, 0o755).catch(() => undefined)
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
// CRUD path (uses service layer directly so we don't depend on PATH lookups)
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/plugins CRUD (service-seeded)', () => {
  let db: DbClient
  let app: Hono

  beforeEach(async () => {
    ;({ db, app } = buildHarness())
    // Seed via service layer so we don't need the http POST install path here.
    await createPlugin(db, { name: 'seeded', spec: 'pkg@1' }, { pluginsDir, npmBin: FAKE_NPM })
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
    await createPlugin(db, { name: 'other', spec: 'o@1' }, { pluginsDir, npmBin: FAKE_NPM })
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
    const created = (await create.json()) as { operationConfigHash: string }
    const r = await req(app, '/api/plugins/upcheck/check-update', {
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
    const counter = join(pluginsDir, 'npm-counter.log')
    process.env.FAKE_NPM_COUNTER_FILE = counter
    for (const operation of ['check-update', 'upgrade']) {
      await writeFile(counter, '')
      const response = await req(app, `/api/plugins/stale-check/${operation}`, {
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
    const created = (await create.json()) as { operationConfigHash: string }
    const counter = join(pluginsDir, 'npm-counter.log')
    await writeFile(counter, '')
    process.env.FAKE_NPM_COUNTER_FILE = counter
    const init = {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash: created.operationConfigHash }),
    }
    const [a, b] = await Promise.all([
      req(app, '/api/plugins/joined-check/check-update', init),
      req(app, '/api/plugins/joined-check/check-update', init),
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
      installedAt: number
      resolvedVersion: string
      operationConfigHash: string
    }
    process.env.FAKE_NPM_VERSION = '1.5.0'
    // Allow some clock advance so installedAt strictly increases.
    await new Promise((r) => setTimeout(r, 10))
    const r = await req(app, '/api/plugins/upgr/upgrade', {
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
    const created = (await create.json()) as { operationConfigHash: string }

    const pauseStarted = join(pluginsDir, 'upgrade-started')
    const pauseRelease = join(pluginsDir, 'upgrade-release')
    process.env.FAKE_NPM_MODE = 'pause'
    process.env.FAKE_NPM_VERSION = '2.0.0'
    process.env.FAKE_NPM_PAUSE_STARTED = pauseStarted
    process.env.FAKE_NPM_PAUSE_RELEASE = pauseRelease

    const upgradePromise = req(app, '/api/plugins/serialized-upgrade/upgrade', {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash: created.operationConfigHash }),
    })

    let updateSettled = false
    let updatePromise: Promise<Response> | undefined
    let settledBeforeRelease = false
    try {
      await waitForFile(pauseStarted)
      updatePromise = req(app, '/api/plugins/serialized-upgrade', {
        method: 'PUT',
        body: JSON.stringify({ description: 'edited while upgrade was running' }),
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
    expect(update.status).toBe(200)

    const upgradeReceipt = (await upgrade.json()) as {
      resource: { operationConfigHash: string; resolvedVersion: string }
    }
    const updated = (await update.json()) as {
      description: string
      operationConfigHash: string
      resolvedVersion: string
    }
    expect(upgradeReceipt.resource.resolvedVersion).toBe('2.0.0')
    expect(updated.resolvedVersion).toBe('2.0.0')
    expect(updated.description).toBe('edited while upgrade was running')
    expect(updated.operationConfigHash).not.toBe(upgradeReceipt.resource.operationConfigHash)

    const final = await req(app, '/api/plugins/serialized-upgrade')
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
    const created = (await create.json()) as { operationConfigHash: string }
    const aclBefore = await req(app, '/api/plugins/serialized-acl/acl')
    expect(aclBefore.status).toBe(200)
    const aclSnapshot = (await aclBefore.json()) as { resourceId: string; aclRevision: number }

    const pauseStarted = join(pluginsDir, 'acl-upgrade-started')
    const pauseRelease = join(pluginsDir, 'acl-upgrade-release')
    process.env.FAKE_NPM_MODE = 'pause'
    process.env.FAKE_NPM_VERSION = '2.0.0'
    process.env.FAKE_NPM_PAUSE_STARTED = pauseStarted
    process.env.FAKE_NPM_PAUSE_RELEASE = pauseRelease

    const upgradePromise = req(app, '/api/plugins/serialized-acl/upgrade', {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash: created.operationConfigHash }),
    })

    let aclSettled = false
    let aclPromise: Promise<Response> | undefined
    let settledBeforeRelease = false
    try {
      await waitForFile(pauseStarted)
      aclPromise = req(app, '/api/plugins/serialized-acl/acl', {
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
    const final = await req(app, '/api/plugins/serialized-acl')
    const finalResource = (await final.json()) as {
      visibility: string
      operationConfigHash: string
    }
    expect(finalResource.visibility).toBe('private')
    expect(finalResource.operationConfigHash).not.toBe(upgradeReceipt.resource.operationConfigHash)
  })
})
