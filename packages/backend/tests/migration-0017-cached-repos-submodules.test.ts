// RFC-034 T2 — locks migration 0017: cached_repos gains three RFC-034
// telemetry columns (has_submodules, last_submodule_sync_ok,
// last_submodule_sync_error). Legacy rows (inserts that omit the three
// columns) come back with all three values null.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0017 (RFC-034 cached_repos submodule columns)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('legacy insert omitting the three columns → all three are null', () => {
    const now = Date.now()
    const { cachedRepos } = tablesOf(db)
    insertOne(db, cachedRepos, {
      id: ulid(),
      urlHash: 'a1b2c3d4',
      urlRedacted: 'git@github.com:foo/bar.git',
      localPath: '/tmp/repos/a1b2c3d4-bar',
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    })

    const row = queryRows(db.select().from(cachedRepos))[0]
    expect(row?.hasSubmodules).toBeNull()
    expect(row?.lastSubmoduleSyncOk).toBeNull()
    expect(row?.lastSubmoduleSyncError).toBeNull()
  })

  test('insert with submodule telemetry persists round-trip', () => {
    const now = Date.now()
    const { cachedRepos } = tablesOf(db)
    insertOne(db, cachedRepos, {
      id: ulid(),
      urlHash: 'beefcafe',
      urlRedacted: 'git@github.com:foo/with-subs.git',
      localPath: '/tmp/repos/beefcafe',
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
      hasSubmodules: true,
      lastSubmoduleSyncOk: false,
      lastSubmoduleSyncError: 'fatal: could not read Username for https://***@host/sub.git',
    })

    const row = queryRows(db.select().from(cachedRepos))[0]
    expect(row?.hasSubmodules).toBe(true)
    expect(row?.lastSubmoduleSyncOk).toBe(false)
    expect(row?.lastSubmoduleSyncError).toContain('***')
  })

  test('success telemetry (ok=true, error=null) round-trips', () => {
    const now = Date.now()
    const { cachedRepos } = tablesOf(db)
    insertOne(db, cachedRepos, {
      id: ulid(),
      urlHash: 'feedface',
      urlRedacted: 'git@github.com:foo/clean.git',
      localPath: '/tmp/repos/feedface',
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
      hasSubmodules: true,
      lastSubmoduleSyncOk: true,
      lastSubmoduleSyncError: null,
    })

    const row = queryRows(db.select().from(cachedRepos))[0]
    expect(row?.lastSubmoduleSyncOk).toBe(true)
    expect(row?.lastSubmoduleSyncError).toBeNull()
  })
})
