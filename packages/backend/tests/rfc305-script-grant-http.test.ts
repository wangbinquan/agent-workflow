// RFC-305 actual capability journey: an existing user session gains and loses
// privileged workflow projection/authoring from current effective permissions.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { grantableAdditionalPermissions, ROLE_PERMISSIONS } from '@agent-workflow/shared'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { REDACTED } from '../src/services/tokenRedaction'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'd'.repeat(64)
const SCRIPT_BODY = 'echo current-authority'
const CODE_HOST_PATH = '/api/v4/projects/1/merge_requests/2/notes'

function privilegedDefinition(): Record<string, unknown> {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      {
        id: 'script',
        kind: 'script',
        language: 'bash',
        script: SCRIPT_BODY,
        dependencies: [],
        env: { MESSAGE: 'runtime-secret' },
      },
      {
        id: 'code-host',
        kind: 'code-host-call',
        provider: 'gitlab',
        action: 'custom',
        params: { project: 'group/project' },
        request: { method: 'POST', path: CODE_HOST_PATH, body: '{"body":"done"}' },
      },
    ],
    edges: [],
  }
}

async function request(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

function node(body: unknown, id: string): Record<string, unknown> {
  const definition = (body as { definition: { nodes: Array<Record<string, unknown>> } }).definition
  const found = definition.nodes.find((item) => item.id === id)
  if (found === undefined) throw new Error(`node ${id} missing`)
  return found
}

describe('RFC-305 scripts:author current-authority HTTP journey', () => {
  test('grant/revoke changes read and write immediately; all grants equal the admin preset', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = createApp({
      token: DAEMON_TOKEN,
      configPath: '',
      opencodeVersion: 'test',
      dbVersion: 162,
      db,
    })
    const admin = await createUser(db, {
      username: 'admin-rfc305',
      displayName: 'Admin RFC-305',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const user = await createUser(db, {
      username: 'author-rfc305',
      displayName: 'Author RFC-305',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const session = await createSession({ db, userId: user.id })
    const publicId = ulid()
    const privateId = ulid()
    await db.insert(workflows).values([
      {
        id: publicId,
        name: 'public-privileged-workflow',
        description: '',
        definition: JSON.stringify(privilegedDefinition()),
        ownerUserId: admin.id,
        visibility: 'public',
      },
      {
        id: privateId,
        name: 'private-privileged-workflow',
        description: '',
        definition: JSON.stringify(privilegedDefinition()),
        ownerUserId: admin.id,
        visibility: 'private',
      },
    ])

    const readPublic = async (): Promise<unknown> => {
      const response = await request(app, session.token, `/api/workflows/${publicId}`)
      expect(response.status).toBe(200)
      return response.json()
    }
    const before = await readPublic()
    expect(node(before, 'script').script).toBe(REDACTED)
    expect((node(before, 'code-host').request as Record<string, unknown>).path).toBe(REDACTED)

    const identity = composeIdentityAccess(db)
    const context = identity.contexts.fromAuthenticatedPrincipal(
      { userId: admin.id, source: 'session' },
      'http',
      1_000,
    )
    await identity.updateUserAccess.execute(context, {
      targetUserId: user.id,
      access: {
        role: 'user',
        additionalPermissions: ['scripts:author'],
        expectedRevision: 0,
      },
    })

    const scriptOnly = await readPublic()
    expect(node(scriptOnly, 'script').script).toBe(SCRIPT_BODY)
    expect((node(scriptOnly, 'code-host').request as Record<string, unknown>).path).toBe(REDACTED)

    const createWithScript = await request(app, session.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'user-script-workflow',
        description: '',
        definition: {
          $schema_version: 4,
          inputs: [],
          nodes: [{ id: 'script', kind: 'script', language: 'bash', script: SCRIPT_BODY }],
          edges: [],
        },
      }),
    })
    expect(createWithScript.status).toBe(201)

    const everyUserAddition = grantableAdditionalPermissions('user')
    await identity.updateUserAccess.execute(context, {
      targetUserId: user.id,
      access: {
        role: 'user',
        additionalPermissions: everyUserAddition,
        expectedRevision: 1,
      },
    })
    const both = await readPublic()
    expect(node(both, 'script').script).toBe(SCRIPT_BODY)
    expect((node(both, 'code-host').request as Record<string, unknown>).path).toBe(CODE_HOST_PATH)
    expect((await request(app, session.token, `/api/workflows/${privateId}`)).status).toBe(200)
    expect((await request(app, session.token, '/api/users')).status).toBe(200)
    expect((await request(app, session.token, '/api/memory-distill-jobs')).status).toBe(200)

    const meResponse = await request(app, session.token, '/api/auth/me')
    expect(meResponse.status).toBe(200)
    const me = (await meResponse.json()) as {
      user: { role: string }
      permissions: string[]
    }
    expect(me.user.role).toBe('user')
    expect(new Set(me.permissions)).toEqual(new Set(ROLE_PERMISSIONS.admin))

    await identity.updateUserAccess.execute(context, {
      targetUserId: user.id,
      access: { role: 'user', additionalPermissions: [], expectedRevision: 2 },
    })
    const revoked = await readPublic()
    expect(node(revoked, 'script').script).toBe(REDACTED)
    expect((node(revoked, 'code-host').request as Record<string, unknown>).path).toBe(REDACTED)
    expect((await request(app, session.token, `/api/workflows/${privateId}`)).status).toBe(404)
    expect((await request(app, session.token, '/api/users')).status).toBe(403)
    expect((await request(app, session.token, '/api/memory-distill-jobs')).status).toBe(403)

    const deniedCreate = await request(app, session.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'user-script-workflow-denied',
        description: '',
        definition: {
          $schema_version: 4,
          inputs: [],
          nodes: [{ id: 'script', kind: 'script', language: 'bash', script: 'echo denied' }],
          edges: [],
        },
      }),
    })
    expect(deniedCreate.status).toBe(403)
    expect(await deniedCreate.json()).toMatchObject({ code: 'script-author-forbidden' })
  })
})
