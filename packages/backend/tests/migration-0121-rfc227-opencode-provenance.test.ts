// RFC-227 — upgrades the RFC-224 owner provenance without losing sessions or
// leases. Version becomes nullable telemetry; byte identity + protocol codec
// are the only runtime provenance fields used by resume admission.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []
const LEGACY_DIGEST = 'b'.repeat(64)

function freezeThrough0120(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc227-0121-'))
  tempDirs.push(dir)
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 119)
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  return dir
}

function seedLegacyOwner(raw: Database): void {
  raw.exec(`
    INSERT INTO workflows (id, name, definition)
    VALUES ('workflow-rfc227', 'workflow-rfc227', '{}');
    INSERT INTO tasks (
      id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
      base_branch, branch, status, inputs, started_at
    ) VALUES (
      'task-rfc227', 'task-rfc227', 'workflow-rfc227', '{}',
      '/tmp/repo', '/tmp/worktree', 'main', 'aw/rfc227', 'running', '{}', 1
    );
    INSERT INTO node_runs (id, task_id, node_id, status)
    VALUES ('run-rfc227', 'task-rfc227', 'node-rfc227', 'running');
    INSERT INTO opencode_session_owners (
      session_id, task_id, node_id, created_node_run_id,
      identity_digest, official_build_digest, session_contract_digest,
      session_store_key, project_id, opencode_version,
      lease_node_run_id, lease_nonce_digest, leased_at
    ) VALUES (
      'session-rfc227', 'task-rfc227', 'node-rfc227', 'run-rfc227',
      'identity-rfc227', '${LEGACY_DIGEST}', 'contract-rfc227',
      'store-rfc227', 'project-rfc227', 'legacy-custom-version',
      'run-rfc227', 'nonce-rfc227', 227
    );
  `)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('migration 0121 RFC-227 OpenCode provenance', () => {
  test('preserves owner and lease while replacing version-bound provenance', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0120() })
    seedLegacyOwner(raw)

    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    const columns = raw.query("PRAGMA table_info('opencode_session_owners')").all() as Array<{
      name: string
      notnull: number
    }>
    expect(columns.map((column) => column.name)).toEqual([
      'session_id',
      'task_id',
      'node_id',
      'created_node_run_id',
      'identity_digest',
      'runtime_binary_digest',
      'session_contract_digest',
      'session_store_key',
      'project_id',
      'protocol_codec',
      'reported_version',
      'lease_node_run_id',
      'lease_nonce_digest',
      'leased_at',
    ])
    expect(columns.some((column) => column.name === 'official_build_digest')).toBe(false)
    expect(columns.some((column) => column.name === 'opencode_version')).toBe(false)
    expect(columns.find((column) => column.name === 'reported_version')?.notnull).toBe(0)

    expect(
      raw
        .query(
          `SELECT
             runtime_binary_digest AS runtimeBinaryDigest,
             protocol_codec AS protocolCodec,
             reported_version AS reportedVersion,
             lease_node_run_id AS leaseNodeRunId,
             lease_nonce_digest AS leaseNonceDigest,
             leased_at AS leasedAt
           FROM opencode_session_owners
           WHERE session_id = 'session-rfc227'`,
        )
        .get(),
    ).toEqual({
      runtimeBinaryDigest: LEGACY_DIGEST,
      protocolCodec: 'opencode-direct-v1',
      reportedVersion: 'legacy-custom-version',
      leaseNodeRunId: 'run-rfc227',
      leaseNonceDigest: 'nonce-rfc227',
      leasedAt: 227,
    })

    const indexes = raw.query("PRAGMA index_list('opencode_session_owners')").all() as Array<{
      name: string
    }>
    for (const name of [
      'uniq_opencode_session_owners_store_key',
      'idx_opencode_session_owners_task',
      'idx_opencode_session_owners_created_run',
      'idx_opencode_session_owners_lease_run',
    ]) {
      expect(indexes.some((index) => index.name === name)).toBe(true)
    }
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})
