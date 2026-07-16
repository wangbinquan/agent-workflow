// RFC-030 T6 — /api/mcps/probes + /api/mcps/:name/probe HTTP contract.
//
// Pins:
//   - GET /api/mcps/probes: returns [] when no probes exist (and crucially is
//     NOT swallowed by the parametric /api/mcps/:name route).
//   - GET /api/mcps/:name/probe: 404 mcp-not-found vs 404 probe-not-found
//     are distinguished by the `code` field in the error body.
//   - POST /api/mcps/:name/probe: 422 mcp-disabled (before transport open),
//     200 + status='error' on probe failure (NEVER 5xx — failure is expected
//     and persisted so the UI can render it).
//   - Auth: requests without bearer return 401 (same as RFC-028 routes).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createInMemoryDb, type DbClient } from '../../src/db/client'
import { __setProbeOptionsForTesting } from '../../src/routes/mcps'
import type { OpenClientFn, ProbedMcpClient } from '../../src/services/mcpProbe'
import { createApp } from '../../src/server'

const MIGRATIONS = resolve(import.meta.dir, '..', '..', 'db', 'migrations')
const TOKEN = 'rfc030-token-fixture'

function makeFakeClient(opts: { failTools?: boolean } = {}): ProbedMcpClient {
  return {
    serverInfo: { name: 'fake', version: '1.0' },
    protocolVersion: '2024-11-05',
    capabilities: {},
    listTools: () =>
      opts.failTools === true
        ? Promise.reject(new Error('tools/list MethodNotFound'))
        : Promise.resolve([{ name: 't1' }, { name: 't2' }]),
    listResources: () => Promise.resolve([]),
    listResourceTemplates: () => Promise.resolve([]),
    listPrompts: () => Promise.resolve([]),
    capturedStderr: () => '',
    close: async () => {},
  }
}

function fakeOpener(client: ProbedMcpClient): OpenClientFn {
  return async () => ({ client, handshakeMs: 5 })
}

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

async function createMcp(
  app: Hono,
  body: Record<string, unknown>,
): Promise<{ name: string; id: string; operationConfigHash: string }> {
  const r = await req(app, '/api/mcps', { method: 'POST', body: JSON.stringify(body) })
  if (r.status !== 201) throw new Error(`mcp create failed: ${r.status} ${await r.text()}`)
  const j = (await r.json()) as { name: string; id: string; operationConfigHash: string }
  return j
}

async function postProbe(app: Hono, name: string, expectedConfigHash: string): Promise<Response> {
  return req(app, `/api/mcps/${name}/probe`, {
    method: 'POST',
    body: JSON.stringify({ expectedConfigHash }),
  })
}

afterEach(() => {
  __setProbeOptionsForTesting(undefined)
})

describe('GET /api/mcps/probes (static route precedence)', () => {
  let app: Hono
  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('returns [] when no probes exist (not swallowed by /:name)', async () => {
    const r = await req(app, '/api/mcps/probes')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  test('returns the latest probe per mcp after POST probe', async () => {
    const mcp = await createMcp(app, {
      name: 'pg-prod',
      type: 'local',
      config: { command: ['uvx', 'pg-mcp'] },
    })
    __setProbeOptionsForTesting({ openClient: fakeOpener(makeFakeClient()) })
    const probed = await postProbe(app, 'pg-prod', mcp.operationConfigHash)
    expect(probed.status).toBe(200)

    const list = await req(app, '/api/mcps/probes')
    expect(list.status).toBe(200)
    const arr = (await list.json()) as Array<{ mcpName: string; status: string }>
    expect(arr).toHaveLength(1)
    expect(arr[0]!.mcpName).toBe('pg-prod')
    expect(arr[0]!.status).toBe('ok')
  })
})

describe('GET /api/mcps/:name/probe', () => {
  let app: Hono
  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('404 mcp-not-found when mcp absent', async () => {
    const r = await req(app, '/api/mcps/nope/probe')
    expect(r.status).toBe(404)
    const j = (await r.json()) as { code: string }
    expect(j.code).toBe('mcp-not-found')
  })

  test('404 probe-not-found when mcp exists but never probed', async () => {
    await createMcp(app, {
      name: 'pg-prod',
      type: 'local',
      config: { command: ['uvx', 'pg-mcp'] },
    })
    const r = await req(app, '/api/mcps/pg-prod/probe')
    expect(r.status).toBe(404)
    const j = (await r.json()) as { code: string }
    expect(j.code).toBe('probe-not-found')
  })

  test('200 with probe row after POST', async () => {
    const mcp = await createMcp(app, {
      name: 'pg-prod',
      type: 'local',
      config: { command: ['uvx', 'pg-mcp'] },
    })
    __setProbeOptionsForTesting({ openClient: fakeOpener(makeFakeClient()) })
    await postProbe(app, 'pg-prod', mcp.operationConfigHash)
    const r = await req(app, '/api/mcps/pg-prod/probe')
    expect(r.status).toBe(200)
    const j = (await r.json()) as { status: string; tools: unknown[] }
    expect(j.status).toBe('ok')
    expect(j.tools).toHaveLength(2)
  })
})

describe('POST /api/mcps/:name/probe', () => {
  let app: Hono
  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('200 + status=ok on happy path', async () => {
    const mcp = await createMcp(app, {
      name: 'pg-prod',
      type: 'local',
      config: { command: ['uvx', 'pg-mcp'] },
    })
    __setProbeOptionsForTesting({ openClient: fakeOpener(makeFakeClient()) })
    const r = await postProbe(app, 'pg-prod', mcp.operationConfigHash)
    expect(r.status).toBe(200)
    const j = (await r.json()) as { status: string; mcpName: string }
    expect(j.status).toBe('ok')
    expect(j.mcpName).toBe('pg-prod')
  })

  test('200 + status=error when probe fails (NOT 5xx — failure is expected/persisted)', async () => {
    const mcp = await createMcp(app, {
      name: 'pg-prod',
      type: 'local',
      config: { command: ['uvx', 'pg-mcp'] },
    })
    const opener: OpenClientFn = async () => {
      const e = new Error('spawn uvx ENOENT') as Error & { code: string }
      e.code = 'ENOENT'
      throw e
    }
    __setProbeOptionsForTesting({ openClient: opener })
    const r = await postProbe(app, 'pg-prod', mcp.operationConfigHash)
    expect(r.status).toBe(200)
    const j = (await r.json()) as { status: string; errorCode: string }
    expect(j.status).toBe('error')
    expect(j.errorCode).toBe('connect-failed')
  })

  test('200 + status=ok + errorCode=partial when one list fails', async () => {
    const mcp = await createMcp(app, {
      name: 'pg-prod',
      type: 'local',
      config: { command: ['uvx', 'pg-mcp'] },
    })
    __setProbeOptionsForTesting({
      openClient: fakeOpener(makeFakeClient({ failTools: true })),
    })
    const r = await postProbe(app, 'pg-prod', mcp.operationConfigHash)
    expect(r.status).toBe(200)
    const j = (await r.json()) as { status: string; errorCode: string; tools: unknown }
    expect(j.status).toBe('ok')
    expect(j.errorCode).toBe('partial')
    expect(j.tools).toBeNull()
  })

  test('422 mcp-disabled when enabled=false', async () => {
    const mcp = await createMcp(app, {
      name: 'pg-prod',
      type: 'local',
      config: { command: ['uvx', 'pg-mcp'] },
      enabled: false,
    })
    const r = await postProbe(app, 'pg-prod', mcp.operationConfigHash)
    expect(r.status).toBe(422)
    const j = (await r.json()) as { code: string }
    expect(j.code).toBe('mcp-disabled')
  })

  test('404 mcp-not-found before any probe attempt', async () => {
    const r = await postProbe(app, 'ghost', '0'.repeat(64))
    expect(r.status).toBe(404)
    const j = (await r.json()) as { code: string }
    expect(j.code).toBe('mcp-not-found')
  })
})

describe('auth', () => {
  test('GET /api/mcps/probes returns 401 without token', async () => {
    const { app } = buildHarness()
    const r = await app.request('/api/mcps/probes')
    expect(r.status).toBe(401)
  })

  test('POST /api/mcps/:name/probe returns 401 without token', async () => {
    const { app } = buildHarness()
    const r = await app.request('/api/mcps/x/probe', { method: 'POST' })
    expect(r.status).toBe(401)
  })
})
