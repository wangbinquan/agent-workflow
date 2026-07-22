// RFC-028 T4 — /api/mcps HTTP route contract.
// Locks status codes (201 / 200 / 204 / 404 / 409 / 422), shape of error
// bodies (referencedBy on still-referenced delete) and auth (401 without token).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import { createApp } from '../src/server'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOKEN = 'rfc028-token-fixture'

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

function localPayload(name: string): Record<string, unknown> {
  return {
    name,
    description: '',
    type: 'local',
    config: { command: ['uvx', 'pg-mcp'] },
    enabled: true,
  }
}

describe('POST /api/mcps', () => {
  let app: Hono
  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('happy path → 201 + created row', async () => {
    const res = await req(app, '/api/mcps', {
      method: 'POST',
      body: JSON.stringify(localPayload('postgres')),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('postgres')
    expect(body.type).toBe('local')
    expect(typeof body.id).toBe('string')
  })

  test('invalid payload → 422 + issues', async () => {
    const res = await req(app, '/api/mcps', {
      method: 'POST',
      body: JSON.stringify({ name: 'BadName', type: 'local', config: { command: ['x'] } }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.code).toBe('mcp-invalid')
  })

  test('duplicate name → 409 mcp-name-in-use', async () => {
    await req(app, '/api/mcps', {
      method: 'POST',
      body: JSON.stringify(localPayload('dup')),
    })
    const res = await req(app, '/api/mcps', {
      method: 'POST',
      body: JSON.stringify(localPayload('dup')),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('mcp-name-in-use')
  })

  test('no token → 401', async () => {
    // call without the Authorization header
    const res = await app.request('/api/mcps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(localPayload('x')),
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/mcps and /api/mcps/:name', () => {
  let app: Hono
  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('list empty → []', async () => {
    const res = await req(app, '/api/mcps')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test('list returns created rows', async () => {
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('a')) })
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('b')) })
    const res = await req(app, '/api/mcps')
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(body.map((r) => r.name).sort()).toEqual(['a', 'b'])
  })

  test('GET unknown → 404', async () => {
    const res = await req(app, '/api/mcps/nope')
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('mcp-not-found')
  })
})

describe('PUT /api/mcps/:name', () => {
  let app: Hono
  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('happy path patch description', async () => {
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('m')) })
    const res = await req(app, '/api/mcps/m', {
      method: 'PUT',
      body: JSON.stringify({ description: 'updated' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).description).toBe('updated')
  })

  test('PUT type change → 422', async () => {
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('m')) })
    const res = await req(app, '/api/mcps/m', {
      method: 'PUT',
      body: JSON.stringify({ type: 'remote', config: { url: 'https://x.io' } }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('mcp-type-immutable')
  })

  test('PUT unknown → 404', async () => {
    const res = await req(app, '/api/mcps/nope', {
      method: 'PUT',
      body: JSON.stringify({ description: 'x' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/mcps/:name', () => {
  let app: Hono
  let db: DbClient
  beforeEach(() => {
    ;({ app, db } = buildHarness())
  })

  test('happy path → 204', async () => {
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('m')) })
    // RFC-222 (D5): DELETE requires a { confirm } body echoing the mcp name.
    const res = await req(app, '/api/mcps/m', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'm' }),
    })
    expect(res.status).toBe(204)
  })

  test('with references → 409 + principal-aware visible list', async () => {
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('m')) })
    await createAgent(db, {
      name: 'consumer',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['m'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    // RFC-222 (D5, N-5): confirm passes first, then the in-use refusal fires.
    const res = await req(app, '/api/mcps/m', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'm' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('mcp-still-referenced')
    // RFC-203 T6: principal-aware shape (visible[] + hiddenCount).
    const details = body.details as { visible: { name: string }[]; hiddenCount: number }
    expect(details.visible.map((r) => r.name)).toEqual(['consumer'])
    expect(details.hiddenCount).toBe(0)
  })

  test('DELETE unknown → 404', async () => {
    const res = await req(app, '/api/mcps/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/mcps/:name/rename', () => {
  let app: Hono
  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('happy path → 200 + new name', async () => {
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('old')) })
    const res = await req(app, '/api/mcps/old/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'new' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).name).toBe('new')
  })

  test('rename to existing name → 409', async () => {
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('a')) })
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('b')) })
    const res = await req(app, '/api/mcps/a/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'b' }),
    })
    expect(res.status).toBe(409)
  })

  test('rename with invalid newName → 422', async () => {
    await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(localPayload('a')) })
    const res = await req(app, '/api/mcps/a/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'Bad' }),
    })
    expect(res.status).toBe(422)
  })
})
