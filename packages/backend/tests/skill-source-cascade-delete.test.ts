import { rimrafDir } from './helpers/cleanup'
// Locks RFC-017 §A5 — DELETE /api/skill-sources/:id behaviour:
//   - no agent references → 204 + cascade delete of all child skills
//   - any agent reference → 422 skill-source-children-referenced + blockers
//   - after delete, GET /api/skills no longer returns the children

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, skills } from '../src/db/schema'
import { createApp } from '../src/server'

const TOKEN = 'c'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  app: Hono
  parent: string
  appHome: string
  cleanup: () => void
}

function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-cascade-'))
  const parent = mkdtempSync(join(tmpdir(), 'aw-cascade-parent-'))
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
    `---\nname: ${name}\ndescription: ${name} desc\n---\nbody\n`,
  )
}

async function register(h: H): Promise<string> {
  const res = await authReq(h.app, '/api/skill-sources', {
    method: 'POST',
    body: JSON.stringify({ path: h.parent }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { source: { id: string } }
  return body.source.id
}

let h: H
beforeEach(() => {
  h = build()
})
afterEach(() => h.cleanup())

describe('DELETE /api/skill-sources/:id', () => {
  test('no agent references → 204 + cascade delete', async () => {
    addSkill(h.parent, 'apple')
    addSkill(h.parent, 'banana')
    const id = await register(h)

    const del = await authReq(h.app, `/api/skill-sources/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)

    const left = await h.db.select().from(skills)
    expect(left).toEqual([])
    const list = await authReq(h.app, '/api/skills')
    expect(await list.json()).toEqual([])
  })

  test('agent reference → 422 skill-source-children-referenced with blockers', async () => {
    addSkill(h.parent, 'pinned')
    const id = await register(h)
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'agent-a',
      description: '',
      outputs: JSON.stringify(['result']),
      syncOutputsOnIterate: true,
      permission: '{}',
      skills: JSON.stringify(['pinned']),
      frontmatterExtra: '{}',
      bodyMd: '',
    })

    const del = await authReq(h.app, `/api/skill-sources/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(422)
    const body = (await del.json()) as {
      ok: false
      code: string
      details: { blockers: Array<{ skillName: string; byAgent: string }> }
    }
    expect(body.code).toBe('skill-source-children-referenced')
    expect(body.details.blockers).toEqual([{ skillName: 'pinned', byAgent: 'agent-a' }])
    // Source row still exists.
    const list = await authReq(h.app, '/api/skill-sources')
    const sources = ((await list.json()) as { sources: unknown[] }).sources
    expect(sources).toHaveLength(1)
  })

  test('rescan endpoint reports added/deleted/skipped after external mutation', async () => {
    addSkill(h.parent, 'one')
    const id = await register(h)
    addSkill(h.parent, 'two')
    rmSync(join(h.parent, 'one'), { recursive: true })

    const res = await authReq(h.app, `/api/skill-sources/${id}/rescan`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      source: { childCount: number }
      imported: Array<{ name: string }>
      deleted: string[]
      skipped: unknown[]
    }
    expect(body.imported.map((s) => s.name)).toEqual(['two'])
    expect(body.deleted).toEqual(['one'])
    expect(body.skipped).toEqual([])
    expect(body.source.childCount).toBe(1)
  })
})
