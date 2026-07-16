// RFC-201 T10.1 — exact MCP operation revision, full-promise dedup, and
// deterministic foreign-write/finalize interleavings.

import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createInMemoryDb } from '../src/db/client'
import { __setProbeOptionsForTesting } from '../src/routes/mcps'
import type { OpenClientFn, ProbedMcpClient } from '../src/services/mcpProbe'
import { createApp } from '../src/server'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOKEN = 'rfc201-mcp-token'

function harness(): Hono {
  return createApp({
    token: TOKEN,
    configPath: '/tmp/aw-rfc201-mcp.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db: createInMemoryDb(MIGRATIONS),
  })
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

interface Resource {
  id: string
  name: string
  description: string
  updatedAt: number
  operationConfigHash: string
}

async function createMcp(app: Hono, description = 'v1'): Promise<Resource> {
  const response = await req(app, '/api/mcps', {
    method: 'POST',
    body: JSON.stringify({
      name: 'pg',
      description,
      type: 'local',
      config: { command: ['fake'] },
      enabled: true,
    }),
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<Resource>
}

async function getMcp(app: Hono, name = 'pg'): Promise<Resource> {
  const response = await req(app, `/api/mcps/${name}`)
  expect(response.status).toBe(200)
  return response.json() as Promise<Resource>
}

function postProbe(app: Hono, hash: string, name = 'pg'): Promise<Response> {
  return req(app, `/api/mcps/${name}/probe`, {
    method: 'POST',
    body: JSON.stringify({ expectedConfigHash: hash }),
  })
}

function client(toolName: string): ProbedMcpClient {
  return {
    serverInfo: { name: toolName },
    protocolVersion: '2025-06-18',
    capabilities: {},
    listTools: async () => [{ name: toolName }],
    listResources: async () => [],
    listResourceTemplates: async () => [],
    listPrompts: async () => [],
    capturedStderr: () => '',
    close: async () => {},
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => __setProbeOptionsForTesting(undefined))

describe('RFC-201 MCP exact operation wire', () => {
  test('GET/PUT return hashes and a semantic no-op does not bump revision or timestamp', async () => {
    const app = harness()
    const created = await createMcp(app)
    expect(created.operationConfigHash).toMatch(/^[a-f0-9]{64}$/)

    const noOp = await req(app, '/api/mcps/pg', {
      method: 'PUT',
      body: JSON.stringify({ description: 'v1', config: { command: ['fake'] }, enabled: true }),
    })
    expect(noOp.status).toBe(200)
    const unchanged = (await noOp.json()) as Resource
    expect(unchanged.updatedAt).toBe(created.updatedAt)
    expect(unchanged.operationConfigHash).toBe(created.operationConfigHash)

    const changedResponse = await req(app, '/api/mcps/pg', {
      method: 'PUT',
      body: JSON.stringify({ description: 'v2' }),
    })
    const changed = (await changedResponse.json()) as Resource
    expect(changed.updatedAt).toBeGreaterThan(created.updatedAt)
    expect(changed.operationConfigHash).not.toBe(created.operationConfigHash)
  })

  test('stale expected hash returns stable 409 before opening transport', async () => {
    const app = harness()
    const created = await createMcp(app)
    await req(app, '/api/mcps/pg', {
      method: 'PUT',
      body: JSON.stringify({ description: 'foreign' }),
    })
    let opens = 0
    __setProbeOptionsForTesting({
      openClient: async () => {
        opens += 1
        return { client: client('never'), handshakeMs: 0 }
      },
    })
    const response = await postProbe(app, created.operationConfigHash)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { code: string }).code).toBe('resource-operation-stale')
    expect(opens).toBe(0)
  })

  test('same id+hash callers join start, I/O, persistence, and receipt', async () => {
    const app = harness()
    const created = await createMcp(app)
    const gate = deferred()
    let opens = 0
    __setProbeOptionsForTesting({
      openClient: async () => {
        opens += 1
        await gate.promise
        return { client: client('joined'), handshakeMs: 1 }
      },
    })
    const a = postProbe(app, created.operationConfigHash)
    const b = postProbe(app, created.operationConfigHash)
    while (opens === 0) await Promise.resolve()
    expect(opens).toBe(1)
    gate.resolve()
    const [ar, br] = await Promise.all([a, b])
    expect([ar.status, br.status]).toEqual([200, 200])
    const bodies = (await Promise.all([ar.json(), br.json()])) as Array<{
      id: string
      configHashUsed: string
    }>
    const aj = bodies[0]!
    const bj = bodies[1]!
    expect(aj.id).toBe(bj.id)
    expect(aj.configHashUsed).toBe(created.operationConfigHash)
    expect(bj.configHashUsed).toBe(created.operationConfigHash)
  })

  test('H1 paused → PUT H2 → H2 completes → H1 late is 409 and cannot overwrite H2', async () => {
    const app = harness()
    const h1 = await createMcp(app, 'v1')
    const oldGate = deferred()
    let oldOpened = false
    const opener: OpenClientFn = async (mcp) => {
      if (mcp.description === 'v1') {
        oldOpened = true
        await oldGate.promise
        return { client: client('old'), handshakeMs: 1 }
      }
      return { client: client('new'), handshakeMs: 1 }
    }
    __setProbeOptionsForTesting({ openClient: opener })

    const oldResponseP = postProbe(app, h1.operationConfigHash)
    while (!oldOpened) await Promise.resolve()
    const put = await req(app, '/api/mcps/pg', {
      method: 'PUT',
      body: JSON.stringify({ description: 'v2' }),
    })
    const h2 = (await put.json()) as Resource
    const newResponse = await postProbe(app, h2.operationConfigHash)
    expect(newResponse.status).toBe(200)
    oldGate.resolve()
    const oldResponse = await oldResponseP
    expect(oldResponse.status).toBe(409)
    expect(((await oldResponse.json()) as { code: string }).code).toBe('resource-operation-stale')

    const persisted = await req(app, '/api/mcps/pg/probe')
    const persistedJson = (await persisted.json()) as { tools: Array<{ name: string }> }
    expect(persistedJson.tools.map((tool) => tool.name)).toEqual(['new'])
  })

  test('rename and ACL mutation share the stable-id fence and stale a paused probe', async () => {
    for (const mutation of ['rename', 'acl'] as const) {
      const app = harness()
      const created = await createMcp(app)
      const gate = deferred()
      let opened = false
      __setProbeOptionsForTesting({
        openClient: async () => {
          opened = true
          await gate.promise
          return { client: client('stale'), handshakeMs: 1 }
        },
      })
      const responseP = postProbe(app, created.operationConfigHash)
      while (!opened) await Promise.resolve()
      const changed =
        mutation === 'rename'
          ? await req(app, '/api/mcps/pg/rename', {
              method: 'POST',
              body: JSON.stringify({ newName: 'pg-renamed' }),
            })
          : await req(app, '/api/mcps/pg/acl', {
              method: 'PUT',
              body: JSON.stringify({ visibility: 'private' }),
            })
      expect(changed.status).toBe(200)
      const changedResource =
        mutation === 'rename' ? ((await changed.clone().json()) as Resource) : await getMcp(app)
      expect(changedResource.operationConfigHash).not.toBe(created.operationConfigHash)
      gate.resolve()
      const response = await responseP
      expect(response.status).toBe(409)
      const probeGet = await req(
        app,
        `/api/mcps/${mutation === 'rename' ? 'pg-renamed' : 'pg'}/probe`,
      )
      expect(probeGet.status).toBe(404)
      expect(((await probeGet.json()) as { code: string }).code).toBe('probe-not-found')
    }
  })

  test('persisted probe follows the stable MCP id across rename', async () => {
    const app = harness()
    const created = await createMcp(app)
    __setProbeOptionsForTesting({
      openClient: async () => ({ client: client('renamed-tool'), handshakeMs: 0 }),
    })
    expect((await postProbe(app, created.operationConfigHash)).status).toBe(200)

    const renamed = await req(app, '/api/mcps/pg/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'pg-renamed' }),
    })
    expect(renamed.status).toBe(200)

    const probe = await req(app, '/api/mcps/pg-renamed/probe')
    expect(probe.status).toBe(200)
    expect(
      (await probe.json()) as { mcpName: string; tools: Array<{ name: string }> },
    ).toMatchObject({
      mcpName: 'pg-renamed',
      tools: [{ name: 'renamed-tool' }],
    })
  })

  test('frozen clock preserves Save→Probe freshness and Probe→Save staleness', async () => {
    const app = harness()
    await createMcp(app)
    __setProbeOptionsForTesting({
      now: () => 1_000,
      openClient: async () => ({ client: client('clock'), handshakeMs: 0 }),
    })
    const saveResponse = await req(app, '/api/mcps/pg', {
      method: 'PUT',
      body: JSON.stringify({ description: 'saved' }),
    })
    const saved = (await saveResponse.json()) as Resource
    const probeResponse = await postProbe(app, saved.operationConfigHash)
    const probe = (await probeResponse.json()) as { startedAt: number; configHashUsed: string }
    expect(probe.startedAt).toBeGreaterThan(saved.updatedAt)
    expect(probe.configHashUsed).toBe(saved.operationConfigHash)

    const afterProbeResponse = await req(app, '/api/mcps/pg', {
      method: 'PUT',
      body: JSON.stringify({ description: 'after-probe' }),
    })
    const afterProbe = (await afterProbeResponse.json()) as Resource
    expect(afterProbe.updatedAt).toBeGreaterThan(probe.startedAt)
  })
})
