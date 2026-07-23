// RFC-223 PR-7 — the canonical resource surface is id-only.
//
// Locks all four migrated resource types:
//   - GET /api/{type}/:id returns the exact row;
//   - the old mutable-name URL and retired /by-id resolver both return 404;
//   - visibility is checked on that exact id before ACL/mutation behavior;
//   - rename keeps the canonical id URL stable.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps, skills, workgroups } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

type ResourceCase = {
  base: 'agents' | 'skills' | 'mcps' | 'workgroups'
  id: string
  name: string
}

describe('RFC-223 PR-7 — canonical id resource routes', () => {
  let db: DbClient
  let app: Hono
  let alice: { id: string; token: string }
  let bob: { id: string; token: string }
  let resources: ResourceCase[]

  async function mkUser(username: string) {
    const user = await createUser(db, {
      username,
      displayName: username,
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: user.id })
    return { id: user.id, token }
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
      configPath: '/tmp/aw-rfc223-pr7-config-never-used.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    alice = await mkUser('alice')
    bob = await mkUser('bob')

    resources = [
      { base: 'agents', id: ulid(), name: 'route-agent' },
      { base: 'skills', id: ulid(), name: 'route-skill' },
      { base: 'mcps', id: ulid(), name: 'route-mcp' },
      { base: 'workgroups', id: ulid(), name: 'route-workgroup' },
    ]
    const [agent, skill, mcp, group] = resources
    await db.insert(agents).values({
      id: agent!.id,
      name: agent!.name,
      ownerUserId: alice.id,
    })
    await db.insert(skills).values({
      id: skill!.id,
      name: skill!.name,
      sourceKind: 'managed',
      managedPath: `skills/${skill!.id}/files/`,
      ownerUserId: alice.id,
    })
    await db.insert(mcps).values({
      id: mcp!.id,
      name: mcp!.name,
      type: 'local',
      config: JSON.stringify({ command: ['echo'] }),
      ownerUserId: alice.id,
    })
    await db.insert(workgroups).values({
      id: group!.id,
      name: group!.name,
      ownerUserId: alice.id,
    })
  })

  test('all four detail endpoints accept only the immutable id', async () => {
    for (const resource of resources) {
      const canonical = await req(alice.token, `/api/${resource.base}/${resource.id}`)
      expect(canonical.status).toBe(200)
      expect(((await canonical.json()) as { id: string }).id).toBe(resource.id)

      const oldName = await req(alice.token, `/api/${resource.base}/${resource.name}`)
      expect(oldName.status).toBe(404)

      const retiredResolver = await req(alice.token, `/api/${resource.base}/by-id/${resource.id}`)
      expect(retiredResolver.status).toBe(404)

      if (resource.base === 'skills') {
        for (const suffix of ['', '/content']) {
          const retiredNameWrite = await req(alice.token, `/api/skills/${resource.name}${suffix}`, {
            method: 'PUT',
            body: JSON.stringify({ description: 'must-not-resolve-by-name' }),
          })
          expect(retiredNameWrite.status).toBe(404)
          const canonicalGone = await req(alice.token, `/api/skills/${resource.id}${suffix}`, {
            method: 'PUT',
            body: JSON.stringify({ description: 'retired' }),
          })
          expect(canonicalGone.status).toBe(410)
          expect(((await canonicalGone.json()) as { code: string }).code).toBe(
            'skill-endpoint-gone',
          )
        }
      }
    }
  })

  test('ACL lookup is bound to the exact id and preserves D1 not-found parity', async () => {
    for (const resource of resources) {
      const privateResult = await req(alice.token, `/api/${resource.base}/${resource.id}/acl`, {
        method: 'PUT',
        body: JSON.stringify({
          visibility: 'private',
          expectedResourceId: resource.id,
          expectedAclRevision: 0,
        }),
      })
      expect(privateResult.status).toBe(200)

      const invisible = await req(bob.token, `/api/${resource.base}/${resource.id}`)
      const missing = await req(bob.token, `/api/${resource.base}/${ulid()}`)
      expect(invisible.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(((await invisible.json()) as { code: string }).code).toBe(
        ((await missing.json()) as { code: string }).code,
      )

      // Visibility is checked before ownership/mutation on the same row.
      const hiddenAclWrite = await req(bob.token, `/api/${resource.base}/${resource.id}/acl`, {
        method: 'PUT',
        body: JSON.stringify({
          visibility: 'public',
          expectedResourceId: resource.id,
          expectedAclRevision: 1,
        }),
      })
      expect(hiddenAclWrite.status).toBe(404)
    }
  })

  test('rename changes display name without changing the canonical URL', async () => {
    for (const resource of resources.filter((row) => row.base !== 'skills')) {
      const current = (await (
        await req(alice.token, `/api/${resource.base}/${resource.id}`)
      ).json()) as {
        version?: number
        updatedAt?: number
        aclRevision?: number
        operationConfigHash?: string
      }
      const renameBody =
        resource.base === 'workgroups'
          ? {
              newName: `${resource.name}-renamed`,
              expectedVersion: current.version,
              clientMutationId: ulid(),
            }
          : resource.base === 'agents'
            ? {
                newName: `${resource.name}-renamed`,
                expectedUpdatedAt: current.updatedAt,
                expectedAclRevision: current.aclRevision ?? 0,
              }
            : {
                newName: `${resource.name}-renamed`,
                expectedConfigHash: current.operationConfigHash,
              }
      const renamed = await req(alice.token, `/api/${resource.base}/${resource.id}/rename`, {
        method: 'POST',
        body: JSON.stringify(renameBody),
      })
      expect(renamed.status).toBe(200)
      const payload = (await renamed.json()) as {
        id?: string
        name?: string
        workgroup?: { id: string; name: string }
      }
      expect(resource.base === 'workgroups' ? payload.workgroup : payload).toMatchObject({
        id: resource.id,
        name: `${resource.name}-renamed`,
      })
      expect((await req(alice.token, `/api/${resource.base}/${resource.id}`)).status).toBe(200)
      expect(
        (await req(alice.token, `/api/${resource.base}/${resource.name}-renamed`)).status,
      ).toBe(404)
    }
  })
})
