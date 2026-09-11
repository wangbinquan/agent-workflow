// Locks in the RFC-099 permission audit (2026-07-15) fixes for
// packages/backend/src/routes/worktree-files.ts. Two holes this route had:
//   - P0: NO task visibility gate. The markdown image-proxy route only checked
//     that the task EXISTS, so any logged-in actor (even a narrow-scope PAT)
//     who knew a taskId could read another user's private task worktree,
//     bypassing the D20 member-only task privacy. A stranger must now get 404
//     (task-not-found — RFC-285 B1 made invisibility byte-identical to
//     absence; pre-B1 this was 403 task-not-visible); owner / collaborator
//     / admin / daemon keep 200.
//   - P1: the route followed symlinks with only a lexical containment check
//     (no realpath). A symlink INSIDE the worktree pointing outside (e.g. to
//     /etc/passwd) was readable — and root-run daemons turned that into
//     arbitrary host file read. Such a symlink must now be rejected 4xx with
//     no content leak.
// If either goes red, a regression re-opened cross-task file read or symlink
// escape in the worktree-files proxy.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from './helpers/auth/sessionStore'
import type { Hono } from 'hono'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { taskCollaborators, tasks, workflows } from '../src/db/schema'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)

interface Actor {
  id: string
  token: string
}

interface Harness {
  db: ProviderNeutralDatabase
  worktree: string
  outside: string
  taskId: string
  app: Hono
  owner: Actor
  collaborator: Actor
  stranger: Actor
  admin: Actor
  cleanup: () => void
}

async function buildHarness(scope: ProviderHttpApplicationScope): Promise<Harness> {
  const db = scope.harness.db
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

  const app = (await scope.open()).app
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

async function get(app: Hono, token: string, taskId: string, rel: string): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/api/worktree-files/${taskId}/${rel}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
}

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'worktree-files ACL + symlink (RFC-099 audit 2026-07-15)',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-worktree-acl-',
  },
  (scope) => {
    let h: Harness
    beforeEach(async () => {
      h = await buildHarness(scope)
    })
    afterEach(() => h.cleanup())

    // RFC-285 B1：陌生人 404 与任务不存在同形，且响应体不泄内容。
    test('stranger (non-member) → 404 task-not-found, no content leak', async () => {
      const res = await get(h.app, h.stranger.token, h.taskId, 'design/spec.md')
      expect(res.status).toBe(404)
      expect(((await res.clone().json()) as { code: string }).code).toBe('task-not-found')
      expect(await res.text()).not.toContain('# Spec')
    })

    // RFC-285 B1 oracle 消除：同一陌生人打「存在但无权」与「真不存在」两个 taskId，
    // 归一 id 文本后响应体逐字节相等——错误码/文案都探测不出任务存在性。
    test('B1 oracle: invisible vs missing task are byte-identical (ids normalized)', async () => {
      const missingId = 'no-such-task-b1'
      const invisible = await get(h.app, h.stranger.token, h.taskId, 'design/spec.md')
      const missing = await get(h.app, h.stranger.token, missingId, 'design/spec.md')
      expect(invisible.status).toBe(404)
      expect(missing.status).toBe(404)
      const normalize = (s: string, id: string): string => s.replaceAll(id, '<ID>')
      expect(normalize(await invisible.text(), h.taskId)).toBe(
        normalize(await missing.text(), missingId),
      )
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
  },
)
