// Locks in the RFC-099 permission audit (2026-07-15) fixes for
// packages/backend/src/routes/worktree-files.ts. Two holes this route had:
//   - P0: NO task visibility gate. The markdown image-proxy route only checked
//     that the task EXISTS, so any logged-in actor (even a narrow-scope PAT)
//     who knew a taskId could read another user's private task worktree,
//     bypassing the D20 member-only task privacy. A stranger must now get 403
//     (task-not-visible, mirroring the other task routes); owner / collaborator
//     / admin / daemon keep 200.
//   - P1: the route followed symlinks with only a lexical containment check
//     (no realpath). A symlink INSIDE the worktree pointing outside (e.g. to
//     /etc/passwd) was readable — and root-run daemons turned that into
//     arbitrary host file read. Such a symlink must now be rejected 4xx with
//     no content leak.
// If either goes red, a regression re-opened cross-task file read or symlink
// escape in the worktree-files proxy.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskCollaborators, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

interface Actor {
  id: string
  token: string
}

interface Harness {
  db: DbClient
  worktree: string
  outside: string
  taskId: string
  app: ReturnType<typeof createApp>
  owner: Actor
  collaborator: Actor
  stranger: Actor
  admin: Actor
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const worktree = mkdtempSync(join(tmpdir(), 'aw-wt-acl-'))
  const outside = mkdtempSync(join(tmpdir(), 'aw-outside-acl-'))
  writeFileSync(join(outside, 'secrets.txt'), 'TOP SECRET')
  mkdirSync(join(worktree, 'design'), { recursive: true })
  writeFileSync(join(worktree, 'design', 'spec.md'), '# Spec\nbody')

  async function mkUser(username: string, role: 'admin' | 'user'): Promise<Actor> {
    const u = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }
  const owner = await mkUser('alice', 'user')
  const collaborator = await mkUser('bob', 'user')
  const stranger = await mkUser('carol', 'user')
  const admin = await mkUser('root', 'admin')

  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/repo',
    worktreePath: worktree,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    baseCommit: null,
    status: 'done',
    ownerUserId: owner.id,
    inputs: '{}',
    maxDurationMs: null,
    maxTotalTokens: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })
  await db.insert(taskCollaborators).values({
    taskId,
    userId: collaborator.id,
    role: 'collaborator',
    addedBy: owner.id,
    addedAt: Date.now(),
  })

  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return {
    db,
    worktree,
    outside,
    taskId,
    app,
    owner,
    collaborator,
    stranger,
    admin,
    cleanup: () => {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    },
  }
}

async function get(
  app: ReturnType<typeof createApp>,
  token: string,
  taskId: string,
  rel: string,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/api/worktree-files/${taskId}/${rel}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
}

describe('worktree-files ACL + symlink (RFC-099 audit 2026-07-15)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('stranger (non-member) → 403, no content leak', async () => {
    const res = await get(h.app, h.stranger.token, h.taskId, 'design/spec.md')
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('# Spec')
  })

  test('owner → 200', async () => {
    const res = await get(h.app, h.owner.token, h.taskId, 'design/spec.md')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('# Spec')
  })

  test('collaborator → 200', async () => {
    const res = await get(h.app, h.collaborator.token, h.taskId, 'design/spec.md')
    expect(res.status).toBe(200)
  })

  test('admin (non-member) → 200', async () => {
    const res = await get(h.app, h.admin.token, h.taskId, 'design/spec.md')
    expect(res.status).toBe(200)
  })

  test('daemon token → 200', async () => {
    const res = await get(h.app, DAEMON_TOKEN, h.taskId, 'design/spec.md')
    expect(res.status).toBe(200)
  })

  test('symlink escaping the worktree → 4xx, no leak', async () => {
    symlinkSync(join(h.outside, 'secrets.txt'), join(h.worktree, 'leak.txt'))
    const res = await get(h.app, h.owner.token, h.taskId, 'leak.txt')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(await res.text()).not.toContain('TOP SECRET')
  })
})
