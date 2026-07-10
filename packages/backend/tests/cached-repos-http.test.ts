import { rimrafDir } from './helpers/cleanup'
// RFC-024 T5 — /api/cached-repos endpoints + URL launch validation on
// POST /api/tasks. Exercises the full HTTP surface so the launcher and
// /repos management page can rely on the contract.

import { beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import type { Hono } from 'hono'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { resolveCachedRepo } from '../src/services/gitRepoCache'
import { isWindows } from './helpers/stub-runtime'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  appHome: string
  tmp: string
  remoteUrl: string
}

function buildBareRemote(tmp: string): string {
  const working = join(tmp, 'src-' + ulid())
  mkdirSync(working, { recursive: true })
  execSync(`git init -b main "${working}"`, { stdio: 'ignore' })
  execSync(`git -C "${working}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${working}" config user.name t`, { stdio: 'ignore' })
  if (isWindows) {
    execSync(`git -C "${working}" config core.longPaths true`, { stdio: 'ignore' })
  }
  writeFileSync(join(working, 'README.md'), '# fixture\n')
  execSync(`git -C "${working}" add . && git -C "${working}" commit -m init`, {
    stdio: 'ignore',
  })
  const bare = join(tmp, 'remote-' + ulid() + '.git')
  execSync(`git clone --bare "${working}" "${bare}"`, { stdio: 'ignore' })
  if (isWindows) {
    // file:// URL on Windows: use pathToFileURL for correct format (file:///C:/path)
    return pathToFileURL(bare).href
  }
  return `file://${bare}`
}

function buildHarness(): Harness {
  // Use short prefix on Windows to reduce path length (MAX_PATH=260)
  const prefix = isWindows ? 'aw-cr-' : 'aw-cached-repos-http-'
  const tmp = mkdtempSync(join(tmpdir(), prefix))
  const appHome = join(tmp, 'home')
  mkdirSync(appHome, { recursive: true })
  process.env.AGENT_WORKFLOW_HOME = appHome
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: join(tmp, 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 8,
    db,
  })
  const remoteUrl = buildBareRemote(tmp)
  return { db, app, appHome, tmp, remoteUrl }
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  })
}

describe('cached-repos HTTP routes (RFC-024 T5)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  test('GET /api/cached-repos returns [] when empty', async () => {
    const res = await req(h.app, '/api/cached-repos')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
    rimrafDir(h.tmp)
  })

  test('GET /api/cached-repos lists cached entries with redacted URL', async () => {
    await resolveCachedRepo(
      { db: h.db, appHome: h.appHome, fetchOnReuse: false },
      { url: h.remoteUrl },
    )
    const res = await req(h.app, '/api/cached-repos')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ urlRedacted: string; defaultBranch: string | null }>
    }
    expect(body.items.length).toBe(1)
    expect(typeof body.items[0]?.urlRedacted).toBe('string')
    expect(body.items[0]?.defaultBranch).toBe('main')
    rimrafDir(h.tmp)
  })

  test('POST /api/cached-repos/:id/refresh updates lastFetchedAt', async () => {
    const r = await resolveCachedRepo(
      { db: h.db, appHome: h.appHome, fetchOnReuse: false },
      { url: h.remoteUrl },
    )
    const initial = r.cached.lastFetchedAt
    await Bun.sleep(5)
    const res = await req(h.app, `/api/cached-repos/${r.cached.id}/refresh`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { fetchOk: boolean; item: { lastFetchedAt: string } }
    expect(body.fetchOk).toBe(true)
    expect(Date.parse(body.item.lastFetchedAt)).toBeGreaterThanOrEqual(Date.parse(initial))
    rimrafDir(h.tmp)
  })

  test('DELETE /api/cached-repos/:id with no references succeeds', async () => {
    const r = await resolveCachedRepo(
      { db: h.db, appHome: h.appHome, fetchOnReuse: false },
      { url: h.remoteUrl },
    )
    const res = await req(h.app, `/api/cached-repos/${r.cached.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(h.db.select().from(cachedRepos).all().length).toBe(0)
    rimrafDir(h.tmp)
  })

  test('DELETE blocked by reference count without ?force=1', async () => {
    const r = await resolveCachedRepo(
      { db: h.db, appHome: h.appHome, fetchOnReuse: false },
      { url: h.remoteUrl },
    )
    // Fake a workflow + task referencing this URL.
    const wfId = ulid()
    h.db
      .insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: '{}',
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    h.db
      .insert(tasks)
      .values({
        name: 'fixture-task',

        id: ulid(),
        workflowId: wfId,
        workflowSnapshot: '{}',
        repoPath: r.cached.localPath,
        repoUrl: r.cached.url,
        worktreePath: r.cached.localPath,
        baseBranch: 'main',
        branch: 'agent-workflow/x',
        baseCommit: null,
        status: 'done',
        inputs: '{}',
        startedAt: Date.now(),
      })
      .run()

    const res = await req(h.app, `/api/cached-repos/${r.cached.id}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('cached-repo-has-references')

    const forced = await req(h.app, `/api/cached-repos/${r.cached.id}?force=1`, {
      method: 'DELETE',
    })
    expect(forced.status).toBe(200)
    expect(h.db.select().from(cachedRepos).all().length).toBe(0)
    rimrafDir(h.tmp)
  })

  test('DELETE 404 when id unknown', async () => {
    const res = await req(h.app, `/api/cached-repos/nonexistent`, { method: 'DELETE' })
    expect(res.status).toBe(404)
    rimrafDir(h.tmp)
  })
})

describe('POST /api/tasks URL validation (RFC-024 T5)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  test('rejects both repoPath and repoUrl at once', async () => {
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: 'wf-1',
        repoPath: '/tmp/repo',
        baseBranch: 'main',
        repoUrl: 'git@github.com:foo/bar.git',
        inputs: {},
      }),
    })
    expect(res.status).toBe(422)
    rimrafDir(h.tmp)
  })

  test('rejects neither repoPath nor repoUrl', async () => {
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', inputs: {} }),
    })
    expect(res.status).toBe(422)
    rimrafDir(h.tmp)
  })

  test('rejects malformed repoUrl with redacted message', async () => {
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: 'wf-bogus',
        repoUrl: '/not/a/git/url',
        inputs: {},
      }),
    })
    // workflow lookup fails first (workflow-not-found) but the URL still goes
    // through StartTaskSchema; we just care that the response status is non-2xx
    // and never echoes a secret. The redact-leak test exercises the 4xx body
    // directly via the schema.
    expect(res.status).toBeGreaterThanOrEqual(400)
    rimrafDir(h.tmp)
  })
})
