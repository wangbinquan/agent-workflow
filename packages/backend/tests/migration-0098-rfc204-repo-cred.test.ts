// RFC-204 T2 — locks migration 0098.
//
// cached_repos gains url_enc (sealed credential) + url_redacted (the only form
// allowed on the wire); tasks and task_repos gain cached_repo_id, and
// task_repos gets an index on it.
//
// Why cached_repo_id has to exist at all: `secretBox.seal` uses a random IV, so
// the ciphertext is non-deterministic and the old `cached_repos.url ==
// task_repos.repo_url` plaintext join that backed refTaskCount, the cache
// delete guard and repo-scoped memory resolution can no longer work. The index
// matters because refTaskCount is evaluated once per listed cache row.
//
// All columns are nullable so a pre-0098 row keeps loading during a rolling
// upgrade — the sealing gate (ensureCredentialsSealed) fills them in.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows, rawRows } from '@/platform/persistence/queryHelpers'
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0098 (RFC-204 repo credential sealing columns)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('cached_repos still permits migration-era null credential columns', () => {
    const now = Date.now()
    const { cachedRepos } = tablesOf(db)
    insertOne(db, cachedRepos, {
      id: ulid(),
      urlHash: 'a1b2c3d4',
      localPath: '/tmp/repos/a1b2c3d4-bar',
      lastFetchedAt: now,
      createdAt: now,
    })

    const row = queryRows(db.select().from(cachedRepos))[0]
    expect(row?.urlEnc).toBeNull()
    expect(row?.urlRedacted).toBeNull()
  })

  test('url_enc / url_redacted round-trip without a plaintext column', () => {
    const now = Date.now()
    const { cachedRepos } = tablesOf(db)
    insertOne(db, cachedRepos, {
      id: ulid(),
      urlHash: 'beefcafe',
      urlEnc: 'c2VhbGVkLWJsb2I=',
      urlRedacted: 'https://***@github.com/foo/bar.git',
      localPath: '/tmp/repos/beefcafe-bar',
      lastFetchedAt: now,
      createdAt: now,
    })

    const row = queryRows(db.select().from(cachedRepos))[0]
    expect(row?.urlEnc).toBe('c2VhbGVkLWJsb2I=')
    expect(row?.urlRedacted).toBe('https://***@github.com/foo/bar.git')
  })

  test('task_repos.cached_repo_id defaults to null and persists when set', () => {
    const taskId = ulid()
    const now = Date.now()
    // FK chain: task_repos -> tasks -> workflows. Seed both parents.
    const wfId = ulid()
    const { workflows, tasks, taskRepos } = tablesOf(db)
    insertOne(db, workflows, {
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    insertOne(db, tasks, {
      id: taskId,
      name: 'fixture-task',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: now,
    })
    const insert = (repoIndex: number, cachedRepoId?: string): void => {
      insertOne(db, taskRepos, {
        taskId,
        repoIndex,
        repoPath: `/tmp/wt/${repoIndex}`,
        branch: 'agent-workflow/x',
        worktreePath: `/tmp/wt/${repoIndex}`,
        worktreeDirName: String(repoIndex),
        ...(cachedRepoId !== undefined ? { cachedRepoId } : {}),
      })
    }
    insert(0)
    insert(1, 'cr_01')

    const rows = queryRows(db.select().from(taskRepos))
    expect(rows.find((r) => r.repoIndex === 0)?.cachedRepoId).toBeNull()
    expect(rows.find((r) => r.repoIndex === 1)?.cachedRepoId).toBe('cr_01')
  })

  test('tasks.cached_repo_id column exists and is nullable', () => {
    const cols = rawRows<{ name: string; notnull: number }>(db, sql`PRAGMA table_info(tasks)`, {
      notnull: 'int',
    })
    const col = cols.find((c) => c.name === 'cached_repo_id')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(0)
  })

  test('task_repos.cached_repo_id is indexed (refTaskCount runs per cache row)', () => {
    const idx = rawRows<{ name: string }>(db, sql`PRAGMA index_list(task_repos)`)
    expect(idx.some((i) => i.name === 'idx_task_repos_cached_repo_id')).toBe(true)
  })
})
