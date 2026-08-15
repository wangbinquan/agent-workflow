// RFC-304 T31b — the `/code` HTTP surface, including every way it says no.
//
// The rejection half is the point. The 2026-07-21 test-guard audit found that
// the most common escape is testing only what SHOULD happen: happy paths get
// written because a feature is not "done" without them, while the 4xx branches
// have no product pressure behind them. So each error code below is named
// explicitly rather than asserted as "some 4xx" — a status-range assertion
// passes no matter which branch fired, which means a guard can be deleted and
// its request answered by an unrelated rejection with the test still green.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  capabilityBindings,
  capabilityFrameworks,
  webhookEndpoints,
} from '../src/db/schema'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

afterEach(() => {
  resetBroadcastersForTests()
})

function buildApp(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

const auth = { authorization: `Bearer ${TOKEN}` }

const seedEndpoint = async (db: DbClient) => {
  await db.insert(webhookEndpoints).values({
    id: 'ep-1',
    name: 'gl',
    provider: 'gitlab',
    urlToken: 'aw_whk_routes',
    secretEnc: 'sealed',
    enabled: true,
  })
}

const seedBinding = async (db: DbClient) => {
  await db.insert(agents).values({
    id: 'agent-1',
    name: 'reviewer-agent',
    bodyMd: 'x',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(capabilityFrameworks).values({
    id: 'fw-1',
    name: 'f',
    capability: 'mr-review',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(capabilityBindings).values({
    id: 'binding-1',
    name: 'b',
    frameworkId: 'fw-1',
    agentBySlotJson: JSON.stringify({ reviewer: 'agent-1' }),
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describe('RFC-304 — reading the capability matrix', () => {
  test('a repository with no cells returns an empty list, not an error', async () => {
    // "Nothing configured" is the state every repository starts in; answering
    // it with a 404 would make the page's first render look broken.
    const { app } = buildApp()
    const res = await app.request('/api/code/matrix/group%2Fproject', { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [] })
  })

  test('without a bearer token it is refused', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/code/matrix/group%2Fproject')
    expect(res.status).toBe(401)
  })
})

describe('RFC-304 — enabling a capability over HTTP', () => {
  test('a capability the platform does not ship is refused BY NAME', async () => {
    const { app, db } = buildApp()
    await seedEndpoint(db)
    const res = await app.request('/api/code/matrix/group%2Fproject', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'mr-invented', enabled: true }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-unknown-capability')
  })

  test('a body missing `enabled` is refused as invalid', async () => {
    const { app, db } = buildApp()
    await seedEndpoint(db)
    const res = await app.request('/api/code/matrix/group%2Fproject', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'mr-review' }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-enable-invalid')
  })

  test('a deployment with no webhook endpoint says WHICH thing to configure', async () => {
    // Not a 500: the platform is fine, this deployment simply has no endpoint
    // yet. A 500 would send somebody to the logs for a configuration gap.
    const { app } = buildApp()
    const res = await app.request('/api/code/matrix/group%2Fproject', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'mr-review', enabled: true }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-endpoint-unresolved')
  })

  test('enabling a real capability returns the row and its readiness', async () => {
    const { app, db } = buildApp()
    await seedEndpoint(db)
    await seedBinding(db)
    const res = await app.request('/api/code/matrix/group%2Fproject', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'mr-review', enabled: true, bindingId: 'binding-1' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { row: { readiness: string; enabled: boolean } }
    expect(body.row.enabled).toBe(true)
    expect(body.row.readiness).toBe('ready')
  })

  test('the saved cell is then visible in the matrix', async () => {
    // The join: writing and reading are two endpoints, and a page that showed a
    // switch flip which then vanished on refresh would be worse than either
    // failing outright.
    const { app, db } = buildApp()
    await seedEndpoint(db)
    await seedBinding(db)
    await app.request('/api/code/matrix/group%2Fproject', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'mr-review', enabled: true, bindingId: 'binding-1' }),
    })
    const res = await app.request('/api/code/matrix/group%2Fproject', { headers: auth })
    const body = (await res.json()) as { rows: Array<{ capability: string }> }
    expect(body.rows.map((r) => r.capability)).toEqual(['mr-review'])
  })
})

describe('RFC-304 — listing work items', () => {
  test('an empty deployment returns an empty page with no cursor', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/code/work-items', { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [], nextCursor: null })
  })

  test('a non-numeric limit is refused by name rather than silently defaulted', async () => {
    // Silently defaulting would answer a page size nobody asked for, and the
    // caller would conclude the parameter is unsupported rather than mistyped.
    const { app } = buildApp()
    const res = await app.request('/api/code/work-items?limit=lots', { headers: auth })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('code-limit-invalid')
  })

  test('without a bearer token it is refused', async () => {
    const { app } = buildApp()
    expect((await app.request('/api/code/work-items')).status).toBe(401)
  })
})
