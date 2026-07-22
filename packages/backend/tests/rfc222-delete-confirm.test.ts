// RFC-222 (C 线, D5) — type-to-confirm delete gate.
//
//   C-1  assertDeleteConfirm / readDeleteBody unit semantics
//   C-2  endpoint matrix: missing confirm → 422, wrong → 422 (row survives),
//        correct → deleted. Covers a :name route (agents), a :id-with-schema
//        route (workflows), and the exclusive-section route (mcps).
//   C-3  rename TOCTOU: delete with the OLD name after a rename → mismatch.
//   G-2  coverage guard: every resource/task DELETE handler calls the gate.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { assertDeleteConfirm, readDeleteBody } from '../src/services/deleteConfirm'
import { createUser } from '../src/services/users'
import { ValidationError } from '../src/util/errors'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// ---------------------------------------------------------------------------
// C-1 — helper unit
// ---------------------------------------------------------------------------
describe('RFC-222 C-1 — assertDeleteConfirm', () => {
  const ok = (body: unknown) => assertDeleteConfirm(body, 'foo', 'agent')

  test('missing body / no confirm / non-string → delete-confirm-required', () => {
    for (const bad of [undefined, null, {}, { confirm: 1 }, { confirm: null }, 'foo']) {
      try {
        ok(bad)
        throw new Error(`expected throw for ${JSON.stringify(bad)}`)
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError)
        expect((e as ValidationError).code).toBe('delete-confirm-required')
      }
    }
  })

  test('case / whitespace mismatch → delete-confirm-mismatch (no normalization)', () => {
    for (const bad of ['Foo', 'FOO', ' foo', 'foo ', 'fo', 'foobar']) {
      try {
        ok({ confirm: bad })
        throw new Error(`expected mismatch for "${bad}"`)
      } catch (e) {
        expect((e as ValidationError).code).toBe('delete-confirm-mismatch')
      }
    }
  })

  test('exact match passes', () => {
    expect(() => ok({ confirm: 'foo' })).not.toThrow()
  })

  test('mismatch error meta carries resourceType', () => {
    try {
      assertDeleteConfirm({ confirm: 'x' }, 'foo', 'workflow')
    } catch (e) {
      expect((e as ValidationError).details).toMatchObject({ resourceType: 'workflow' })
    }
  })
})

describe('RFC-222 C-1 — readDeleteBody', () => {
  function ctxWith(text: string): Parameters<typeof readDeleteBody>[0] {
    // Minimal shim: readDeleteBody only touches c.req.text().
    return { req: { text: async () => text } } as never
  }
  test('empty / whitespace body → {} (→ confirm-required downstream)', async () => {
    expect(await readDeleteBody(ctxWith(''))).toEqual({})
    expect(await readDeleteBody(ctxWith('   \n'))).toEqual({})
  })
  test('valid JSON passes through', async () => {
    expect(await readDeleteBody(ctxWith('{"confirm":"x"}'))).toEqual({ confirm: 'x' })
  })
  test('malformed JSON → invalid-json', async () => {
    await expect(readDeleteBody(ctxWith('{not json'))).rejects.toMatchObject({
      code: 'invalid-json',
    })
  })
})

// ---------------------------------------------------------------------------
// C-2 / C-3 — endpoint matrix
// ---------------------------------------------------------------------------
interface H {
  db: DbClient
  app: Hono
  token: string
}
async function harness(): Promise<H> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'root',
    displayName: 'Root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: admin.id })
  return { db, app, token }
}
async function req(h: H, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${h.token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return h.app.request(path, { ...init, headers })
}

describe('RFC-222 C-2 — agents DELETE confirm matrix', () => {
  let h: H
  beforeEach(async () => {
    h = await harness()
    await req(h, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'secret', instructions: 'x' }),
    })
  })

  test('missing confirm → 422 delete-confirm-required, agent survives', async () => {
    const res = await req(h, '/api/agents/secret', { method: 'DELETE' })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('delete-confirm-required')
    expect((await req(h, '/api/agents/secret')).status).toBe(200)
  })

  test('wrong confirm → 422 delete-confirm-mismatch, agent survives', async () => {
    const res = await req(h, '/api/agents/secret', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'Secret' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('delete-confirm-mismatch')
    expect((await req(h, '/api/agents/secret')).status).toBe(200)
  })

  test('correct confirm → 204, agent gone', async () => {
    const res = await req(h, '/api/agents/secret', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'secret' }),
    })
    expect(res.status).toBe(204)
    expect((await req(h, '/api/agents/secret')).status).toBe(404)
  })

  test('missing resource → 404 before confirm (N-5 order)', async () => {
    const res = await req(h, '/api/agents/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('RFC-222 C-3 — rename TOCTOU caught by name mismatch', () => {
  test('deleting with the pre-rename name → mismatch (agent survives)', async () => {
    const h = await harness()
    await req(h, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'old', instructions: 'x' }),
    })
    await req(h, '/api/agents/old/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'newname' }),
    })
    // The dialog opened as "old"; the resource is now "newname".
    const res = await req(h, '/api/agents/newname', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'old' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('delete-confirm-mismatch')
    expect((await req(h, '/api/agents/newname')).status).toBe(200)
  })
})

describe('RFC-222 C-2 — workflows DELETE (schema path) confirms against row name', () => {
  test('wrong confirm → 422; correct name → 204', async () => {
    const h = await harness()
    const createRes = await req(h, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'wf-alpha',
        definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
      }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { id: string; version: number; name: string }

    const wrong = await req(h, `/api/workflows/${created.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        expectedVersion: created.version,
        clientMutationId: ulid(),
        confirm: created.id, // id ≠ name → mismatch
      }),
    })
    expect(wrong.status).toBe(422)
    expect(((await wrong.json()) as { code: string }).code).toBe('delete-confirm-mismatch')

    const ok = await req(h, `/api/workflows/${created.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        expectedVersion: created.version,
        clientMutationId: ulid(),
        confirm: 'wf-alpha',
      }),
    })
    expect(ok.status).toBe(204)
  })
})

// ---------------------------------------------------------------------------
// G-2 — coverage guard: every resource/task DELETE handler is gated
// ---------------------------------------------------------------------------
describe('RFC-222 G-2 — every destructive DELETE handler calls the confirm gate', () => {
  const ROUTES_DIR = resolve(import.meta.dir, '..', 'src', 'routes')
  // (file, the DELETE path that must be confirm-gated)
  const GATED: Array<[string, RegExp]> = [
    ['agents.ts', /app\.delete\('\/api\/agents\/:name'/],
    ['skills.ts', /app\.delete\('\/api\/skills\/:name'/],
    ['mcps.ts', /app\.delete\('\/api\/mcps\/:name'/],
    ['plugins.ts', /app\.delete\('\/api\/plugins\/:id'/],
    ['workgroups.ts', /app\.delete\('\/api\/workgroups\/:name'/],
    ['workflows.ts', /app\.delete\('\/api\/workflows\/:id'/],
    ['tasks.ts', /app\.delete\('\/api\/tasks\/:id'/], // PR-3 lights this up
  ]

  for (const [file, deleteRe] of GATED) {
    test(`${file} DELETE handler references assertDeleteConfirm`, () => {
      const src = readFileSync(resolve(ROUTES_DIR, file), 'utf8')
      // The handler must exist AND the file must call the confirm gate. Coarse
      // but effective: if a future edit drops the gate, the file stops mentioning
      // assertDeleteConfirm and this reds. (tasks.ts arrives in PR-3.)
      if (!deleteRe.test(src)) {
        // tasks.ts DELETE lands in PR-3 — tolerate its absence until then, but
        // the moment the handler exists it MUST be gated.
        if (file === 'tasks.ts') return
        throw new Error(`${file}: expected a gated DELETE handler matching ${deleteRe}`)
      }
      expect(src.includes('assertDeleteConfirm')).toBe(true)
    })
  }
})
