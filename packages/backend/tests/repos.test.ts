// Coverage for /api/repos/* (P-1-10).
// Builds a small real git repo per test for the refs/files endpoints to query.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { createApp } from '../src/server'
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
  rmSync(baseTmp, { recursive: true, force: true })
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
  // RFC-099 (bda0d4fb): refs/files reject paths outside cached_repos mirrors.
  // Register the suite's temp root once so every per-test dir below (repo-*,
  // emptyrepo-*, notrepo-*) passes the allowlist gate and the assertions keep
  // exercising the endpoints' own behavior behind it.
  await db.insert(cachedRepos).values({
    id: 'cr-repos-suite',
    url: 'file:///aw-repos-suite',
    urlHash: 'aw-repos-suite-hash',
    localPath: baseTmp,
    defaultBranch: 'main',
    lastFetchedAt: Date.now(),
    createdAt: Date.now(),
  })
})

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true })
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

// RFC-165: the recent_repos service/table retired with path-mode launches
// (migration 0085 drops the table); refs/files coverage below is unchanged.

// =============================================================================
// HTTP layer
// =============================================================================

describe('repo HTTP routes', () => {
  // RFC-165: the /api/repos/recent endpoints are gone with path-mode
  // launches; only refs/files (RFC-110 dependents) remain below.

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
      rmSync(empty, { recursive: true, force: true })
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
      rmSync(notRepo, { recursive: true, force: true })
    }
  })

  test('all /api/repos/* require token', async () => {
    expect((await app.request(`/api/repos/refs?path=${encodeURIComponent(repoPath)}`)).status).toBe(
      401,
    )
  })
})
