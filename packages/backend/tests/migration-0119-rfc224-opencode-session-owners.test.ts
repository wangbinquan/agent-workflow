// RFC-224 T14 — locks the dedicated session owner table. In particular,
// node-run history is intentionally not an FK owner, while task deletion owns
// retention and lease columns can never be partially populated.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

function freezeThrough0118(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc224-0119-'))
  tempDirs.push(dir)
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 117)
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  return dir
}

function seedTask(raw: Database, suffix: string): void {
  raw.exec(`
    INSERT INTO workflows (id, name, definition)
    VALUES ('workflow-${suffix}', 'workflow-${suffix}', '{}');
    INSERT INTO tasks (
      id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
      base_branch, branch, status, inputs, started_at
    ) VALUES (
      'task-${suffix}', 'task-${suffix}', 'workflow-${suffix}', '{}',
      '/tmp/repo', '/tmp/worktree', 'main', 'aw/${suffix}', 'running', '{}', 1
    );
    INSERT INTO node_runs (id, task_id, node_id, status)
    VALUES ('run-${suffix}', 'task-${suffix}', 'node-a', 'running');
  `)
}

function insertOwner(
  raw: Database,
  input: {
    sessionId: string
    taskId: string
    storeKey: string
    createdRunId?: string
    leaseRunId?: string | null
    nonceDigest?: string | null
    leasedAt?: number | null
  },
): void {
  raw
    .query(
      `INSERT INTO opencode_session_owners (
         session_id, task_id, node_id, created_node_run_id,
         identity_digest, official_build_digest, session_contract_digest,
         session_store_key, project_id, opencode_version,
         lease_node_run_id, lease_nonce_digest, leased_at
       ) VALUES (?, ?, 'node-a', ?, 'identity', 'build', 'contract', ?, 'project', '1.18.3',
                 ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.taskId,
      input.createdRunId ?? 'missing-history-run-is-logical',
      input.storeKey,
      input.leaseRunId ?? null,
      input.nonceDigest ?? null,
      input.leasedAt ?? null,
    )
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('migration 0119 RFC-224 OpenCode session owners', () => {
  test('upgrades 0118 with immutable provenance, one task FK, and the required indexes', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0118() })
    seedTask(raw, 'upgrade')

    expect(
      raw
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'opencode_session_owners'",
        )
        .get(),
    ).toBeNull()

    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    const columns = raw.query("PRAGMA table_info('opencode_session_owners')").all() as Array<{
      name: string
      notnull: number
      pk: number
    }>
    expect(columns.map((column) => column.name)).toEqual([
      'session_id',
      'task_id',
      'node_id',
      'created_node_run_id',
      'identity_digest',
      'official_build_digest',
      'session_contract_digest',
      'session_store_key',
      'project_id',
      'opencode_version',
      'lease_node_run_id',
      'lease_nonce_digest',
      'leased_at',
    ])
    expect(columns.find((column) => column.name === 'session_id')?.pk).toBe(1)
    for (const name of [
      'task_id',
      'node_id',
      'created_node_run_id',
      'identity_digest',
      'official_build_digest',
      'session_contract_digest',
      'session_store_key',
      'project_id',
      'opencode_version',
    ]) {
      expect(columns.find((column) => column.name === name)?.notnull).toBe(1)
    }

    const foreignKeys = raw
      .query("PRAGMA foreign_key_list('opencode_session_owners')")
      .all() as Array<{ table: string; from: string; to: string; on_delete: string }>
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]).toMatchObject({
      table: 'tasks',
      from: 'task_id',
      to: 'id',
      on_delete: 'CASCADE',
    })

    const indexes = raw.query("PRAGMA index_list('opencode_session_owners')").all() as Array<{
      name: string
      unique: number
    }>
    expect(
      indexes.find((index) => index.name === 'uniq_opencode_session_owners_store_key'),
    ).toEqual(expect.objectContaining({ unique: 1 }))
    for (const name of [
      'idx_opencode_session_owners_task',
      'idx_opencode_session_owners_created_run',
      'idx_opencode_session_owners_lease_run',
    ]) {
      expect(indexes.some((index) => index.name === name)).toBe(true)
    }
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })

  test('enforces owner/store uniqueness and all-null/all-nonnull lease shape', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })
    seedTask(raw, 'constraints')

    insertOwner(raw, {
      sessionId: 'session-a',
      taskId: 'task-constraints',
      storeKey: 'store-a',
    })
    expect(() =>
      insertOwner(raw, {
        sessionId: 'session-a',
        taskId: 'task-constraints',
        storeKey: 'store-b',
      }),
    ).toThrow()
    expect(() =>
      insertOwner(raw, {
        sessionId: 'session-b',
        taskId: 'task-constraints',
        storeKey: 'store-a',
      }),
    ).toThrow()
    expect(() =>
      insertOwner(raw, {
        sessionId: 'session-partial',
        taskId: 'task-constraints',
        storeKey: 'store-partial',
        leaseRunId: 'run-constraints',
      }),
    ).toThrow()

    insertOwner(raw, {
      sessionId: 'session-leased',
      taskId: 'task-constraints',
      storeKey: 'store-leased',
      createdRunId: 'run-constraints',
      leaseRunId: 'run-constraints',
      nonceDigest: 'nonce',
      leasedAt: 123,
    })
    expect(
      raw
        .query(
          `SELECT lease_node_run_id AS runId, lease_nonce_digest AS nonce, leased_at AS leasedAt
           FROM opencode_session_owners WHERE session_id = 'session-leased'`,
        )
        .get(),
    ).toEqual({ runId: 'run-constraints', nonce: 'nonce', leasedAt: 123 })

    raw.exec("DELETE FROM tasks WHERE id = 'task-constraints'")
    expect(raw.query('SELECT COUNT(*) AS count FROM opencode_session_owners').get()).toEqual({
      count: 0,
    })
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})
