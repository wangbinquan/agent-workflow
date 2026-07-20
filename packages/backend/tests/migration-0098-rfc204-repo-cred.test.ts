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

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, taskRepos, tasks, workflows } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0098 (RFC-204 repo credential sealing columns)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('legacy cached_repos insert omitting the new columns → both null', () => {
    const now = Date.now()
    db.insert(cachedRepos)
      .values({
        id: ulid(),
        urlHash: 'a1b2c3d4',
        url: 'https://x-access-token:TOK@github.com/foo/bar.git',
        localPath: '/tmp/repos/a1b2c3d4-bar',
        lastFetchedAt: now,
        createdAt: now,
      })
      .run()

    const row = db.select().from(cachedRepos).all()[0]
    expect(row?.urlEnc).toBeNull()
    expect(row?.urlRedacted).toBeNull()
  })

  test('url_enc / url_redacted round-trip independently of the legacy url column', () => {
    const now = Date.now()
    db.insert(cachedRepos)
      .values({
        id: ulid(),
        urlHash: 'beefcafe',
        // the sealing gate blanks the legacy column once the pair is populated
        url: '',
        urlEnc: 'c2VhbGVkLWJsb2I=',
        urlRedacted: 'https://***@github.com/foo/bar.git',
        localPath: '/tmp/repos/beefcafe-bar',
        lastFetchedAt: now,
        createdAt: now,
      })
      .run()

    const row = db.select().from(cachedRepos).all()[0]
    expect(row?.url).toBe('')
    expect(row?.urlEnc).toBe('c2VhbGVkLWJsb2I=')
    expect(row?.urlRedacted).toBe('https://***@github.com/foo/bar.git')
  })

  test('task_repos.cached_repo_id defaults to null and persists when set', () => {
    const taskId = ulid()
    const now = Date.now()
    // FK chain: task_repos -> tasks -> workflows. Seed both parents.
    const wfId = ulid()
    db.insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(tasks)
      .values({
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
      .run()
    const insert = (repoIndex: number, cachedRepoId?: string): void => {
      db.insert(taskRepos)
        .values({
          taskId,
          repoIndex,
          repoPath: `/tmp/wt/${repoIndex}`,
          branch: 'agent-workflow/x',
          worktreePath: `/tmp/wt/${repoIndex}`,
          worktreeDirName: String(repoIndex),
          ...(cachedRepoId !== undefined ? { cachedRepoId } : {}),
        })
        .run()
    }
    insert(0)
    insert(1, 'cr_01')

    const rows = db.select().from(taskRepos).all()
    expect(rows.find((r) => r.repoIndex === 0)?.cachedRepoId).toBeNull()
    expect(rows.find((r) => r.repoIndex === 1)?.cachedRepoId).toBe('cr_01')
  })

  test('tasks.cached_repo_id column exists and is nullable', () => {
    const cols = db.all<{ name: string; notnull: number }>(sql`PRAGMA table_info(tasks)`)
    const col = cols.find((c) => c.name === 'cached_repo_id')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(0)
  })

  test('task_repos.cached_repo_id is indexed (refTaskCount runs per cache row)', () => {
    const idx = db.all<{ name: string }>(sql`PRAGMA index_list(task_repos)`)
    expect(idx.some((i) => i.name === 'idx_task_repos_cached_repo_id')).toBe(true)
  })
})
