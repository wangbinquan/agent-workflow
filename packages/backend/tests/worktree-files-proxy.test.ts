// Locks in RFC-005 PR-B T13 worktree-files proxy + path traversal hardening.
// If this goes red, check packages/backend/src/routes/worktree-files.ts —
// a regression here means the markdown image proxy may read files outside
// the task worktree.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
      rmSync(worktree, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
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

  // The attack cases below assert the specific rejection `code`, not just "some
  // 4xx". A range check passes no matter WHICH branch fired — and tightening
  // these three revealed that two of them were not testing what their names
  // claimed: WHATWG URL parsing collapses `..` and `%2e%2e` path segments BEFORE
  // routing, so those requests never reach the handler's containment check at
  // all. They land on a different task id and get a plain 404. The containment
  // branch (`worktree-file-escapes-worktree`) therefore had ZERO real coverage
  // while three tests appeared to guard it. `attack 4` below is the vector that
  // actually reaches it. (design/test-guard-audit-2026-07-21 gap B1-routes-7.)
  test('attack 1: a literal ../ segment is collapsed by URL parsing, never reaching the worktree', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/../outside/secrets.txt`, {
        headers: HEADERS,
      }),
    )
    // Normalised to /api/worktree-files/outside/secrets.txt — a different,
    // non-existent task. Refused before any filesystem access.
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('TOP SECRET')
  })

  test('attack 2: absolute path /etc/passwd is refused as absolute, not merely 4xx', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}//etc/passwd`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBe(422)
    expect((await res.clone().json()) as { code: string }).toMatchObject({
      code: 'worktree-file-absolute-path',
    })
    expect(await res.text()).not.toContain('root:')
  })

  test('attack 3: %2E%2E is a dot-segment too — also collapsed before routing', async () => {
    // The URL spec treats `%2e%2e` as a double-dot segment (case-insensitive),
    // so this is the same shape as attack 1, not a distinct bypass.
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/%2E%2E/outside/secrets.txt`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('TOP SECRET')
  })

  test('attack 4: encoded SLASH survives normalisation and is caught by the containment check', async () => {
    // `..%2Foutside%2Fsecrets.txt` is a single path segment as far as the URL
    // parser is concerned (no dot-segment to collapse), so it arrives intact;
    // the handler's single decodeURIComponent then turns it into
    // `../outside/secrets.txt`. This is the request that must be stopped by
    // resolve()+prefix containment, and the only one in this file that
    // exercises it. Deleting that check turns this red — and nothing else.
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/..%2Foutside%2Fsecrets.txt`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBe(422)
    expect((await res.clone().json()) as { code: string }).toMatchObject({
      code: 'worktree-file-escapes-worktree',
    })
    expect(await res.text()).not.toContain('TOP SECRET')
  })

  test('malformed percent encoding is a client error, never an uncaught 500', async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost/api/worktree-files/${h.taskId}/%E0%A4%A`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBe(422)
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'worktree-file-invalid-encoding',
    })
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
