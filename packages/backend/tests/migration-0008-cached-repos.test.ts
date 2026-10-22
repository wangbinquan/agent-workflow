// RFC-024 T2 — locks migration 0008: cached_repos table exists with the
// expected columns + unique constraint on url_hash + last_fetched_at index,
// and tasks gains a nullable repo_url column. Legacy task rows (without
// repo_url at insert time) come back with repo_url == NULL.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0008 (RFC-024 cached_repos + tasks.repoUrl)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('cached_repos table accepts inserts and exposes unique url_hash', () => {
    const now = Date.now()
    const { cachedRepos } = tablesOf(db)
    insertOne(db, cachedRepos, {
      id: ulid(),
      urlHash: 'abcd1234',
      urlRedacted: 'git@github.com:foo/bar.git',
      localPath: '/tmp/repos/abcd1234-bar',
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    })

    const rows = queryRows(db.select().from(cachedRepos))
    expect(rows.length).toBe(1)
    expect(rows[0]?.urlHash).toBe('abcd1234')
    expect(rows[0]?.defaultBranch).toBe('main')

    // Unique constraint on url_hash.
    expect(() => {
      return insertOne(db, cachedRepos, {
        id: ulid(),
        urlHash: 'abcd1234',
        urlRedacted: 'git@github.com:foo/bar.git',
        localPath: '/tmp/repos/dupe',
        defaultBranch: null,
        lastFetchedAt: now,
        createdAt: now,
      })
    }).toThrow()
  })

  test('default_branch is nullable and persists null round-trip', () => {
    const now = Date.now()
    const { cachedRepos } = tablesOf(db)
    insertOne(db, cachedRepos, {
      id: ulid(),
      urlHash: 'deadbeef',
      urlRedacted: 'https://example.com/foo.git',
      localPath: '/tmp/repos/deadbeef-foo',
      defaultBranch: null,
      lastFetchedAt: now,
      createdAt: now,
    })
    const row = queryRows(db.select().from(cachedRepos))[0]
    expect(row?.defaultBranch).toBeNull()
  })

  test('tasks.repoUrl persists when set and is null when omitted', () => {
    // Need a workflow row first for the FK.
    const wfId = ulid()
    const { workflows, tasks } = tablesOf(db)
    insertOne(db, workflows, {
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    const idUrl = ulid()
    const idPath = ulid()
    const now = Date.now()
    insertOne(db, tasks, {
      name: 'fixture-task',

      id: idUrl,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt/url',
      repoUrl: 'git@github.com:foo/bar.git',
      worktreePath: '/tmp/wt/url',
      baseBranch: 'main',
      branch: 'agent-workflow/' + idUrl,
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: now,
    })
    insertOne(db, tasks, {
      name: 'fixture-task',

      id: idPath,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt/path',
      // repoUrl intentionally omitted — should land as NULL
      worktreePath: '/tmp/wt/path',
      baseBranch: 'main',
      branch: 'agent-workflow/' + idPath,
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: now,
    })

    const rows = queryRows(db.select().from(tasks))
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(idUrl)?.repoUrl).toBe('git@github.com:foo/bar.git')
    expect(byId.get(idPath)?.repoUrl).toBeNull()
  })
})
