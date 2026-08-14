// RFC-247 D17 / D18 / AC-22 / T35 — the generated documentation.
//
// AC-22 is the only thing standing between this page and the usual fate of API
// docs. If the output is DERIVED, it cannot drift; if any part of it is
// retyped, that part is wrong by the next release and nothing fails. So the
// central test here changes a route declaration and asserts the docs change
// with it — not that the docs contain some expected string, which a hand-written
// page would also satisfy.

import { beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { createPat } from '../src/auth/patStore'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb } from '../src/db/client'
import { resolve } from 'node:path'
import { registerRoute, resetRouteMetaRegistry } from '../src/routes/registry'
import { buildApiDocs, clientSnippets, wellKnownMcp } from '../src/services/apiDocs'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

/**
 * Build a real app so the shared route registry holds the PRODUCTION route
 * table. `buildApiDocs` reads that registry, and the AC-22 probes below reset
 * it — without restoring it, every later assertion would be describing an empty
 * platform and would pass or fail for reasons unrelated to what it claims.
 */
function realApp(configPath = '/tmp/aw-rfc247-docs-config.json') {
  const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })
  return {
    db,
    app: createApp({
      token: DAEMON_TOKEN,
      configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db,
      secretBox: createSecretBoxFromKey(randomBytes(32)),
    }),
  }
}

/** A real config.json on disk, so the routes read a live file rather than a stub. */
function configFile(overrides: Partial<Config>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aw-rfc247-docs-')), 'config.json')
  writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, ...overrides }))
  return path
}

describe('RFC-247 AC-22 — the docs are DERIVED, not written', () => {
  test('adding a route declaration adds it to the docs', () => {
    resetRouteMetaRegistry()
    const app = new Hono()
    const before = buildApiDocs('admin').endpoints.length
    registerRoute(
      app,
      {
        method: 'POST',
        path: '/api/rfc247-doc-derivation-probe',
        permissions: ['agents:create'],
        tokenAccess: 'allow',
        summary: 'A probe route that exists only in this test',
      },
      () => new Response('ok'),
    )
    const after = buildApiDocs('admin')
    expect(after.endpoints.length).toBe(before + 1)
    const probe = after.endpoints.find((e) => e.path === '/api/rfc247-doc-derivation-probe')
    expect(probe?.summary).toBe('A probe route that exists only in this test')
    expect(probe?.permissions).toEqual(['agents:create'])
    resetRouteMetaRegistry()
    realApp()
  })

  test('changing a route’s permission changes what the docs say it needs', () => {
    resetRouteMetaRegistry()
    const app = new Hono()
    registerRoute(
      app,
      {
        method: 'GET',
        path: '/api/rfc247-doc-permission-probe',
        permissions: ['agents:read'],
        tokenAccess: 'allow',
        summary: 'probe',
      },
      () => new Response('ok'),
    )
    expect(
      buildApiDocs('admin').endpoints.find((e) => e.path === '/api/rfc247-doc-permission-probe')
        ?.permissions,
    ).toEqual(['agents:read'])

    resetRouteMetaRegistry()
    const app2 = new Hono()
    registerRoute(
      app2,
      {
        method: 'GET',
        path: '/api/rfc247-doc-permission-probe',
        permissions: ['workflows:delete'],
        tokenAccess: 'allow',
        summary: 'probe',
      },
      () => new Response('ok'),
    )
    expect(
      buildApiDocs('admin').endpoints.find((e) => e.path === '/api/rfc247-doc-permission-probe')
        ?.permissions,
    ).toEqual(['workflows:delete'])
    resetRouteMetaRegistry()
    realApp()
  })

  test('the tool list comes from the MCP registry', () => {
    const docs = buildApiDocs('admin')
    const names = docs.tools.map((t) => t.name)
    expect(names).toContain('launch_task')
    expect(names).toContain('resource_write')
    // …and each carries the points the registry declares, so the page can say
    // "this needs tasks:execute" without anyone retyping it.
    expect(docs.tools.find((t) => t.name === 'launch_task')?.permissions).toEqual(['tasks:execute'])
  })
})

describe('RFC-247 D17 — the docs are trimmed to the reader’s role', () => {
  beforeAll(() => {
    realApp()
  })

  test('a plain user is shown no repo-domain write endpoints', () => {
    const user = buildApiDocs('user')
    const repoWrites = user.endpoints.filter((e) =>
      e.permissions.some(
        (p) => p === 'repos:create' || p === 'repos:delete' || p === 'repos:execute',
      ),
    )
    expect(repoWrites).toEqual([])
  })

  test('a manager IS shown them', () => {
    const manager = buildApiDocs('manager')
    expect(manager.endpoints.some((e) => e.permissions.some((p) => p.startsWith('repos:')))).toBe(
      true,
    )
  })

  test('no role is shown a token-closed endpoint', () => {
    // D6: the account surface is closed to every token, so it has no place in
    // documentation about what a token can do.
    for (const role of ['user', 'manager', 'admin'] as const) {
      const paths = buildApiDocs(role).endpoints.map((e) => e.path)
      expect(paths.some((p) => p.startsWith('/api/auth/'))).toBe(false)
    }
  })

  test('the grantable matrix matches what the account page would offer', () => {
    const user = buildApiDocs('user')
    expect(user.grantablePermissions.find((g) => g.resource === 'repos')).toBeUndefined()
    expect(user.grantablePermissions.find((g) => g.resource === 'agents')).toBeDefined()
    const manager = buildApiDocs('manager')
    expect(manager.grantablePermissions.find((g) => g.resource === 'repos')).toBeDefined()
  })

  test('tasks appear in the permission list even though they have no converged tools', () => {
    // `tasks` is excluded from `resource_read`/`resource_write` (it has named
    // tools) but a token certainly holds task points — omitting it from the
    // permission documentation would make the account page look like it offers
    // something undocumented.
    expect(buildApiDocs('admin').grantablePermissions.some((g) => g.resource === 'tasks')).toBe(
      true,
    )
  })

  test('always-granted reads are stated, because they are invisible on the matrix', () => {
    const docs = buildApiDocs('user')
    expect(docs.alwaysGranted).toContain('agents:read')
    expect(docs.alwaysGranted.length).toBeGreaterThan(5)
  })
})

describe('RFC-247 — client snippets', () => {
  test('the opencode snippet disables OAuth auto-detection', () => {
    // Verified against the opencode source: without `oauth: false` its MCP
    // client probes for OAuth first and the user gets an error to interpret.
    const opencode = clientSnippets('http://host:7777').find((s) => s.id === 'opencode')
    expect(opencode?.code).toContain('"oauth": false')
  })

  test('every snippet points at the caller’s own origin', () => {
    for (const snippet of clientSnippets('http://192.168.1.5:7777')) {
      expect(snippet.code).toContain('192.168.1.5:7777')
    }
  })

  test('a trailing slash in the base URL does not produce a double slash', () => {
    for (const snippet of clientSnippets('http://host:7777/')) {
      expect(snippet.code).not.toContain('7777//')
    }
  })

  test('the token is a placeholder, never a real one', () => {
    for (const snippet of clientSnippets('http://host:7777')) {
      expect(snippet.code).toContain('<your-token>')
    }
  })
})

describe('RFC-247 D18 — the discovery document', () => {
  test('it names the endpoint and the auth scheme, and nothing else', () => {
    const doc = wellKnownMcp('http://host:7777', { enabled: true })
    expect(doc.endpoint).toBe('http://host:7777/api/mcp')
    expect((doc.authentication as { type: string }).type).toBe('bearer')
    // Deliberately NOT an unauthenticated inventory of the platform.
    expect(JSON.stringify(doc)).not.toContain('launch_task')
    expect(JSON.stringify(doc)).not.toContain('tools')
  })

  // The impl-gate P2 this closes: with the master switch off the document was
  // byte-identical to the switched-on one, so a client followed it and got
  // refused on every call, with nothing in the discovery answer to explain why.
  test('it reports the master switch, so a closed surface says so', () => {
    expect(wellKnownMcp('http://host:7777', { enabled: false }).enabled).toBe(false)
    expect(wellKnownMcp('http://host:7777', { enabled: true }).enabled).toBe(true)
  })

  test('over HTTP the flag tracks config, not a constant', async () => {
    const off = await realApp(configFile({ mcpSurfaceEnabled: false })).app.request(
      '/.well-known/mcp',
    )
    expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false)

    const on = await realApp(configFile({ mcpSurfaceEnabled: true })).app.request(
      '/.well-known/mcp',
    )
    expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true)
  })
})

// RFC-247 impl-gate P2 — both documents quote URLs the reader is meant to
// paste. Deriving them from `c.req.url` alone published the daemon's internal
// origin whenever a proxy terminated TLS or rewrote the host, which is the one
// deployment shape where a reader most needs the document to be right.
describe('RFC-247 — the published origin survives a reverse proxy', () => {
  test('/.well-known/mcp quotes the forwarded origin, not the internal one', async () => {
    const { app } = realApp()
    const res = await app.request('/.well-known/mcp', {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'aw.example.com' },
    })
    const doc = (await res.json()) as { endpoint: string; documentation: string }
    expect(doc.endpoint).toBe('https://aw.example.com/api/mcp')
    expect(doc.documentation).toBe('https://aw.example.com/docs/api')
  })

  test('a proxy chain resolves to the ORIGINAL client hop', async () => {
    const { app } = realApp()
    const res = await app.request('/.well-known/mcp', {
      headers: {
        'X-Forwarded-Proto': 'https, http',
        'X-Forwarded-Host': 'aw.example.com, internal.local',
      },
    })
    expect(((await res.json()) as { endpoint: string }).endpoint).toBe(
      'https://aw.example.com/api/mcp',
    )
  })

  test('an explicit publicBaseUrl outranks the headers (the vite/dev shape)', async () => {
    const { app } = realApp(configFile({ publicBaseUrl: 'https://configured.example.com/' }))
    const res = await app.request('/.well-known/mcp', {
      headers: { 'X-Forwarded-Host': 'header.example.com' },
    })
    // Trailing slash normalised, so the endpoint has exactly one separator.
    expect(((await res.json()) as { endpoint: string }).endpoint).toBe(
      'https://configured.example.com/api/mcp',
    )
  })

  test('the generated snippets go through the same derivation', async () => {
    const { app, db } = realApp()
    const user = await createUser(db, {
      username: 'proxy-reader',
      displayName: 'Proxy Reader',
      role: 'user',
      password: 'pw12345678',
    })
    const { token } = await createSession({ db, userId: user.id })
    const res = await app.request('/api/docs/api', {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'aw.example.com',
      },
    })
    const body = (await res.json()) as { snippets: Array<{ id: string; code: string }> }
    expect(body.snippets.length).toBeGreaterThan(0)
    for (const snippet of body.snippets) {
      expect(snippet.code).toContain('aw.example.com')
      expect(snippet.code).not.toContain('localhost')
    }
  })
})

describe('RFC-247 — the endpoints over HTTP', () => {
  test('/.well-known/mcp answers without any credential', async () => {
    const { app } = realApp()
    const res = await app.request('/.well-known/mcp')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { transport: string }).transport).toBe('streamable-http')
  })

  test('/api/docs/api answers for a token and reflects ITS role', async () => {
    const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })
    const plain = await createUser(db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    const app = createApp({
      token: DAEMON_TOKEN,
      configPath: '/tmp/aw-rfc247-docs-config.json',
      opencodeVersion: null,
      dbVersion: 1,
      db,
      secretBox: createSecretBoxFromKey(randomBytes(32)),
    })
    const { token } = await createPat({
      db,
      userId: plain.id,
      name: 'reader',
      scopes: [],
      purpose: 'general',
    })
    const res = await app.request('/api/docs/api', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      role: string
      grantablePermissions: Array<{ resource: string }>
      snippets: Array<{ code: string }>
    }
    expect(body.role).toBe('user')
    expect(body.grantablePermissions.some((g) => g.resource === 'repos')).toBe(false)
    expect(body.snippets.length).toBeGreaterThan(0)
  })

  test('a session reader sees the docs for their own role too', async () => {
    const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })
    const admin = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    const app = createApp({
      token: DAEMON_TOKEN,
      configPath: '/tmp/aw-rfc247-docs-config.json',
      opencodeVersion: null,
      dbVersion: 1,
      db,
      secretBox: createSecretBoxFromKey(randomBytes(32)),
    })
    const { token } = await createSession({ db, userId: admin.id })
    const res = await app.request('/api/docs/api', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { role: string }).role).toBe('admin')
  })
})
