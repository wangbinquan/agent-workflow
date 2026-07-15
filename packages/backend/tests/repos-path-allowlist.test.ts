// Locks the RFC-099 audit (2026-07-15) fix for the repos refs/files path hole.
// GET /api/repos/refs|files?path=... ran git against ANY host path the caller
// named — repos:read is in the user baseline, so any logged-in user could
// enumerate branches/tags/commits/tracked-files of arbitrary local git repos
// (cross-project info disclosure on multi-user deployments). The route now
// requires `path` to resolve inside a known cached_repos.localPath.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { createApp } from '../src/server'
import { isKnownRepoPath } from '../src/services/repo'
import { createUser } from '../src/services/users'

describe('isKnownRepoPath', () => {
  test('accepts an exact cached localPath', () => {
    expect(isKnownRepoPath(['/home/aw/repos/abc'], '/home/aw/repos/abc')).toBe(true)
  })

  test('accepts a directory under a cached localPath', () => {
    expect(isKnownRepoPath(['/home/aw/repos/abc'], '/home/aw/repos/abc/pkg')).toBe(true)
  })

  test('rejects a sibling that merely shares a string prefix', () => {
    expect(isKnownRepoPath(['/home/aw/repos/abc'], '/home/aw/repos/abcdef')).toBe(false)
  })

  test('rejects traversal that resolves outside despite a lexical prefix', () => {
    expect(isKnownRepoPath(['/home/aw/repos/abc'], '/home/aw/repos/abc/../../../etc/passwd')).toBe(
      false,
    )
  })

  test('rejects an arbitrary host path and the empty allowlist', () => {
    expect(isKnownRepoPath(['/home/aw/repos/abc'], '/etc')).toBe(false)
    expect(isKnownRepoPath([], '/home/aw/repos/abc')).toBe(false)
  })
})

describe('GET /api/repos/refs|files path allowlist (route)', () => {
  const DAEMON_TOKEN = 'a'.repeat(64)
  const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

  async function harness(): Promise<{ app: Hono; userToken: string; db: DbClient }> {
    const db = createInMemoryDb(MIGRATIONS)
    const app = createApp({
      token: DAEMON_TOKEN,
      configPath: '',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const u = await createUser(db, {
      username: 'alice',
      displayName: 'alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { app, userToken: token, db }
  }

  async function refs(app: Hono, token: string, path: string): Promise<Response> {
    return app.request(`/api/repos/refs?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  }

  test('unknown host path → 422 repo-path-unknown, git never runs', async () => {
    const { app, userToken } = await harness()
    const res = await refs(app, userToken, '/etc')
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('repo-path-unknown')
  })

  test('a path outside every cached mirror is rejected even if it is a real repo dir', async () => {
    const { app, userToken, db } = await harness()
    await db.insert(cachedRepos).values({
      id: 'cr1',
      url: 'https://github.com/acme/x',
      urlHash: 'h1',
      localPath: '/home/aw/repos/x',
      defaultBranch: 'main',
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    const res = await refs(app, userToken, '/home/aw/repos/other')
    expect(res.status).toBe(422)
  })
})
