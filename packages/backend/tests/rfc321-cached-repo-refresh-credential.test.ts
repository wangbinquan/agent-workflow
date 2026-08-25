// Regression for the real GitLab CE private-repo refresh failure found during
// the RFC-310 digital-employee cross-repository E2E (2026-08-25).
//
// Cold clone already used the sealed URL through a one-shot RFC-321 credential
// lease, but manual/background refresh ran a bare `git fetch` against the
// sanitized origin. Every private HTTPS cache therefore failed after import
// with "could not read Password ... terminal prompts disabled". These tests use
// a real Basic-authenticated Git smart-HTTP remote so removing the refresh lease
// makes both cases deterministically red.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb } from '../src/db/client'
import { refreshCachedRepo, resolveCachedRepo } from '../src/services/gitRepoCache'
import { refreshDueRepos } from '../src/services/submoduleRefresh'
import { runGit } from '../src/util/git'
import {
  credentialedRemoteUrlFor,
  startGitHttpRemote,
  stopGitHttpRemote,
} from './helpers/gitHttpRemote'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 21))
const roots: string[] = []

async function authenticatedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-private-refresh-'))
  const appHome = mkdtempSync(join(tmpdir(), 'aw-private-refresh-home-'))
  roots.push(root, appHome)
  const working = join(root, 'working')
  const bare = join(root, 'remote.git')
  await runGit(root, ['init', '-q', '-b', 'main', working])
  await runGit(working, [
    '-c',
    'user.name=Refresh Test',
    '-c',
    'user.email=refresh@example.test',
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    'init',
  ])
  await runGit(root, ['clone', '--bare', working, bare])
  const url = credentialedRemoteUrlFor(bare, 'refresh-bot', 'refresh-secret')
  const db = createInMemoryDb(MIGRATIONS)
  const cached = await resolveCachedRepo({ db, appHome, secretBox: box }, { url })
  return { appHome, cached, db, url }
}

beforeAll(async () => {
  await startGitHttpRemote()
})

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

afterAll(() => {
  stopGitHttpRemote()
})

describe('private cached-repo refresh credential lease', () => {
  test('manual refresh unseals the URL for one fetch and keeps origin credential-free', async () => {
    const { appHome, cached, db } = await authenticatedFixture()

    const refreshed = await refreshCachedRepo({ db, appHome, secretBox: box }, cached.cached.id)
    expect(refreshed.fetchOk).toBe(true)

    const origin = await runGit(cached.cached.localPath, ['remote', 'get-url', 'origin'])
    expect(origin.exitCode).toBe(0)
    expect(origin.stdout).not.toContain('refresh-secret')
    expect(readdirSync(appHome).filter((name) => name.startsWith('.gitcred-'))).toEqual([])
  })

  test('background refresh threads the same SecretBox into the cached fetch', async () => {
    const { appHome, cached, db } = await authenticatedFixture()
    const now = Date.now()
    const result = await refreshDueRepos(
      db,
      { submoduleAutoRefresh: { enabled: true, intervalMs: 1, onlyRecentDays: 30 } },
      { appHome, secretBox: box, now: () => now },
    )

    expect(result).toEqual({ refreshed: 1, failed: 0 })
    expect(readdirSync(appHome).filter((name) => name.startsWith('.gitcred-'))).toEqual([])
    expect(cached.cached.urlRedacted).not.toContain('refresh-secret')
  })
})
