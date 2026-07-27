// RFC-159 T3 (PR-3b) — scheduled-task route visibility.
//
// Member-based-private like tasks: owner + tasks:read:all admin see the row;
// everyone else gets it filtered from the list AND a 404 on the detail route
// (invisible == missing, so existence can't be probed).
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { scheduledTasks } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  app: Hono
  db: DbClient
  adminToken: string
  bobToken: string
  carolToken: string
  bobSchedId: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'admin1',
    displayName: 'A',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const bob = await createUser(db, {
    username: 'bob',
    displayName: 'B',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const carol = await createUser(db, {
    username: 'carol',
    displayName: 'C',
    role: 'user',
    password: 'longEnoughPassword',
  })

  const bobSchedId = 'sched-bob'
  const now = Date.now()
  await db.insert(scheduledTasks).values({
    id: bobSchedId,
    name: 'bob nightly',
    ownerUserId: bob.id,
    launchPayload: JSON.stringify({
      workflowId: 'wf',
      name: 'n',
      repoPath: '/r',
      baseBranch: 'main',
    }),
    scheduleSpec: JSON.stringify({ kind: 'daily', at: '09:00', timezone: 'UTC' }),
    enabled: true,
    nextRunAt: now + 1000,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  })

  return {
    app,
    db,
    adminToken: (await createSession({ db, userId: admin.id })).token,
    bobToken: (await createSession({ db, userId: bob.id })).token,
    carolToken: (await createSession({ db, userId: carol.id })).token,
    bobSchedId,
  }
}

async function get(app: Hono, token: string, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } })
}

async function listIds(app: Hono, token: string): Promise<string[]> {
  const rows = (await (await get(app, token, '/api/scheduled-tasks')).json()) as Array<{
    id: string
  }>
  return rows.map((r) => r.id)
}

describe('RFC-159 — scheduled-task route visibility', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('list: owner sees own; stranger does not; admin sees all', async () => {
    expect(await listIds(h.app, h.bobToken)).toEqual([h.bobSchedId])
    expect(await listIds(h.app, h.carolToken)).toEqual([])
    expect(await listIds(h.app, h.adminToken)).toEqual([h.bobSchedId])
  })

  test('list projects only the minimum owner identity after visibility filtering', async () => {
    const ownerRows = (await (
      await get(h.app, h.bobToken, '/api/scheduled-tasks')
    ).json()) as Array<Record<string, unknown>>
    expect(ownerRows).toHaveLength(1)
    expect(ownerRows[0]?.['owner']).toEqual({
      id: expect.any(String),
      username: 'bob',
      displayName: 'B',
    })
    expect(Object.keys(ownerRows[0]?.['owner'] as object).sort()).toEqual([
      'displayName',
      'id',
      'username',
    ])

    const strangerRows = (await (
      await get(h.app, h.carolToken, '/api/scheduled-tasks')
    ).json()) as unknown[]
    expect(strangerRows).toEqual([])
  })

  test('detail: owner 200, admin 200, stranger 404 (invisible == missing)', async () => {
    expect((await get(h.app, h.bobToken, `/api/scheduled-tasks/${h.bobSchedId}`)).status).toBe(200)
    expect((await get(h.app, h.adminToken, `/api/scheduled-tasks/${h.bobSchedId}`)).status).toBe(
      200,
    )
    expect((await get(h.app, h.carolToken, `/api/scheduled-tasks/${h.bobSchedId}`)).status).toBe(
      404,
    )
  })

  test('stranger cannot modify (PUT/DELETE → 404, not found)', async () => {
    const put = await h.app.request(`/api/scheduled-tasks/${h.bobSchedId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${h.carolToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(put.status).toBe(404)
    const del = await h.app.request(`/api/scheduled-tasks/${h.bobSchedId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${h.carolToken}` },
    })
    expect(del.status).toBe(404)
  })
})
