// RFC-045 — HTTP layer for PATCH /api/memories/:id.
//
// Covers permission gate (memory:edit on admin only), 422 / 404 / 409 /
// 200 paths, idempotent re-save, and the RFC-046 invariant: PATCH must NOT
// touch any node_runs.injected_memories_json column (historical inject
// snapshots are frozen; admin edits only affect future inject reads).

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { createManualCandidate, promoteCandidate, archiveMemory } from '../src/services/memory'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { Memory } from '@agent-workflow/shared'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  daemonToken: string
  adminUserToken: string
  regularUserToken: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const user = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const adminUserToken = (await createSession({ db, userId: admin.id })).token
  const regularUserToken = (await createSession({ db, userId: user.id })).token
  return { db, app, daemonToken: DAEMON_TOKEN, adminUserToken, regularUserToken }
}

function authed(token: string, init: RequestInit & { url: string }): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return new Request(`http://localhost${init.url}`, { ...init, headers })
}

describe('PATCH /api/memories/:id — RFC-045', () => {
  let h: Harness
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
  })

  test('regular user → 403 permission-denied', async () => {
    const seed = await createManualCandidate(h.db, {
      scopeType: 'global',
      scopeId: null,
      title: 't',
      bodyMd: 'b',
    })
    const res = await h.app.fetch(
      authed(h.regularUserToken, {
        url: `/api/memories/${encodeURIComponent(seed.id)}`,
        method: 'PATCH',
        body: JSON.stringify({ title: 'nope' }),
      }),
    )
    expect(res.status).toBe(403)
  })

  test('admin happy path → 200 + version bump + changedFields', async () => {
    const seed = await createManualCandidate(h.db, {
      scopeType: 'global',
      scopeId: null,
      title: 'orig',
      bodyMd: 'body',
    })
    const res = await h.app.fetch(
      authed(h.adminUserToken, {
        url: `/api/memories/${encodeURIComponent(seed.id)}`,
        method: 'PATCH',
        body: JSON.stringify({ title: 'renamed', tags: ['x', 'y'] }),
      }),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { memory: Memory; changedFields: string[] }
    expect(j.memory.title).toBe('renamed')
    expect(j.memory.tags).toEqual(['x', 'y'])
    expect(j.memory.version).toBe(2)
    expect(new Set(j.changedFields)).toEqual(new Set(['title', 'tags']))
  })

  test('empty patch body → 422 invalid-body', async () => {
    const seed = await createManualCandidate(h.db, {
      scopeType: 'global',
      scopeId: null,
      title: 't',
      bodyMd: 'b',
    })
    const res = await h.app.fetch(
      authed(h.adminUserToken, {
        url: `/api/memories/${encodeURIComponent(seed.id)}`,
        method: 'PATCH',
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(422)
    const j = (await res.json()) as { code: string }
    expect(j.code).toBe('invalid-body')
  })

  test('unknown id → 404 memory-not-found', async () => {
    const res = await h.app.fetch(
      authed(h.adminUserToken, {
        url: '/api/memories/01HXX-nonexistent',
        method: 'PATCH',
        body: JSON.stringify({ title: 'x' }),
      }),
    )
    expect(res.status).toBe(404)
    const j = (await res.json()) as { code: string }
    expect(j.code).toBe('memory-not-found')
  })

  test('rejected row → 409 memory-terminal-status', async () => {
    const seed = await createManualCandidate(h.db, {
      scopeType: 'global',
      scopeId: null,
      title: 'doomed',
      bodyMd: 'b',
    })
    await promoteCandidate(h.db, seed.id, { action: 'reject' }, 'admin')
    const res = await h.app.fetch(
      authed(h.adminUserToken, {
        url: `/api/memories/${encodeURIComponent(seed.id)}`,
        method: 'PATCH',
        body: JSON.stringify({ title: 'no' }),
      }),
    )
    expect(res.status).toBe(409)
    const j = (await res.json()) as { code: string }
    expect(j.code).toBe('memory-terminal-status')
  })

  test('archived row PATCH succeeds (status preserved)', async () => {
    const seed = await createManualCandidate(h.db, {
      scopeType: 'agent',
      scopeId: 'agent-a',
      title: 'orig',
      bodyMd: 'b',
    })
    await promoteCandidate(h.db, seed.id, { action: 'approve' }, 'admin')
    await archiveMemory(h.db, seed.id)
    const res = await h.app.fetch(
      authed(h.adminUserToken, {
        url: `/api/memories/${encodeURIComponent(seed.id)}`,
        method: 'PATCH',
        body: JSON.stringify({ title: 'edited while archived' }),
      }),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { memory: Memory }
    expect(j.memory.status).toBe('archived')
    expect(j.memory.title).toBe('edited while archived')
  })

  test('synth violates schema (scopeType→global, scopeId not cleared) → 422', async () => {
    const seed = await createManualCandidate(h.db, {
      scopeType: 'agent',
      scopeId: 'agent-a',
      title: 't',
      bodyMd: 'b',
    })
    const res = await h.app.fetch(
      authed(h.adminUserToken, {
        url: `/api/memories/${encodeURIComponent(seed.id)}`,
        method: 'PATCH',
        body: JSON.stringify({ scopeType: 'global' }),
      }),
    )
    expect(res.status).toBe(422)
  })

  test('idempotent re-save → 200 + changedFields=[] + version unchanged', async () => {
    const seed = await createManualCandidate(h.db, {
      scopeType: 'global',
      scopeId: null,
      title: 'same',
      bodyMd: 'same body',
    })
    const res = await h.app.fetch(
      authed(h.adminUserToken, {
        url: `/api/memories/${encodeURIComponent(seed.id)}`,
        method: 'PATCH',
        body: JSON.stringify({ title: 'same', bodyMd: 'same body' }),
      }),
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { memory: Memory; changedFields: string[] }
    expect(j.changedFields).toEqual([])
    expect(j.memory.version).toBe(seed.version)
  })

  test('RFC-046 invariant: PATCH does NOT touch node_runs.injected_memories_json', async () => {
    const seed = await createManualCandidate(h.db, {
      scopeType: 'global',
      scopeId: null,
      title: 'orig',
      bodyMd: 'b',
    })
    await promoteCandidate(h.db, seed.id, { action: 'approve' }, 'admin')

    // Seed a fake node_runs row carrying an injected_memories_json snapshot
    // that includes a record of the memory at its v1 state. PATCHing the
    // memory must NOT rewrite this historical column.
    const workflowId = ulid()
    await h.db.insert(workflows).values({
      id: workflowId,
      name: 'wf-test',
      description: '',
      definition: '{}',
      version: 1,
      schemaVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const taskId = ulid()
    await h.db.insert(tasks).values({
      id: taskId,
      name: 'task-rfc045-test',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw-test',
      worktreePath: '/tmp/aw-test-wt',
      baseBranch: 'main',
      branch: 'agent-workflow/test',
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    const nodeRunId = ulid()
    const snapshotJsonBefore = JSON.stringify([
      {
        id: seed.id,
        version: 1,
        scopeType: 'global',
        scopeId: null,
        title: 'orig',
        bodyMd: 'b',
        tags: [],
        sourceKind: 'manual',
        approvedAt: Date.now(),
      },
    ])
    await h.db.insert(nodeRuns).values({
      id: nodeRunId,
      taskId,
      nodeId: 'n1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: 0,
      status: 'done',
      injectedMemoriesJson: snapshotJsonBefore,
    })

    // PATCH the memory's title + body — every field a runtime injector
    // would care about.
    const res = await h.app.fetch(
      authed(h.adminUserToken, {
        url: `/api/memories/${encodeURIComponent(seed.id)}`,
        method: 'PATCH',
        body: JSON.stringify({ title: 'edited', bodyMd: 'edited body' }),
      }),
    )
    expect(res.status).toBe(200)

    const rows = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId))) as Array<{
      injectedMemoriesJson: string | null
    }>
    expect(rows.length).toBe(1)
    // Byte-equal: the historical snapshot is frozen by RFC-046 design.
    expect(rows[0]!.injectedMemoriesJson).toBe(snapshotJsonBefore)
  })
})
