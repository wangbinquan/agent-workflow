import { rimrafDir } from './helpers/cleanup'
// RFC-019: HTTP layer for ZIP batch import.
// Locks the parse / commit contracts: multipart wiring, decisions JSON,
// error code surface area.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { zipSync, type Zippable } from 'fflate'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  app: Hono
  appHome: string
  cleanup: () => void
}

function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-zip-http-'))
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
    appHome,
    cleanup: () => {
      rimrafDir(appHome)
      if (prev === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prev
    },
  }
}

function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const z: Zippable = {}
  for (const [k, v] of Object.entries(files)) {
    z[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v
  }
  return zipSync(z)
}

function multipartParse(zip: Uint8Array): FormData {
  const fd = new FormData()
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'pack.zip')
  return fd
}

function multipartCommit(zip: Uint8Array, decisions: unknown): FormData {
  const fd = new FormData()
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'pack.zip')
  fd.append('decisions', JSON.stringify(decisions))
  return fd
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  return app.request(path, { ...init, headers })
}

const skillMd = (name: string, desc = 'd') =>
  `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`

describe('POST /api/skills/import-zip/parse', () => {
  let h: H
  beforeEach(() => {
    h = build()
  })
  afterEach(() => h.cleanup())

  test('happy path returns skill candidates + no errors', async () => {
    const zip = makeZip({
      'skill-a/SKILL.md': skillMd('skill-a', 'a desc'),
      'skill-b/SKILL.md': skillMd('skill-b', 'b desc'),
    })
    const res = await req(h.app, '/api/skills/import-zip/parse', {
      method: 'POST',
      body: multipartParse(zip),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      skills: Array<{ name: string; description: string; fileCount: number }>
      errors: unknown[]
    }
    expect(body.skills.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b'])
    expect(body.errors).toEqual([])
  })

  test('missing file field → 422 zip-file-missing', async () => {
    const res = await req(h.app, '/api/skills/import-zip/parse', {
      method: 'POST',
      body: new FormData(),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('zip-file-missing')
  })

  test('zip-traversal payload → 422 zip-traversal', async () => {
    const zip = zipSync({ '../escape.md': new TextEncoder().encode('x') })
    const res = await req(h.app, '/api/skills/import-zip/parse', {
      method: 'POST',
      body: multipartParse(zip),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('zip-traversal')
  })

  test('conflict field populated for existing managed skill', async () => {
    // Pre-create a managed skill so the parse response can flag it.
    await req(h.app, '/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'skill-a',
        description: 'pre',
        bodyMd: '',
        frontmatterExtra: {},
      }),
    })
    const zip = makeZip({ 'skill-a/SKILL.md': skillMd('skill-a', 'new') })
    const res = await req(h.app, '/api/skills/import-zip/parse', {
      method: 'POST',
      body: multipartParse(zip),
    })
    const body = (await res.json()) as {
      skills: Array<{ name: string; conflict?: string }>
    }
    expect(body.skills[0]!.conflict).toBe('managed')
  })
})

describe('POST /api/skills/import-zip/commit', () => {
  let h: H
  beforeEach(() => {
    h = build()
  })
  afterEach(() => h.cleanup())

  test('happy path imports all and lists them via GET /api/skills', async () => {
    const zip = makeZip({
      'skill-a/SKILL.md': skillMd('skill-a'),
      'skill-b/SKILL.md': skillMd('skill-b'),
    })
    const res = await req(h.app, '/api/skills/import-zip/commit', {
      method: 'POST',
      body: multipartCommit(zip, {
        'skill-a': { action: 'import' },
        'skill-b': { action: 'import' },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { created: Array<{ name: string }> }
    expect(body.created.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b'])

    const listRes = await req(h.app, '/api/skills')
    const list = (await listRes.json()) as Array<{ name: string }>
    expect(list.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b'])
  })

  test('missing decisions field → 422', async () => {
    const zip = makeZip({ 'skill-a/SKILL.md': skillMd('skill-a') })
    const fd = new FormData()
    fd.append('file', new Blob([zip]), 'pack.zip')
    const res = await req(h.app, '/api/skills/import-zip/commit', {
      method: 'POST',
      body: fd,
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('zip-decisions-missing')
  })

  test('decisions invalid JSON → 422', async () => {
    const zip = makeZip({ 'skill-a/SKILL.md': skillMd('skill-a') })
    const fd = new FormData()
    fd.append('file', new Blob([zip]), 'pack.zip')
    fd.append('decisions', '{not json}')
    const res = await req(h.app, '/api/skills/import-zip/commit', {
      method: 'POST',
      body: fd,
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('zip-decisions-invalid')
  })

  test('decisions schema mismatch → 422', async () => {
    const zip = makeZip({ 'skill-a/SKILL.md': skillMd('skill-a') })
    const res = await req(h.app, '/api/skills/import-zip/commit', {
      method: 'POST',
      body: multipartCommit(zip, { 'skill-a': { action: 'nonsense' } }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('zip-decisions-invalid')
  })

  test('parse → decide → commit end-to-end produces consistent results', async () => {
    const zip = makeZip({
      'one/SKILL.md': skillMd('one', 'one desc'),
      'two/SKILL.md': skillMd('two', 'two desc'),
      'bad-NAME/SKILL.md': skillMd('bad-NAME'), // invalid kebab-case
    })

    const parseRes = await req(h.app, '/api/skills/import-zip/parse', {
      method: 'POST',
      body: multipartParse(zip),
    })
    const parseBody = (await parseRes.json()) as {
      skills: Array<{ name: string }>
      errors: Array<{ code: string }>
    }
    expect(parseBody.skills.map((s) => s.name).sort()).toEqual(['one', 'two'])
    expect(parseBody.errors[0]!.code).toBe('skill-name-invalid')

    const decisions = parseBody.skills.reduce<Record<string, { action: string }>>((acc, s) => {
      acc[s.name] = { action: 'import' }
      return acc
    }, {})
    const commitRes = await req(h.app, '/api/skills/import-zip/commit', {
      method: 'POST',
      body: multipartCommit(zip, decisions),
    })
    const commitBody = (await commitRes.json()) as { created: Array<{ name: string }> }
    expect(commitBody.created.map((s) => s.name).sort()).toEqual(['one', 'two'])
  })
})
