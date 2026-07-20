// RFC-204 — the P0-a red anchor plus the reuse contract that replaces it.
//
// The vulnerability (permission audit 2026-07-15, P0-3): `cached_repos` is a
// GLOBAL shared pool with no owner column, and `repos:read` lives in the user
// baseline — so `rowToCached` emitting the original `url` handed every logged-in
// user (and every narrowly-scoped PAT) the credentials embedded in everyone
// else's private-repo URLs. Private repos are reached by putting a token in the
// URL, so this was a straight cross-user credential disclosure.
//
// Removing the field alone would have broken "pick a recent repo" in the
// launcher, which is why it sat unfixed: the picker used the plaintext URL as
// its option value. Reuse now travels as `cachedRepoId` and the daemon resolves
// the real URL itself — hence the second block.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { CachedRepoSchema } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { listCachedRepos } from '../src/services/gitRepoCache'
import { normalizeStartTaskRepos } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOKEN = 'ghp_SUPERSECRET_TOKEN_VALUE'

function seedCredentialedRepo(db: ReturnType<typeof createInMemoryDb>, id: string): void {
  const now = Date.now()
  db.insert(cachedRepos)
    .values({
      id,
      urlHash: 'a1b2c3d4',
      // exactly how a private repo is onboarded today
      url: `https://x-access-token:${TOKEN}@github.com/acme/private.git`,
      localPath: '/tmp/repos/a1b2c3d4-private',
      lastFetchedAt: now,
      createdAt: now,
    })
    .run()
}

describe('RFC-204 P0-a — cached_repos never serves a credential', () => {
  test('the wire schema has no plaintext `url` field at all', () => {
    // Source-level lock: re-adding the field would silently reopen the leak for
    // every consumer, so the contract is asserted on the schema itself.
    expect(Object.keys(CachedRepoSchema.shape)).not.toContain('url')
    expect(Object.keys(CachedRepoSchema.shape)).toContain('urlRedacted')
  })

  test('listCachedRepos output contains no substring of the token', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedCredentialedRepo(db, ulid())

    const items = await listCachedRepos(db)
    expect(items).toHaveLength(1)

    // The whole serialized payload — not just the field we remembered to check.
    // This is what user B would receive from GET /api/cached-repos.
    const wire = JSON.stringify(items)
    expect(wire).not.toContain(TOKEN)
    expect(wire).not.toContain('x-access-token:')
    expect(items[0]?.urlRedacted).toContain('github.com/acme/private.git')
  })

  test('a legacy row (url_redacted not yet backfilled) is still safe', async () => {
    // The sealing gate backfills url_redacted; until it runs, rowToCached must
    // fall back to redacting the legacy column rather than emitting it raw.
    const db = createInMemoryDb(MIGRATIONS)
    seedCredentialedRepo(db, ulid())
    const row = db.select().from(cachedRepos).all()[0]
    expect(row?.urlRedacted).toBeNull() // precondition: not backfilled

    const items = await listCachedRepos(db)
    expect(JSON.stringify(items)).not.toContain(TOKEN)
  })

  test('a query-form token in the local path is redacted on the wire', async () => {
    // parseGitUrl keeps `?access_token=` inside parsed.path, so historical cache
    // slugs (and therefore local_path, which IS on the wire) can embed one.
    const db = createInMemoryDb(MIGRATIONS)
    const now = Date.now()
    db.insert(cachedRepos)
      .values({
        id: ulid(),
        urlHash: 'deadbeef',
        url: `https://github.com/acme/p.git?access_token=${TOKEN}`,
        localPath: `/tmp/repos/deadbeef-p.git?access_token=${TOKEN}`,
        lastFetchedAt: now,
        createdAt: now,
      })
      .run()

    expect(JSON.stringify(await listCachedRepos(db))).not.toContain(TOKEN)
  })
})

describe('RFC-204 — reuse travels as an id, never as a URL', () => {
  test('normalizeStartTaskRepos narrows both source shapes and preserves ref', () => {
    const byId = normalizeStartTaskRepos({
      repos: [{ cachedRepoId: 'cr_1', ref: 'dev' }],
    } as unknown as Parameters<typeof normalizeStartTaskRepos>[0])
    expect(byId).toEqual([{ cachedRepoId: 'cr_1', ref: 'dev' }])

    const byUrl = normalizeStartTaskRepos({
      repos: [{ repoUrl: 'https://github.com/acme/p.git' }],
    } as unknown as Parameters<typeof normalizeStartTaskRepos>[0])
    expect(byUrl).toEqual([{ repoUrl: 'https://github.com/acme/p.git' }])
  })

  test('the framework-internal path spec is passed through untouched', () => {
    // Fusion / test helpers hand us `{repoPath, baseBranch}` entries that never
    // went through the wire schema; mapping them as url-or-id shapes turned them
    // into `{repoUrl: undefined}` and blew up materializeSpace.
    const internal = normalizeStartTaskRepos({
      repos: [{ repoPath: '/srv/repo', baseBranch: 'main' }],
    } as unknown as Parameters<typeof normalizeStartTaskRepos>[0])
    expect(internal).toEqual([{ repoPath: '/srv/repo', baseBranch: 'main' }])
  })

  test('the legacy single-repo body accepts a cachedRepoId source', () => {
    const single = normalizeStartTaskRepos({
      cachedRepoId: 'cr_9',
    } as unknown as Parameters<typeof normalizeStartTaskRepos>[0])
    expect(single).toEqual([{ cachedRepoId: 'cr_9' }])
  })
})
