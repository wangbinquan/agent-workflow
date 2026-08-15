// RFC-305 guest journey: a role is only a permission preset. The default guest
// can read public ACL resources, cannot observe private owner/grant rows, and
// cannot create resources or use the task surface. Granting the private range
// changes only that capability while the persisted role remains `guest`.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { ROLE_PERMISSIONS } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb } from '../src/db/client'
import { agents, resourceGrants } from '../src/db/schema'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = '7'.repeat(64)

async function request(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

describe('RFC-305 guest public-read-only access', () => {
  test('default preset is public-only and an explicit grant widens only private visibility', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = createApp({
      token: DAEMON_TOKEN,
      configPath: '',
      opencodeVersion: 'test',
      dbVersion: 162,
      db,
    })
    const admin = await createUser(db, {
      username: 'guest-test-admin',
      displayName: 'Guest Test Admin',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const guest = await createUser(db, {
      username: 'oauth-guest',
      displayName: 'OAuth Guest',
      role: 'guest',
      password: 'longEnoughPassword',
    })
    const session = await createSession({ db, userId: guest.id })
    const publicId = ulid()
    const privateId = ulid()
    await db.insert(agents).values([
      {
        id: publicId,
        name: 'public-agent-for-guest',
        ownerUserId: admin.id,
        visibility: 'public',
      },
      {
        id: privateId,
        name: 'private-agent-for-guest',
        ownerUserId: admin.id,
        visibility: 'private',
      },
    ])
    // A resource grant alone must not punch through the guest preset.
    await db.insert(resourceGrants).values({
      resourceType: 'agent',
      resourceId: privateId,
      userId: guest.id,
      addedBy: admin.id,
      addedAt: Date.now(),
    })

    const meBeforeResponse = await request(app, session.token, '/api/auth/me')
    expect(meBeforeResponse.status).toBe(200)
    const meBefore = (await meBeforeResponse.json()) as {
      user: { role: string }
      permissions: string[]
    }
    expect(meBefore.user.role).toBe('guest')
    expect(new Set(meBefore.permissions)).toEqual(new Set(ROLE_PERMISSIONS.guest))

    const listBeforeResponse = await request(app, session.token, '/api/agents')
    expect(listBeforeResponse.status).toBe(200)
    const listBefore = (await listBeforeResponse.json()) as Array<{ id: string }>
    expect(listBefore.map((agent) => agent.id)).toContain(publicId)
    expect(listBefore.map((agent) => agent.id)).not.toContain(privateId)
    expect((await request(app, session.token, `/api/agents/${publicId}`)).status).toBe(200)
    expect((await request(app, session.token, `/api/agents/${privateId}`)).status).toBe(404)

    const deniedCreate = await request(app, session.token, '/api/agents', {
      method: 'POST',
      body: '{}',
    })
    expect(deniedCreate.status).toBe(403)
    expect(await deniedCreate.json()).toMatchObject({ code: 'forbidden' })
    expect((await request(app, session.token, '/api/tasks')).status).toBe(403)
    expect(
      (
        await request(app, session.token, '/api/tasks', {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect((await request(app, session.token, '/api/cached-repos')).status).toBe(403)

    const identity = composeIdentityAccess(db)
    const context = identity.contexts.fromAuthenticatedPrincipal(
      { userId: admin.id, source: 'session' },
      'http',
      1_000,
    )
    await identity.updateUserAccess.execute(context, {
      targetUserId: guest.id,
      access: {
        role: 'guest',
        additionalPermissions: ['resource-acl:private'],
        expectedRevision: 0,
      },
    })

    const meAfterResponse = await request(app, session.token, '/api/auth/me')
    expect(meAfterResponse.status).toBe(200)
    const meAfter = (await meAfterResponse.json()) as {
      user: { role: string }
      permissions: string[]
    }
    expect(meAfter.user.role).toBe('guest')
    expect(meAfter.permissions).toContain('resource-acl:private')
    expect(meAfter.permissions).not.toContain('agents:create')

    const listAfterResponse = await request(app, session.token, '/api/agents')
    expect(listAfterResponse.status).toBe(200)
    const listAfter = (await listAfterResponse.json()) as Array<{ id: string }>
    expect(listAfter.map((agent) => agent.id)).toContain(privateId)
    expect((await request(app, session.token, `/api/agents/${privateId}`)).status).toBe(200)
    expect(
      (
        await request(app, session.token, '/api/agents', {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(403)
  })
})
