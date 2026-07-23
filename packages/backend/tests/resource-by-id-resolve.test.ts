// RFC-177 — GET /api/workgroups/by-id/:id + GET /api/agents/by-id/:id.
//
// These resolvers turn a task's FROZEN stable id (workgroupId / sourceAgentId)
// into the resource's CURRENT name so the /tasks subject link redirects to the
// right resource even after a rename (and never opens a same-named replacement).
// Locks:
//   - owner resolves id → { name } (payload is ONLY the name — no live state);
//   - after a rename, by-id resolves to the NEW name (the whole point);
//   - a private resource is 404 to a stranger, identical to a missing id (D1);
//   - the two-segment path never shadows /:name (a resource named "by-id" is fine).

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

function agentBody(name: string): Record<string, unknown> {
  return {
    name,
    description: 'sample',
    outputs: [],
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    permission: {},
    bodyMd: '',
  }
}

describe('RFC-177 — by-id resource resolvers', () => {
  let db: DbClient
  let app: Hono
  let alice: { id: string; token: string }
  let bob: { id: string; token: string }

  async function mkUser(username: string) {
    const u = await createUser(db, {
      username,
      displayName: username,
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }

  async function req(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    return app.request(path, { ...init, headers })
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({
      token: DAEMON_TOKEN,
      configPath: '/tmp/aw-rfc177-config-never-used.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    alice = await mkUser('alice')
    bob = await mkUser('bob')
  })

  test('workgroup: by-id resolves current name, survives rename, private→404 (D1)', async () => {
    const created = (await (
      await req(alice.token, '/api/workgroups', {
        method: 'POST',
        body: JSON.stringify({ name: 'design-crew' }),
      })
    ).json()) as { id: string; name: string; version: number }
    expect(created.name).toBe('design-crew')

    const r1 = await req(alice.token, `/api/workgroups/by-id/${created.id}`)
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ name: 'design-crew' })

    // The whole point: after a rename, by-id still resolves — to the NEW name.
    const renamed = await req(alice.token, '/api/workgroups/design-crew/rename', {
      method: 'POST',
      body: JSON.stringify({
        newName: 'design-crew-v2',
        expectedVersion: created.version,
        clientMutationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    })
    expect(renamed.status).toBe(200)
    const r2 = await req(alice.token, `/api/workgroups/by-id/${created.id}`)
    expect(await r2.json()).toEqual({ name: 'design-crew-v2' })

    // Private → stranger 404, identical to a missing id (D1: existence never leaks).
    await req(alice.token, '/api/workgroups/design-crew-v2/acl', {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'private' }),
    })
    const invisible = await req(bob.token, `/api/workgroups/by-id/${created.id}`)
    const missing = await req(bob.token, '/api/workgroups/by-id/01MISSINGIDDOESNOTEXIST00')
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(((await invisible.json()) as { code: string }).code).toBe(
      ((await missing.json()) as { code: string }).code,
    )
  })

  test('a group literally named "by-id" still resolves at /:name (arity-distinct)', async () => {
    await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify({ name: 'by-id' }),
    })
    const res = await req(alice.token, '/api/workgroups/by-id')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }).name).toBe('by-id')
  })

  test('agent: by-id resolves current name, survives rename, private→404', async () => {
    const created = (await (
      await req(alice.token, '/api/agents', {
        method: 'POST',
        body: JSON.stringify(agentBody('coder')),
      })
    ).json()) as { id: string; name: string }
    expect(created.name).toBe('coder')

    const r1 = await req(alice.token, `/api/agents/by-id/${created.id}`)
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ name: 'coder' })

    await req(alice.token, '/api/agents/coder/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'coder-v2' }),
    })
    const r2 = await req(alice.token, `/api/agents/by-id/${created.id}`)
    expect(await r2.json()).toEqual({ name: 'coder-v2' })

    await req(alice.token, '/api/agents/coder-v2/acl', {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'private' }),
    })
    expect((await req(bob.token, `/api/agents/by-id/${created.id}`)).status).toBe(404)
    expect((await req(bob.token, '/api/agents/by-id/01MISSINGIDDOESNOTEXIST00')).status).toBe(404)
  })
})
