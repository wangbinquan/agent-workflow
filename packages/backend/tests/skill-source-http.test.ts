import { rimrafDir } from './helpers/cleanup'
// Locks RFC-017 §A1 — HTTP surface of /api/skill-sources:
//   POST happy path → 201 + imported / skipped
//   POST duplicate path → 409 skill-source-path-in-use
//   POST nonexistent path → 422 skill-source-path-missing

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'

const TOKEN = 'b'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  app: Hono
  parent: string
  appHome: string
  cleanup: () => void
}

function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-srcsrc-'))
  const parent = mkdtempSync(join(tmpdir(), 'aw-srcsrc-parent-'))
  const prev = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: join(appHome, 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return {
    db,
    app,
    parent,
    appHome,
    cleanup: () => {
      rimrafDir(parent)
      rimrafDir(appHome)
      if (prev === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prev
    },
  }
}

function authReq(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return Promise.resolve(app.request(path, { ...init, headers }))
}

function addSkill(parent: string, name: string): void {
  mkdirSync(join(parent, name), { recursive: true })
  writeFileSync(
    join(parent, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: from ${name}\n---\nbody\n`,
  )
}

let h: H
beforeEach(() => {
  h = build()
})
afterEach(() => h.cleanup())

describe('POST /api/skill-sources', () => {
  test('happy path → 201 + imported children listed', async () => {
    addSkill(h.parent, 'alpha')
    addSkill(h.parent, 'beta')

    const res = await authReq(h.app, '/api/skill-sources', {
      method: 'POST',
      body: JSON.stringify({ path: h.parent, label: 'demo' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      source: { id: string; label: string; childCount: number }
      imported: Array<{ name: string; sourceId?: string }>
      skipped: unknown[]
    }
    expect(body.source.label).toBe('demo')
    expect(body.source.childCount).toBe(2)
    expect(body.imported.map((s) => s.name).sort()).toEqual(['alpha', 'beta'])
    expect(body.imported.every((s) => s.sourceId === body.source.id)).toBe(true)
    expect(body.skipped).toEqual([])

    // GET /api/skills should also return both, with sourceId stamped.
    const list = await authReq(h.app, '/api/skills')
    const skillRows = (await list.json()) as Array<{ name: string; sourceId?: string }>
    expect(skillRows.map((r) => r.name).sort()).toEqual(['alpha', 'beta'])
    expect(skillRows.every((r) => r.sourceId === body.source.id)).toBe(true)
  })

  test('duplicate path → 409 skill-source-path-in-use', async () => {
    addSkill(h.parent, 'alpha')
    await authReq(h.app, '/api/skill-sources', {
      method: 'POST',
      body: JSON.stringify({ path: h.parent }),
    })

    const res = await authReq(h.app, '/api/skill-sources', {
      method: 'POST',
      body: JSON.stringify({ path: h.parent }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { ok: false; code: string }
    expect(body.code).toBe('skill-source-path-in-use')
  })

  test('nonexistent path → 422 skill-source-path-missing', async () => {
    const res = await authReq(h.app, '/api/skill-sources', {
      method: 'POST',
      body: JSON.stringify({ path: '/this/should/not/exist/at/all/aw' }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { ok: false; code: string }
    expect(body.code).toBe('skill-source-path-missing')
  })
})
