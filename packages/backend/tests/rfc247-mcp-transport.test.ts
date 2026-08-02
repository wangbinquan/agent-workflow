// RFC-247 §4.1 / AC-10 / AC-18 / F4 / F6 — the `/api/mcp` endpoint itself.
//
// Everything here is about who gets to open the pipe at all, before any tool
// exists. Three gates, each of which fails open in a different and unpleasant
// way if it regresses:
//
//   · session/daemon credentials refused — otherwise a browser cookie or the
//     deployment's root token becomes an agent credential
//   · surface switch honoured — otherwise the incident lever does not work
//   · a real MCP handshake actually completes — otherwise everything above is
//     guarding a door with nothing behind it

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { createPat } from '../src/auth/patStore'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

function configFile(mcpSurfaceEnabled: boolean): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aw-rfc247-transport-')), 'config.json')
  writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, mcpSurfaceEnabled }))
  return path
}

interface Harness {
  db: DbClient
  app: Hono
  patToken: string
  sessionToken: string
}

async function harness(surfaceEnabled = true): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })
  const user = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'pw12345678',
  })
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: configFile(surfaceEnabled),
    opencodeVersion: null,
    dbVersion: 1,
    db,
    secretBox: createSecretBoxFromKey(randomBytes(32)),
  })
  const { token: patToken } = await createPat({
    db,
    userId: user.id,
    name: 'mcp',
    scopes: [],
    purpose: 'mcp_only',
  })
  const { token: sessionToken } = await createSession({ db, userId: user.id })
  return { db, app, patToken, sessionToken }
}

/** A well-formed `initialize` request — the first thing any MCP client sends. */
function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1' },
    },
  })
}

async function mcpRequest(app: Hono, token: string, body = initializeBody()): Promise<Response> {
  return app.request('/api/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // Streamable HTTP requires the client to accept both.
      accept: 'application/json, text/event-stream',
    },
    body,
  })
}

/** Pull the tool names out of a Streamable-HTTP SSE frame. */
function toolNamesFromSse(text: string): string[] {
  const line = text.split('\n').find((l) => l.startsWith('data: '))
  if (line === undefined) throw new Error(`no SSE data frame in: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(line.slice('data: '.length)) as {
    result?: { tools?: Array<{ name: string }> }
  }
  return (parsed.result?.tools ?? []).map((t) => t.name)
}

describe('RFC-247 §4.1 — only personal access tokens open the pipe', () => {
  test('a PAT completes the MCP handshake', async () => {
    const h = await harness()
    const res = await mcpRequest(h.app, h.patToken)
    expect(res.status).toBe(200)
    const text = await res.text()
    // The transport answers as SSE by default; either framing carries the same
    // JSON-RPC result, so assert on the payload rather than the envelope.
    expect(text).toContain('"protocolVersion"')
    expect(text).toContain('agent-workflow')
  })

  // D10: "session token 与 daemon token 打该端点一律 401". 401 rather than 403 is
  // load-bearing — the caller presented a credential this endpoint does not
  // accept AT ALL, so the actionable answer is "authenticate with a personal
  // access token", not "your permissions are insufficient". An earlier version
  // returned 403 and THIS TEST ASSERTED IT, so implementation and test agreed
  // with each other while both disagreed with the contract (impl-gate finding).
  test('a session token is refused with 401', async () => {
    const h = await harness()
    const res = await mcpRequest(h.app, h.sessionToken)
    expect(res.status).toBe(401)
  })

  test('the daemon token is refused with 401', async () => {
    const h = await harness()
    const res = await mcpRequest(h.app, DAEMON_TOKEN)
    expect(res.status).toBe(401)
  })

  test('no credential at all is a 401', async () => {
    const h = await harness()
    const res = await h.app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: initializeBody(),
    })
    expect(res.status).toBe(401)
  })
})

describe('RFC-247 D10 / F6 — the surface switch closes the endpoint', () => {
  test('a valid PAT is refused while the switch is off', async () => {
    const h = await harness(false)
    const res = await mcpRequest(h.app, h.patToken)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('mcp-surface-disabled')
  })

  test('the refusal happens per REQUEST, so an established client stops too', async () => {
    // Stateless transport: there is no long-lived connection to tear down, and
    // the next call is simply refused. This test states that as a property
    // rather than leaving it as an assumption about the transport.
    const h = await harness(false)
    for (let i = 0; i < 3; i += 1) {
      expect((await mcpRequest(h.app, h.patToken)).status).toBe(403)
    }
  })
})

describe('RFC-247 — tools/list reaches the model', () => {
  test('a read-only token is offered the read tools over the real transport', async () => {
    const h = await harness()
    // Streamable HTTP is stateless here, so tools/list needs no prior session.
    const res = await mcpRequest(
      h.app,
      h.patToken,
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    )
    expect(res.status).toBe(200)
    // Assert on the parsed tool NAMES rather than on the raw frame: tool
    // descriptions legitimately mention other tools ("as returned by
    // launch_task"), so a substring search over the payload reports a tool as
    // present when only its name was cited.
    const names = toolNamesFromSse(await res.text())
    expect(names).toContain('get_task')
    expect(names).toContain('resource_read')
    expect(names).toContain('describe_capabilities')
    // …and nothing this token cannot call.
    expect(names).not.toContain('launch_task')
    expect(names).not.toContain('delete_task')
  })
})
