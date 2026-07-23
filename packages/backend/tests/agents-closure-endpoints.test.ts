// Locks RFC-022 §design 5.6 — `GET /api/agents/:name/closure` and
// `POST /api/agents/closure-preview`.
//
// Red here means one of:
//   1. The closure endpoint changed its agent ordering / shape (BFS, root
//      first, with closure-member skill counts).
//   2. closure-preview started returning 4xx on invalid input — the form
//      runs this every keystroke; flashing red in the browser network panel
//      defeats the point of an inline preview.
//   3. closure / closure-preview stopped appending placeholder `missing:true`
//      rows for dangling dependsOn references.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

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

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  })
}

async function seedAgent(
  db: DbClient,
  name: string,
  opts: {
    dependsOn?: string[]
    skills?: string[]
    mcp?: string[]
    description?: string
  } = {},
): Promise<void> {
  await createAgent(db, {
    name,
    description: opts.description ?? '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    // RFC-223 (PR-1): bare skill names → repo-local project refs (RFC-178). The
    // closure summary projects them back to their display name.
    skills: (opts.skills ?? []).map((name) => ({ kind: 'project' as const, name })),
    dependsOn: opts.dependsOn ?? [],
    mcp: opts.mcp ?? [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
}

describe('GET /api/agents/:name/closure', () => {
  let db: DbClient
  let app: Hono
  beforeEach(() => {
    ;({ db, app } = buildHarness())
  })

  test('returns BFS-ordered agents with root first; closure summary fields populated', async () => {
    await seedAgent(db, 'leaf', { skills: ['s1'], description: 'leaf-desc' })
    await seedAgent(db, 'mid', { dependsOn: ['leaf'], skills: ['s1', 's2'] })
    await seedAgent(db, 'top', { dependsOn: ['mid'], description: 'top-desc' })

    const res = await req(app, '/api/agents/top/closure')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      agents: Array<{
        name: string
        description: string
        skills: string[]
        skillCount: number
        mcp: string[]
        plugins: string[]
        dependsOn: string[]
        missing: boolean
      }>
    }
    expect(body.ok).toBe(true)
    expect(body.agents.map((a) => a.name)).toEqual(['top', 'mid', 'leaf'])
    const leaf = body.agents.find((a) => a.name === 'leaf')!
    // RFC-046 follow-up: `skills` (names) must accompany `skillCount` so the
    // DependencyTree UI can render the names instead of only a count. Same
    // for mcp[] / plugins[] which already shipped as names. If you ever drop
    // skillCount, update the front-end consumers first.
    expect(leaf.skills).toEqual(['s1'])
    expect(leaf.skillCount).toBe(1)
    expect(leaf.mcp).toEqual([])
    expect(leaf.plugins).toEqual([])
    expect(leaf.description).toBe('leaf-desc')
    expect(leaf.missing).toBe(false)
  })

  test('404 when root agent does not exist', async () => {
    const res = await req(app, '/api/agents/ghost/closure')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('agent-not-found')
  })

  test('returns placeholder rows for dangling dependsOn references (closure member references a name no longer in DB)', async () => {
    // Inject a dangling reference via raw UPDATE (createAgent guard would
    // refuse). Matches the runtime scenario where another writer modifies
    // depends_on directly.
    await seedAgent(db, 'top')
    const { sql } = await import('drizzle-orm')
    await db.run(sql`UPDATE agents SET depends_on = '["ghost"]' WHERE name = 'top'`)

    const res = await req(app, '/api/agents/top/closure')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      agents: Array<{ name: string; missing: boolean }>
    }
    const ghost = body.agents.find((a) => a.name === 'ghost')
    expect(ghost).toBeDefined()
    expect(ghost?.missing).toBe(true)
  })
})

describe('POST /api/agents/closure-preview', () => {
  let db: DbClient
  let app: Hono
  beforeEach(() => {
    ;({ db, app } = buildHarness())
  })

  test('ok:true for a valid draft (selfName need not exist yet — new-agent flow)', async () => {
    await seedAgent(db, 'leaf')
    const res = await req(app, '/api/agents/closure-preview', {
      method: 'POST',
      body: JSON.stringify({ name: 'brand-new', dependsOn: ['leaf'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      agents: Array<{ name: string }>
    }
    expect(body.ok).toBe(true)
    expect(body.agents.map((a) => a.name)).toEqual(['brand-new', 'leaf'])
  })

  test('returns HTTP 200 with ok:false on validation errors (no 4xx flash on every keystroke)', async () => {
    // Self-reference: classic save-time refusal — preview surfaces it the
    // same way but as 200/ok:false instead of 400.
    const res = await req(app, '/api/agents/closure-preview', {
      method: 'POST',
      body: JSON.stringify({ name: 'fresh', dependsOn: ['fresh'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('agent-dependency-self')
  })

  test('returns HTTP 200 with ok:false + cyclePath when proposed dependsOn would form a cycle', async () => {
    await seedAgent(db, 'c')
    await seedAgent(db, 'b', { dependsOn: ['c'] })
    await seedAgent(db, 'a', { dependsOn: ['b'] })
    // Proposed: c.dependsOn = ['a'] which closes a → b → c → a.
    const res = await req(app, '/api/agents/closure-preview', {
      method: 'POST',
      body: JSON.stringify({ name: 'c', dependsOn: ['a'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      code: string
      details: { cyclePath: string[] }
    }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('agent-dependency-cycle')
    expect(body.details.cyclePath.length).toBeGreaterThanOrEqual(3)
  })
})
