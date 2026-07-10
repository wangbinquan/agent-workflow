import { rimrafDir } from './helpers/cleanup'
// Locks in RFC-005 PR-B T13 worktree-files proxy + path traversal hardening.
// If this goes red, check packages/backend/src/routes/worktree-files.ts —
// a regression here means the markdown image proxy may read files outside
// the task worktree.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks } from '../src/db/schema'
import { createApp } from '../src/server'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  worktree: string
  outside: string
  taskId: string
  app: ReturnType<typeof createApp>
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const worktree = mkdtempSync(join(tmpdir(), 'aw-wt-'))
  const outside = mkdtempSync(join(tmpdir(), 'aw-outside-'))
  // Seed an outside-of-worktree secret to test traversal attempts read it.
  writeFileSync(join(outside, 'secrets.txt'), 'TOP SECRET')
  // Seed worktree content.
  mkdirSync(join(worktree, 'design', 'img'), { recursive: true })
  writeFileSync(join(worktree, 'design', 'img', 'diagram.png'), 'BINARY_PNG_BYTES')
  writeFileSync(join(worktree, 'design', 'spec.md'), '# Spec\nbody')

  const taskId = ulid()
  // Pre-create a workflow row (foreign key target).
  const workflowId = ulid()
  await db.insert((await import('../src/db/schema')).workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/repo',
    worktreePath: worktree,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    baseCommit: null,
    status: 'done',
    inputs: '{}',
    maxDurationMs: null,
    maxTotalTokens: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })

  const app = createApp({
    token: 'tok',
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
    cleanup: () => {
      rimrafDir(worktree)
      rimrafDir(outside)
    },
  }
}

const HEADERS = { Authorization: 'Bearer tok' }

describe('GET /api/worktree-files/:taskId/* — RFC-005 T13', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('returns file content with correct mime type for known extensions', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/design/img/diagram.png`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('BINARY_PNG_BYTES')
  })

  test('renders markdown with proper mime', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/design/spec.md`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(await res.text()).toContain('# Spec')
  })

  test('attack 1: ../ traversal returns 422 / 400 (ValidationError)', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/../outside/secrets.txt`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const body = await res.text()
    expect(body).not.toContain('TOP SECRET')
  })

  test('attack 2: absolute path /etc/passwd → 4xx, no leak', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}//etc/passwd`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('attack 3: encoded ../ traversal still 4xx', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/%2E%2E/outside/secrets.txt`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const body = await res.text()
    expect(body).not.toContain('TOP SECRET')
  })

  test('missing file → 404', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/no/such/path.png`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBe(404)
  })

  test('unknown task → 404', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/no_such_task/design/spec.md`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBe(404)
  })

  test('missing relative path (just /api/worktree-files/:taskId) → 422', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}`, { headers: HEADERS }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('directory target (not a regular file) → 404', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/design`, { headers: HEADERS }),
    )
    expect(res.status).toBe(404)
  })

  test('no auth → 401', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/design/spec.md`),
    )
    expect(res.status).toBe(401)
  })

  test('unknown extension → octet-stream (no auto-render of exotic types)', async () => {
    writeFileSync(join(h.worktree, 'data.xyz'), 'opaque')
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/data.xyz`, { headers: HEADERS }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })
})
