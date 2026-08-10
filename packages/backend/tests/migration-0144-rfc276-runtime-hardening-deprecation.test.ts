import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const tempDirs: string[] = []

function freezeThrough0143(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc276-0144-'))
  tempDirs.push(dir)
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 142)
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  return dir
}

function columns(raw: Database, table: string): string[] {
  return (raw.query(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  )
}

function tableExists(raw: Database, table: string): boolean {
  return (
    raw.query("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table) !==
    null
  )
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('migration 0144 RFC-276 runtime hardening deprecation', () => {
  test('archives removed state before upgrading a populated 0143 database', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0143() })

    const definition = JSON.stringify({
      nodes: [
        { id: 'script-a', kind: 'script', network: 'allow', script: 'print(1)' },
        { id: 'output-a', kind: 'output' },
      ],
      edges: [],
    })
    raw
      .query(
        `INSERT INTO users (
           id, username, display_name, role, status, force_password_change,
           created_at, updated_at
         ) VALUES ('user-rfc276', 'user-rfc276', 'RFC 276', 'user', 'active', 0, 1, 1)`,
      )
      .run()
    raw
      .query(
        "INSERT INTO agents (id, name, network) VALUES ('agent-rfc276', 'agent-rfc276', 'allow')",
      )
      .run()
    raw
      .query(
        "INSERT INTO runtimes (id, name, protocol) VALUES ('runtime-rfc276', 'claude-rfc276', 'claude-code')",
      )
      .run()
    raw
      .query(
        "INSERT INTO workflows (id, name, definition) VALUES ('workflow-rfc276', 'workflow-rfc276', ?)",
      )
      .run(definition)
    raw
      .query(
        `INSERT INTO tasks (
           id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
           base_branch, branch, status, inputs, started_at
         ) VALUES (
           'task-rfc276', 'task-rfc276', 'workflow-rfc276', ?, '/tmp/repo',
           '/tmp/worktree', 'main', 'aw/rfc276', 'running', '{}', 1
         )`,
      )
      .run(definition)
    raw
      .query(
        `INSERT INTO node_runs (
           id, task_id, node_id, status, started_at, finished_at, failure_code
         ) VALUES (
           'run-rfc276', 'task-rfc276', 'script-a', 'failed', 1, 2,
           'execution-identity-mismatch'
         )`,
      )
      .run()
    raw
      .query(
        `INSERT INTO opencode_session_owners (
           session_id, task_id, node_id, created_node_run_id, identity_digest,
           runtime_binary_digest, session_contract_digest, session_store_key,
           project_id, protocol_codec, reported_version
         ) VALUES (
           'native-business-rfc276', 'task-rfc276', 'script-a', 'run-rfc276',
           ?, ?, ?, 'store-business-rfc276', 'project-rfc276',
           'opencode-direct-v1', '1.18.14'
         )`,
      )
      .run(HASH_A, HASH_B, HASH_C)
    raw
      .query(
        `INSERT INTO mcps (
           id, name, description, type, config, enabled, owner_user_id,
           visibility, acl_revision, schema_version, created_at, updated_at
         ) VALUES (
           'mcp-rfc276', 'mcp-rfc276', '', 'local', '{"command":["fixture"]}', 1,
           'user-rfc276', 'private', 0, 1, 1, 1
         )`,
      )
      .run()
    raw
      .query(
        `INSERT INTO mcp_runtime_test_sessions (
           id, mcp_id, owner_user_id, client_create_id, client_create_digest,
           status, mcp_config_hash, runtime_row_id, runtime_name, runtime_protocol,
           runtime_snapshot_json, runtime_fingerprint, runtime_binary_path,
           runtime_binary_digest, mcp_execution_digest, session_contract_digest,
           runtime_session_id, native_session_state, in_flight_turn_id, turn_seq,
           session_version, scratch_root, session_store_root, session_store_db_path,
           cleanup_state, created_at, updated_at
         ) VALUES (
           'mcp-session-rfc276', 'mcp-rfc276', 'user-rfc276', 'create-rfc276', ?,
           'active', ?, 'runtime-rfc276', 'opencode', 'opencode', '{"model":null}', ?,
           '/usr/local/bin/opencode', ?, ?, ?, 'native-mcp-rfc276', 'ready',
           'mcp-turn-rfc276', 1, 1, '/tmp/mcp-session-rfc276',
           '/tmp/mcp-session-rfc276/store', '/tmp/mcp-session-rfc276/store/session.db',
           'not-started', 3, 4
         )`,
      )
      .run(HASH_A, HASH_A, HASH_B, HASH_A, HASH_B, HASH_C)
    raw
      .query(
        `INSERT INTO mcp_runtime_test_turns (
           id, session_id, seq, client_message_id, prompt_text, status,
           hard_deadline_at, capture_state, pid, spawned_at, spawn_binary_path,
           raw_command_digest, spawn_command_digest, started_at, created_at
         ) VALUES (
           'mcp-turn-rfc276', 'mcp-session-rfc276', 1, 'message-rfc276', 'hello',
           'running', 1000, 'live', 4242, 6, '/usr/local/bin/opencode', ?, ?, 5, 3
         )`,
      )
      .run(HASH_A, HASH_B)
    raw
      .query(
        `INSERT INTO mcp_runtime_test_events (
           test_session_id, first_seen_turn_id, event_seq, ts, kind, payload,
           session_id, source
         ) VALUES (
           'mcp-session-rfc276', 'mcp-turn-rfc276', 1, 7, 'text',
           '{"text":"preserved"}', 'native-mcp-rfc276', 'stream'
         )`,
      )
      .run()
    raw
      .query(
        `INSERT INTO opencode_mcp_test_session_owners (
           runtime_session_id, test_session_id, created_turn_id, current_turn_id,
           identity_digest, runtime_binary_digest, session_contract_digest,
           session_store_key, project_id, protocol_codec, reported_version,
           lease_turn_id, lease_acquired_at, lease_nonce_digest
         ) VALUES (
           'native-mcp-rfc276', 'mcp-session-rfc276', 'mcp-turn-rfc276',
           'mcp-turn-rfc276', ?, ?, ?, 'store-mcp-rfc276', 'project-rfc276',
           'opencode-mcp-test-control-v1', '1.18.14', 'mcp-turn-rfc276', 8, ?
         )`,
      )
      .run(HASH_A, HASH_B, HASH_C, HASH_A)

    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    expect(columns(raw, 'agents')).not.toContain('network')
    expect(columns(raw, 'runtimes')).toContain('is_sandbox')
    expect(
      raw.query("SELECT is_sandbox AS isSandbox FROM runtimes WHERE id='runtime-rfc276'").get(),
    ).toEqual({ isSandbox: 0 })
    expect(columns(raw, 'mcp_runtime_test_sessions')).not.toEqual(
      expect.arrayContaining([
        'runtime_fingerprint',
        'runtime_binary_digest',
        'mcp_execution_digest',
        'session_contract_digest',
        'session_store_root',
        'session_store_db_path',
      ]),
    )
    expect(columns(raw, 'mcp_runtime_test_turns')).not.toEqual(
      expect.arrayContaining(['raw_command_digest', 'spawn_command_digest']),
    )
    expect(tableExists(raw, 'opencode_session_owners')).toBe(false)
    expect(tableExists(raw, 'opencode_mcp_test_session_owners')).toBe(false)
    expect(tableExists(raw, 'runtime_session_leases')).toBe(true)
    expect(tableExists(raw, 'mcp_runtime_test_session_leases')).toBe(true)

    const archiveKinds = raw
      .query('SELECT kind FROM rfc276_legacy_runtime_archive ORDER BY kind')
      .all() as Array<{ kind: string }>
    expect(archiveKinds.map((row) => row.kind)).toEqual([
      'agent-network',
      'business-session-owner',
      'mcp-session-owner',
      'mcp-session-removed-state',
      'mcp-turn-removed-state',
      'task-workflow-snapshot',
      'workflow-definition',
    ])
    const archivedAgent = raw
      .query(
        `SELECT payload_json AS payload
         FROM rfc276_legacy_runtime_archive
         WHERE kind='agent-network' AND legacy_key='agent-rfc276'`,
      )
      .get() as { payload: string }
    expect(JSON.parse(archivedAgent.payload)).toEqual({ network: 'allow' })

    for (const table of ['workflows', 'tasks'] as const) {
      const column = table === 'workflows' ? 'definition' : 'workflow_snapshot'
      const row = raw
        .query(`SELECT ${column} AS value FROM ${table} WHERE id=?`)
        .get(table === 'workflows' ? 'workflow-rfc276' : 'task-rfc276') as { value: string }
      const parsed = JSON.parse(row.value) as { nodes: Array<Record<string, unknown>> }
      expect(parsed.nodes.map((node) => node.id)).toEqual(['script-a', 'output-a'])
      expect(parsed.nodes[0]).toEqual({
        id: 'script-a',
        kind: 'script',
        script: 'print(1)',
      })
    }

    expect(
      raw.query("SELECT failure_code AS code FROM node_runs WHERE id='run-rfc276'").get(),
    ).toEqual({ code: 'execution-identity-mismatch' })
    expect(
      raw
        .query(
          `SELECT status, end_reason AS endReason, runtime_session_id AS runtimeSessionId,
                  cleanup_state AS cleanupState, cleanup_error_code AS cleanupErrorCode
           FROM mcp_runtime_test_sessions WHERE id='mcp-session-rfc276'`,
        )
        .get(),
    ).toEqual({
      status: 'ended',
      endReason: 'runtime-session-reset',
      runtimeSessionId: null,
      cleanupState: 'quarantined',
      cleanupErrorCode: 'mcp-test-runtime-session-reset-reap-required',
    })
    expect(
      raw
        .query(
          `SELECT status, capture_state AS captureState, capture_incomplete_reason AS captureReason,
                  pid, failure_code AS failureCode
           FROM mcp_runtime_test_turns WHERE id='mcp-turn-rfc276'`,
        )
        .get(),
    ).toEqual({
      status: 'interrupted',
      captureState: 'incomplete',
      captureReason: 'post-exit-flush-timeout',
      pid: 4242,
      failureCode: 'mcp-test-runtime-session-reset',
    })
    expect(raw.query('SELECT count(*) AS count FROM mcp_runtime_test_events').get()).toEqual({
      count: 1,
    })
    expect(raw.query('SELECT count(*) AS count FROM runtime_session_leases').get()).toEqual({
      count: 0,
    })
    expect(
      raw.query('SELECT count(*) AS count FROM mcp_runtime_test_session_leases').get(),
    ).toEqual({ count: 0 })
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })

  test('fresh replay exposes only the natural runtime session tables', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })
    expect(tableExists(raw, 'rfc276_legacy_runtime_archive')).toBe(true)
    expect(tableExists(raw, 'runtime_session_leases')).toBe(true)
    expect(tableExists(raw, 'mcp_runtime_test_session_leases')).toBe(true)
    expect(tableExists(raw, 'opencode_session_owners')).toBe(false)
    expect(tableExists(raw, 'opencode_mcp_test_session_owners')).toBe(false)
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})
