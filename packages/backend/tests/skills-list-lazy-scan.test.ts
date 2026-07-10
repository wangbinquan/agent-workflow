import { rimrafDir } from './helpers/cleanup'
// Locks RFC-017 §A3 — lazy reconcile on GET /api/skills.
// After registering a parent directory, dropping a new child subdir on disk
// must surface on the very next list request, no explicit rescan needed.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'

const TOKEN = 'd'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  app: Hono
  parent: string
  appHome: string
  cleanup: () => void
}

function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-lazy-'))
  const parent = mkdtempSync(join(tmpdir(), 'aw-lazy-parent-'))
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
    `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`,
  )
}

let h: H
beforeEach(() => {
  h = build()
})
afterEach(() => h.cleanup())

test('lazy: external mkdir surfaces on next GET /api/skills without manual rescan', async () => {
  addSkill(h.parent, 'first')
  await authReq(h.app, '/api/skill-sources', {
    method: 'POST',
    body: JSON.stringify({ path: h.parent }),
  })
  // Sanity.
  const a = await authReq(h.app, '/api/skills')
  const aRows = (await a.json()) as Array<{ name: string }>
  expect(aRows.map((r) => r.name)).toEqual(['first'])

  // External agent adds a new child folder.
  addSkill(h.parent, 'second')

  // No POST /rescan call — just refetch the list.
  const b = await authReq(h.app, '/api/skills')
  const bRows = (await b.json()) as Array<{ name: string }>
  expect(bRows.map((r) => r.name).sort()).toEqual(['first', 'second'])
})
