import { rimrafDir } from './helpers/cleanup'
// Coverage for /api/repos/* (P-1-10).
// Builds a small real git repo per test for the refs/files endpoints to query.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { listRecentRepos, upsertRecentRepo } from '../src/services/repo'
import { runGit } from '../src/util/git'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let baseTmp: string
let repoPath: string
let db: DbClient
let app: Hono

beforeAll(() => {
  baseTmp = mkdtempSync(join(tmpdir(), 'aw-repos-'))
})

afterAll(() => {
  rimrafDir(baseTmp)
})

beforeEach(async () => {
  repoPath = mkdtempSync(join(baseTmp, 'repo-'))
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
  await runGit(repoPath, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  writeFileSync(join(repoPath, 'src.go'), 'package main\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])
  await runGit(repoPath, ['tag', 'v1.0'])

  db = createInMemoryDb(MIGRATIONS)
  app = createApp({
    token: TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
})

afterEach(() => {
  rimrafDir(repoPath)
})

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

// =============================================================================
// service layer
// =============================================================================

describe('recent_repos service', () => {
  test('list/empty -> []', async () => {
    expect(await listRecentRepos(db)).toEqual([])
  })

  test('upsert inserts + detects default branch', async () => {
    const r = await upsertRecentRepo(db, repoPath)
    expect(r.path).toBe(repoPath)
    expect(r.defaultBranch).toBe('main')
    expect(typeof r.lastUsedAt).toBe('number')

    const list = await listRecentRepos(db)
    expect(list.length).toBe(1)
    expect(list[0]?.path).toBe(repoPath)
  })

  test('upsert refreshes lastUsedAt on second call', async () => {
    const first = await upsertRecentRepo(db, repoPath)
    await Bun.sleep(5)
    const second = await upsertRecentRepo(db, repoPath)
    expect(second.lastUsedAt).toBeGreaterThanOrEqual(first.lastUsedAt)
    expect((await listRecentRepos(db)).length).toBe(1)
  })

  test('upsert rejects non-git path with ValidationError', async () => {
    const notRepo = mkdtempSync(join(baseTmp, 'notrepo-'))
    try {
      await expect(upsertRecentRepo(db, notRepo)).rejects.toThrow()
    } finally {
      rimrafDir(notRepo)
    }
  })
})

// =============================================================================
// HTTP layer
// =============================================================================

describe('repo HTTP routes', () => {
  test('POST /api/repos/recent + GET roundtrip', async () => {
    const post = await req('/api/repos/recent', {
      method: 'POST',
      body: JSON.stringify({ path: repoPath }),
    })
    expect(post.status).toBe(200)
    const created = (await post.json()) as { path: string; defaultBranch?: string }
    expect(created.path).toBe(repoPath)
    expect(created.defaultBranch).toBe('main')

    const get = await req('/api/repos/recent')
    expect(get.status).toBe(200)
    const list = (await get.json()) as Array<{ path: string }>
    expect(list[0]?.path).toBe(repoPath)
  })

  test('POST /api/repos/recent rejects non-git path', async () => {
    const notRepo = mkdtempSync(join(baseTmp, 'notrepo-'))
    try {
      const res = await req('/api/repos/recent', {
        method: 'POST',
        body: JSON.stringify({ path: notRepo }),
      })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('repo-not-git')
    } finally {
      rimrafDir(notRepo)
    }
  })

  test('POST /api/repos/recent rejects missing path', async () => {
    const res = await req('/api/repos/recent', {
      method: 'POST',
      body: JSON.stringify({ path: '/no/such/path/agent-workflow-test-xyz' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('repo-path-missing')
  })

  test('GET /api/repos/refs returns branches/tags/commits/currentBranch', async () => {
    const res = await req(`/api/repos/refs?path=${encodeURIComponent(repoPath)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      branches: string[]
      tags: string[]
      recentCommits: Array<{ sha: string; subject: string }>
      currentBranch: string | null
      defaultBranch: string | null
      hasCommits: boolean
    }
    expect(body.branches).toContain('main')
    expect(body.tags).toEqual(['v1.0'])
    expect(body.recentCommits.length).toBe(1)
    expect(body.recentCommits[0]?.subject).toBe('init')
    expect(body.currentBranch).toBe('main')
    expect(body.defaultBranch).toBe('main')
    expect(body.hasCommits).toBe(true)
  })

  // Regression: `git init -b main` alone leaves the unborn `main`
  // unresolvable, but the API used to pretend the repo was launchable
  // (returned an empty branches list, no other signal). The launcher
  // then queued a task that died at `git worktree add` with
  // `cannot resolve base ref 'main'`. /api/repos/refs must surface
  // `hasCommits: false` so the launcher can refuse the launch up front.
  test('GET /api/repos/refs on a freshly-init repo with no commits reports hasCommits=false', async () => {
    const empty = mkdtempSync(join(baseTmp, 'emptyrepo-'))
    try {
      await runGit(empty, ['init', '-q', '-b', 'main'])
      const res = await req(`/api/repos/refs?path=${encodeURIComponent(empty)}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        branches: string[]
        recentCommits: unknown[]
        hasCommits: boolean
        currentBranch: string | null
        defaultBranch: string | null
      }
      expect(body.hasCommits).toBe(false)
      expect(body.branches).toEqual([])
      expect(body.recentCommits).toEqual([])
      // currentBranch + defaultBranch are best-effort — we don't pin
      // their values here, only the launch-blocking signal.
    } finally {
      rimrafDir(empty)
    }
  })

  test('GET /api/repos/refs requires ?path=', async () => {
    const res = await req('/api/repos/refs')
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('path-required')
  })

  test('GET /api/repos/files returns git ls-files output', async () => {
    const res = await req(`/api/repos/files?path=${encodeURIComponent(repoPath)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: string[] }
    expect(body.files.sort()).toEqual(['README.md', 'src.go'])
  })

  test('GET /api/repos/files rejects non-git path', async () => {
    const notRepo = mkdtempSync(join(baseTmp, 'notrepo-'))
    try {
      const res = await req(`/api/repos/files?path=${encodeURIComponent(notRepo)}`)
      expect(res.status).toBe(422)
      expect(((await res.json()) as { code: string }).code).toBe('repo-not-git')
    } finally {
      rimrafDir(notRepo)
    }
  })

  test('all /api/repos/* require token', async () => {
    expect((await app.request('/api/repos/recent')).status).toBe(401)
    expect((await app.request(`/api/repos/refs?path=${encodeURIComponent(repoPath)}`)).status).toBe(
      401,
    )
  })
})
