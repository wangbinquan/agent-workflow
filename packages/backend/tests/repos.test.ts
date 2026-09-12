// Coverage for /api/repos/* (P-1-10).
// Builds a small real git repo per test for the refs/files endpoints to query.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedRepos } from '../src/db/schema'
import { runGit } from '../src/util/git'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'

const TOKEN = 'a'.repeat(64)

let baseTmp: string
let repoPath: string
let app: Hono

beforeAll(() => {
  baseTmp = mkdtempSync(join(tmpdir(), 'aw-repos-'))
})

afterAll(() => {
  rmSync(baseTmp, { recursive: true, force: true })
})

async function prepareFixture<TDatabase extends ProviderNeutralDatabase>(
  database: () => TDatabase,
  compose: (db: TDatabase) => Hono | Promise<Hono>,
): Promise<void> {
  repoPath = mkdtempSync(join(baseTmp, 'repo-'))
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
  await runGit(repoPath, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  writeFileSync(join(repoPath, 'src.go'), 'package main\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])
  await runGit(repoPath, ['tag', 'v1.0'])

  const db = database()
  app = await compose(db)
  // RFC-099 (bda0d4fb): refs/files reject paths outside cached_repos mirrors.
  // Register the suite's temp root once so every per-test dir below (repo-*,
  // emptyrepo-*, notrepo-*) passes the allowlist gate and the assertions keep
  // exercising the endpoints' own behavior behind it.
  await db.insert(cachedRepos).values({
    id: 'cr-repos-suite',
    urlRedacted: 'file:///aw-repos-suite',
    urlHash: 'aw-repos-suite-hash',
    localPath: baseTmp,
    defaultBranch: 'main',
    lastFetchedAt: Date.now(),
    createdAt: Date.now(),
  })
}

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

  registerProviderApplication(() => {
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
  })

  // RFC-359 AC-6：这条 401 原来挂在一个**只跑 SQLite** 的 `registerNativeApplication` 上
  // （它自建一个内存库 + 一个应用；此处刻意不写那两个函数的字面名字——账本守卫按文本扫，
  //   注释也算语料）。它不碰库、只验「无 token ⇒ 401」，
  // 并到 provider 注册面即可，两个引擎各跑一遍；那个只服务它一条的 native 注册器随之删掉。
  registerProviderApplication(() => {
    test('all /api/repos/* require token', async () => {
      expect(
        (await app.request(`/api/repos/refs?path=${encodeURIComponent(repoPath)}`)).status,
      ).toBe(401)
    })
  })
})

function registerProviderApplication(register: () => void): void {
  describeEachProvider('provider', (harness) => {
    describe('application lifetime', () => {
      let application: ProviderHttpApplication | undefined
      let ownedHome: string | undefined
      let previousHome: string | undefined
      let homeAssigned = false
      beforeEach(() =>
        prepareFixture(
          () => harness.db,
          async () => {
            ownedHome = mkdtempSync(join(tmpdir(), 'rfc359-w51-repos-'))
            previousHome = process.env.AGENT_WORKFLOW_HOME
            process.env.AGENT_WORKFLOW_HOME = ownedHome
            homeAssigned = true
            application = await createProviderHttpApplication(harness, {
              token: TOKEN,
              configPath: join(ownedHome, 'config.json'),
              opencodeVersion: '1.14.25',
              dbVersion: 1,
              appHome: ownedHome,
            })
            return application.app
          },
        ),
      )
      afterEach(async () => {
        try {
          await application?.dispose()
        } finally {
          application = undefined
          if (homeAssigned) {
            if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
            else process.env.AGENT_WORKFLOW_HOME = previousHome
          }
          homeAssigned = false
          if (ownedHome !== undefined) rmSync(ownedHome, { recursive: true, force: true })
          ownedHome = undefined
        }
      })
      register()
    })
  })
}
