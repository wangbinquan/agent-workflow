// RFC-099 B3 — task members endpoints + launch-time gates over HTTP:
//   - POST /api/tasks rejects the removed `assignments` field with 422
//     `assignments-removed` (Breaking for automation, called out in release notes)
//   - launching demands the WORKFLOW be visible to the launcher (D3): a
//     private workflow 404s identically to a missing one
//   - GET/PUT /api/tasks/:id/members: visible-to-members read, owner/admin
//     writes, owner transfer keeps the previous owner as collaborator
//   - task users hold operational rights (D13): a collaborator may cancel

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskCollaborators, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  alice: { id: string; token: string }
  carol: { id: string; token: string }
  dave: { id: string; token: string }
  admin: { id: string; token: string }
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  async function mk(username: string, role: 'admin' | 'user') {
    const u = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }
  return {
    db,
    app,
    alice: await mk('alice', 'user'),
    carol: await mk('carol', 'user'),
    dave: await mk('dave', 'user'),
    admin: await mk('root', 'admin'),
  }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

async function seedTask(h: Harness, ownerId: string, collaboratorIds: string[]): Promise<string> {
  const workflowId = ulid()
  await h.db.insert(workflows).values({ id: workflowId, name: 'wf', definition: '{}' })
  const taskId = ulid()
  await h.db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    ownerUserId: ownerId,
  })
  await h.db.insert(taskCollaborators).values([
    { taskId, userId: ownerId, role: 'owner', addedBy: ownerId, addedAt: Date.now() },
    ...collaboratorIds.map((userId) => ({
      taskId,
      userId,
      role: 'collaborator' as const,
      addedBy: ownerId,
      addedAt: Date.now(),
    })),
  ])
  return taskId
}

describe('RFC-099 — POST /api/tasks gates', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('payload still carrying assignments → 422 assignments-removed', async () => {
    const res = await req(h.app, h.alice.token, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: 't',
        workflowId: 'whatever',
        repoPath: '/tmp/x',
        inputs: {},
        assignments: [{ nodeId: 'n1', kind: 'reviewer', userId: 'u1' }],
      }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('assignments-removed')
  })

  test('private workflow: launch 404s identically to a missing workflow (D3)', async () => {
    const created = await req(h.app, h.alice.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'private-flow',
        description: '',
        definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
      }),
    })
    const wf = (await created.json()) as { id: string }
    await req(h.app, h.alice.token, `/api/workflows/${wf.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'private' }),
    })
    const launchBody = (workflowId: string) =>
      JSON.stringify({ name: 't', workflowId, repoUrl: 'file:///tmp/x', ref: 'main', inputs: {} })
    const invisible = await req(h.app, h.dave.token, '/api/tasks', {
      method: 'POST',
      body: launchBody(wf.id),
    })
    const missing = await req(h.app, h.dave.token, '/api/tasks', {
      method: 'POST',
      body: launchBody('01HNOPE000000000000000000000'),
    })
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(((await invisible.json()) as { code: string }).code).toBe(
      ((await missing.json()) as { code: string }).code,
    )
  })
})

describe('RFC-099 — task members endpoints + member operational rights', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('members GET visible to members; stranger 403; PUT owner/admin only', async () => {
    const taskId = await seedTask(h, h.alice.id, [h.carol.id])
    const asCarol = (await (
      await req(h.app, h.carol.token, `/api/tasks/${taskId}/members`)
    ).json()) as {
      ownerUserId: string
      users: Array<{ id: string }>
      canManage: boolean
    }
    expect(asCarol.ownerUserId).toBe(h.alice.id)
    expect(asCarol.users.map((u) => u.id)).toEqual([h.carol.id])
    expect(asCarol.canManage).toBe(false)
    // stranger blocked by the task visibility middleware
    expect((await req(h.app, h.dave.token, `/api/tasks/${taskId}/members`)).status).toBe(403)
    // collaborator cannot PUT
    expect(
      (
        await req(h.app, h.carol.token, `/api/tasks/${taskId}/members`, {
          method: 'PUT',
          body: JSON.stringify({ userIds: [h.dave.id] }),
        })
      ).status,
    ).toBe(403)
    // owner adds dave
    const put = await req(h.app, h.alice.token, `/api/tasks/${taskId}/members`, {
      method: 'PUT',
      body: JSON.stringify({ userIds: [h.carol.id, h.dave.id] }),
    })
    expect(put.status).toBe(200)
    const after = (await put.json()) as { users: Array<{ id: string }> }
    expect(after.users.map((u) => u.id).sort()).toEqual([h.carol.id, h.dave.id].sort())
    // dave can now see the task
    expect((await req(h.app, h.dave.token, `/api/tasks/${taskId}`)).status).toBe(200)
  })

  test('owner transfer via members PUT keeps previous owner as collaborator', async () => {
    const taskId = await seedTask(h, h.alice.id, [])
    const put = await req(h.app, h.admin.token, `/api/tasks/${taskId}/members`, {
      method: 'PUT',
      body: JSON.stringify({ ownerUserId: h.carol.id }),
    })
    expect(put.status).toBe(200)
    const body = (await put.json()) as { ownerUserId: string; users: Array<{ id: string }> }
    expect(body.ownerUserId).toBe(h.carol.id)
    expect(body.users.map((u) => u.id)).toContain(h.alice.id)
  })

  test('collaborator may cancel the task (D13 user-equal operational rights)', async () => {
    const taskId = await seedTask(h, h.alice.id, [h.carol.id])
    const res = await req(h.app, h.carol.token, `/api/tasks/${taskId}/cancel`, { method: 'POST' })
    expect(res.status).toBe(200)
    const stranger = await req(h.app, h.dave.token, `/api/tasks/${taskId}/cancel`, {
      method: 'POST',
    })
    expect(stranger.status).toBe(403)
  })
})
