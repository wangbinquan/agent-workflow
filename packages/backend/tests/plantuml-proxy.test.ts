import { rimrafDir } from './helpers/cleanup'
// RFC-105 WP-B — PlantUML render proxy.
//
// Encoders round-trip through DEFLATE (pako-byte-equality is NOT required —
// only that a configured server can inflate them). renderPlantuml replicates
// the 3-step browser fallback and stops on a PlantUML diagnostic. The route is
// reachable by ANY logged-in user (the whole point: PlantUML is universal, not
// admin-only), never leaks the auth header, and can't be steered off the
// configured host (no SSRF).

import { afterEach, describe, expect, test } from 'bun:test'
import { inflateRawSync } from 'node:zlib'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import {
  encodeForGet,
  encodeForPlantuml,
  hostOf,
  looksLikePlantumlError,
  renderPlantuml,
} from '../src/services/plantuml'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// ---- encoders ----

function b64urlDecode(s: string): Buffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64')
}

const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'
function plantumlAlphaDecode(s: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < s.length; i += 4) {
    const c1 = ALPHA.indexOf(s[i] ?? '0')
    const c2 = ALPHA.indexOf(s[i + 1] ?? '0')
    const c3 = ALPHA.indexOf(s[i + 2] ?? '0')
    const c4 = ALPHA.indexOf(s[i + 3] ?? '0')
    out.push((c1 << 2) | (c2 >> 4))
    out.push(((c2 & 0xf) << 4) | (c3 >> 2))
    out.push(((c3 & 0x3) << 6) | c4)
  }
  return Buffer.from(out)
}

describe('plantuml encoders', () => {
  const SRC = '@startuml\nAlice -> Bob: hi\n@enduml\n'

  test('encodeForGet → base64url alphabet, round-trips through inflate', () => {
    const enc = encodeForGet(SRC)
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(inflateRawSync(b64urlDecode(enc)).toString('utf8')).toBe(SRC)
  })

  test('encodeForPlantuml → plantuml alphabet, round-trips through inflate', () => {
    const enc = encodeForPlantuml(SRC)
    expect(enc).toMatch(/^[0-9A-Za-z_-]+$/)
    // inflate stops at the DEFLATE end marker, ignoring trailing pad bytes.
    expect(inflateRawSync(plantumlAlphaDecode(enc)).toString('utf8')).toBe(SRC)
  })

  test('encoders are deterministic', () => {
    expect(encodeForPlantuml(SRC)).toBe(encodeForPlantuml(SRC))
  })

  test('hostOf + looksLikePlantumlError', () => {
    expect(hostOf('https://kroki.io/')).toBe('kroki.io')
    expect(looksLikePlantumlError('<svg>PlantUML version 1.2024</svg>')).toBe(true)
    expect(looksLikePlantumlError('<svg>just a diagram</svg>')).toBe(false)
    expect(looksLikePlantumlError('not svg')).toBe(false)
  })
})

// ---- renderPlantuml (fallback chain) ----

function res(status: number, body: string): Response {
  return new Response(body, { status })
}

describe('renderPlantuml', () => {
  test('step 1 success returns svg, no further calls', async () => {
    const calls: string[] = []
    const r = await renderPlantuml({
      source: 'x',
      endpoint: 'https://p.test/',
      authHeader: undefined,
      fetchImpl: (async (url: string) => {
        calls.push(String(url))
        return res(200, '<svg>ok</svg>')
      }) as never,
    })
    expect(r).toEqual({ kind: 'svg', svg: '<svg>ok</svg>' })
    expect(calls.length).toBe(1)
  })

  test('PlantUML diagnostic 4xx stops the chain and returns error-svg', async () => {
    const calls: string[] = []
    const r = await renderPlantuml({
      source: 'x',
      endpoint: 'https://p.test',
      authHeader: undefined,
      fetchImpl: (async (url: string) => {
        calls.push(String(url))
        return res(400, '<svg>PlantUML version 1.2 Syntax Error?</svg>')
      }) as never,
    })
    expect(r.kind).toBe('error-svg')
    expect(calls.length).toBe(1) // did NOT fall through to step 2/3
  })

  test('falls through to step 2 when step 1 is a non-diagnostic failure', async () => {
    let n = 0
    const r = await renderPlantuml({
      source: 'x',
      endpoint: 'https://p.test',
      authHeader: undefined,
      fetchImpl: (async () => {
        n += 1
        return n === 1 ? res(500, 'oops') : res(200, '<svg>second</svg>')
      }) as never,
    })
    expect(r).toEqual({ kind: 'svg', svg: '<svg>second</svg>' })
    expect(n).toBe(2)
  })

  test('all attempts fail → failed', async () => {
    const r = await renderPlantuml({
      source: 'x',
      endpoint: 'https://p.test',
      authHeader: undefined,
      fetchImpl: (async () => res(503, 'down')) as never,
    })
    expect(r.kind).toBe('failed')
  })

  test('sends the auth header to the endpoint, never returns it; no SSRF off-host', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const r = await renderPlantuml({
      source: 'malicious://evil',
      endpoint: 'https://only.test',
      authHeader: 'Bearer SECRET-TOKEN',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const auth =
          init?.headers !== undefined
            ? (init.headers as Record<string, string>)['Authorization']
            : null
        seen.push({ url: String(url), auth: auth ?? null })
        return res(200, '<svg>ok</svg>')
      }) as never,
    })
    expect(seen[0]!.auth).toBe('Bearer SECRET-TOKEN') // sent to endpoint
    expect(seen.every((s) => s.url.startsWith('https://only.test'))).toBe(true) // host fixed
    expect(JSON.stringify(r)).not.toContain('SECRET-TOKEN') // never in the result
  })
})

// ---- route ----

interface AppCtx {
  db: DbClient
  app: Hono
  configPath: string
  cleanup: () => void
}

function buildApp(plantuml?: { endpoint: string; authHeader?: string }): AppCtx {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-plantuml-'))
  const configPath = join(tmp, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      $schema_version: 1,
      ...(plantuml !== undefined
        ? { plantumlEndpoint: plantuml.endpoint, plantumlAuthHeader: plantuml.authHeader }
        : {}),
    }),
  )
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return { db, app, configPath, cleanup: () => rimrafDir(tmp) }
}

async function post(app: Hono, token: string, source: unknown): Promise<Response> {
  return await app.request('/api/plantuml/render', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  })
}

const realFetch = globalThis.fetch

describe('POST /api/plantuml/render', () => {
  let ctx: AppCtx | null = null
  afterEach(() => {
    globalThis.fetch = realFetch
    ctx?.cleanup()
    ctx = null
  })

  test('unconfigured endpoint → { unconfigured: true }', async () => {
    ctx = buildApp()
    const r = await post(ctx.app, DAEMON_TOKEN, '@startuml\nA->B\n@enduml')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ unconfigured: true })
  })

  test('missing source → 400; oversized → 413 (before JSON parse)', async () => {
    ctx = buildApp({ endpoint: 'https://p.test' })
    expect((await post(ctx.app, DAEMON_TOKEN, '')).status).toBe(400)
    // Large body → rejected by the Content-Length guard ahead of json parsing.
    expect((await post(ctx.app, DAEMON_TOKEN, 'x'.repeat(100 * 1024 + 1))).status).toBe(413)
  })

  test('all renderer attempts fail → 200 { error } (not a thrown non-2xx)', async () => {
    ctx = buildApp({ endpoint: 'https://kroki.test' })
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as never
    const r = await post(ctx.app, DAEMON_TOKEN, '@startuml\nA->B\n@enduml')
    // 200 so the browser's api.post resolves and can show the detail.
    expect(r.status).toBe(200)
    const json = (await r.json()) as { error?: string }
    expect(typeof json.error).toBe('string')
  })

  test('configured + render → { svg, host }, auth header never in response', async () => {
    ctx = buildApp({ endpoint: 'https://kroki.test/', authHeader: 'Bearer TOPSECRET' })
    globalThis.fetch = (async () => new Response('<svg>diagram</svg>', { status: 200 })) as never
    const r = await post(ctx.app, DAEMON_TOKEN, '@startuml\nA->B\n@enduml')
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('<svg>diagram</svg>')
    expect(text).toContain('"host":"kroki.test"')
    expect(text).not.toContain('TOPSECRET')
  })

  test('any logged-in user (not just admin) can render — config stays admin-only', async () => {
    ctx = buildApp({ endpoint: 'https://kroki.test' })
    globalThis.fetch = (async () => new Response('<svg>ok</svg>', { status: 200 })) as never
    const u = await createUser(ctx.db, {
      username: 'plantuml-user',
      displayName: 'u',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db: ctx.db, userId: u.id })
    // PlantUML proxy: 200 for a regular user.
    expect((await post(ctx.app, token, '@startuml\nA->B\n@enduml')).status).toBe(200)
    // Contrast: /api/config is still admin-only for the same user.
    const cfgRes = await ctx.app.request('/api/config', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(cfgRes.status).toBe(403)
  })
})
