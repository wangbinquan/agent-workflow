// Locks the RFC-099 audit (2026-07-15) fix for the repos refs/files path hole.
// GET /api/repos/refs|files?path=... ran git against ANY host path the caller
// named — repos:read is in the user baseline, so any logged-in user could
// enumerate branches/tags/commits/tracked-files of arbitrary local git repos
// (cross-project info disclosure on multi-user deployments). The route now
// requires `path` to resolve inside a known cached_repos.localPath.

import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { cachedRepos } from '../src/db/schema'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
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

// RFC-359 AC-6：路由这半改成两个引擎各跑一遍。判据本身（未知宿主路径 → 422 repo-path-unknown、
// 不在任何缓存镜像下的真实 repo 目录同样被拒）与库无关，但它要走完整条装配——路由挂载、
// 会话鉴权、错误体——两侧各有一条 compose 路径，「与库无关」得由两个引擎证明而不是假设。
// 上面 `isKnownRepoPath` 那半是纯函数，不需要库，保持原样。
const DAEMON_TOKEN = 'a'.repeat(64)

describeEachProviderHttpApplication(
  'GET /api/repos/refs|files path allowlist (route)',
  { token: DAEMON_TOKEN, opencodeVersion: '1.14.25', dbVersion: 1, tempPrefix: 'aw-repos-allow-' },
  (scope) => {
    async function harness(): Promise<{
      app: Hono
      userToken: string
      db: ProviderNeutralDatabase
    }> {
      const { app } = await scope.open()
      const db = scope.harness.db
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
        urlRedacted: 'https://github.com/acme/x',
        urlHash: 'h1',
        localPath: '/home/aw/repos/x',
        defaultBranch: 'main',
        lastFetchedAt: Date.now(),
        createdAt: Date.now(),
      })
      const res = await refs(app, userToken, '/home/aw/repos/other')
      expect(res.status).toBe(422)
    })
  },
)
