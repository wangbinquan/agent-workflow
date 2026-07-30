import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

function freezeThrough0124(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc238-0125-'))
  tempDirs.push(dir)
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 123)
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('migration 0125 RFC-238 MCP runtime playground', () => {
  test('adds lifecycle, idempotency, event, and private owner constraints', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0124() })
    raw.exec(`
      INSERT INTO users (
        id, username, display_name, role, status, force_password_change,
        created_at, updated_at
      ) VALUES ('user-1', 'user-1', 'User One', 'user', 'active', 0, 1, 1);
      INSERT INTO mcps (
        id, name, description, type, config, enabled, owner_user_id,
        visibility, acl_revision, schema_version, created_at, updated_at
      ) VALUES (
        'mcp-1', 'fixture', '', 'local', '{"command":["fixture"]}', 1,
        'user-1', 'private', 0, 1, 1, 1
      );
    `)

    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    const hash = 'a'.repeat(64)
    const nonHexHash = `${'a'.repeat(63)}z`
    const sessionTable = raw
      .query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_runtime_test_sessions'",
      )
      .get() as { sql: string }
    expect(sessionTable.sql).toContain("NOT GLOB '*[^0-9a-f]*'")
    expect(raw.query("SELECT ? NOT GLOB '*[^0-9a-f]*' AS valid").get(nonHexHash)).toEqual({
      valid: 0,
    })
    expect(raw.query('PRAGMA ignore_check_constraints').get()).toEqual({
      ignore_check_constraints: 0,
    })
    const invalidHashInsert = raw.query(`
        INSERT INTO mcp_runtime_test_sessions (
          id, mcp_id, owner_user_id, client_create_id, client_create_digest,
          status, mcp_config_hash, runtime_row_id, runtime_name, runtime_protocol,
          runtime_snapshot_json, runtime_fingerprint, runtime_binary_path,
          native_session_state, in_flight_turn_id, turn_seq, session_version,
          scratch_root, session_store_root, cleanup_state, created_at, updated_at
        ) VALUES (
          'invalid-hash-session', 'mcp-1', 'user-1', 'invalid-hash-create', '${hash}',
          'active', ?, 'runtime-1', 'opencode', 'opencode', '{}',
          '${hash}', 'opencode', 'pending', 'invalid-hash-turn', 1, 1,
          '/tmp/invalid-hash-session', '/tmp/invalid-hash-session/run',
          'not-started', 1, 1
        );
      `)
    expect(() => invalidHashInsert.run(nonHexHash)).toThrow()
    raw.exec(`
      INSERT INTO mcp_runtime_test_sessions (
        id, mcp_id, owner_user_id, client_create_id, client_create_digest,
        status, mcp_config_hash, runtime_row_id, runtime_name, runtime_protocol,
        runtime_snapshot_json, runtime_fingerprint, runtime_binary_path,
        runtime_session_id, native_session_state, in_flight_turn_id, turn_seq,
        session_version, scratch_root, session_store_root, cleanup_state,
        created_at, updated_at
      ) VALUES (
        'session-1', 'mcp-1', 'user-1', 'create-1', '${hash}', 'active',
        '${hash}', 'runtime-1', 'opencode', 'opencode', '{}', '${hash}',
        'opencode', NULL, 'pending', 'turn-1', 1, 1, '/tmp/session-1',
        '/tmp/session-1/run', 'not-started', 1, 1
      );
      INSERT INTO mcp_runtime_test_turns (
        id, session_id, seq, client_message_id, prompt_text, status,
        hard_deadline_at, capture_state, created_at
      ) VALUES ('turn-1', 'session-1', 1, 'message-1', 'hello', 'queued', 600001, 'live', 1);
      INSERT INTO mcp_runtime_test_events (
        test_session_id, first_seen_turn_id, event_seq, ts, kind, payload,
        session_id, parent_session_id, source
      ) VALUES ('session-1', 'turn-1', 1, 2, 'text', '{}', NULL, NULL, 'stream');
      INSERT INTO mcp_runtime_test_create_receipts (
        mcp_id, owner_user_id, client_create_id, request_digest,
        session_id, accepted_turn_id, created_at, expires_at
      ) VALUES ('mcp-1', 'user-1', 'create-1', '${hash}', 'session-1', 'turn-1', 1, 86400001);
    `)

    const duplicateLiveSession = raw.query(`
        INSERT INTO mcp_runtime_test_sessions (
          id, mcp_id, owner_user_id, client_create_id, client_create_digest,
          status, mcp_config_hash, runtime_row_id, runtime_name, runtime_protocol,
          runtime_snapshot_json, runtime_fingerprint, runtime_binary_path,
          native_session_state, in_flight_turn_id, turn_seq, session_version,
          scratch_root, session_store_root, cleanup_state, created_at, updated_at
        ) VALUES (
          'session-2', 'mcp-1', 'user-1', 'create-2', '${hash}', 'active',
          '${hash}', 'runtime-1', 'opencode', 'opencode', '{}', '${hash}',
          'opencode', 'pending', 'turn-2', 1, 1, '/tmp/session-2',
          '/tmp/session-2/run', 'not-started', 1, 1
        );
      `)
    expect(() => duplicateLiveSession.run()).toThrow()
    expect(() =>
      raw
        .query(
          `
        INSERT INTO mcp_runtime_test_events (
          test_session_id, first_seen_turn_id, event_seq, ts, kind, payload,
          source
        ) VALUES ('session-1', 'turn-1', 2, 3, 'text', '{}', 'unknown-source');
      `,
        )
        .run(),
    ).toThrow()
    expect(() =>
      raw
        .query(
          `
        INSERT INTO mcp_runtime_test_create_receipts (
          mcp_id, owner_user_id, client_create_id, request_digest,
          session_id, accepted_turn_id, created_at, expires_at
        ) VALUES (
          'mcp-1', 'user-1', 'bad-digest-create', '${nonHexHash}',
          'session-1', 'turn-1', 1, 2
        );
      `,
        )
        .run(),
    ).toThrow()
    expect(() =>
      raw
        .query(
          `
        UPDATE mcp_runtime_test_turns
        SET spawned_at = 2, spawn_binary_path = '/sealed/runtime'
        WHERE id = 'turn-1';
      `,
        )
        .run(),
    ).toThrow()
    expect(() =>
      raw
        .query(
          `
        UPDATE mcp_runtime_test_turns
        SET status = 'failed'
        WHERE id = 'turn-1';
      `,
        )
        .run(),
    ).toThrow()
    expect(() =>
      raw
        .query(
          `
        UPDATE mcp_runtime_test_sessions
        SET in_flight_turn_id = NULL, idle_deadline_at = 600001
        WHERE id = 'session-1';
      `,
        )
        .run(),
    ).toThrow()
    raw.exec(`
      UPDATE mcp_runtime_test_sessions
      SET runtime_binary_digest = '${hash}',
          mcp_execution_digest = '${hash}',
          session_contract_digest = '${hash}'
      WHERE id = 'session-1';
    `)
    expect(() =>
      raw
        .query(
          `
        INSERT INTO opencode_mcp_test_session_owners (
          runtime_session_id, test_session_id, created_turn_id, current_turn_id,
          identity_digest, runtime_binary_digest, session_contract_digest,
          session_store_key, project_id, protocol_codec, reported_version
        ) VALUES (
          'native-invalid', 'session-1', 'turn-1', 'turn-1',
          '${nonHexHash}', '${hash}', '${hash}', 'm_store', 'project-1',
          'opencode-mcp-test-control-v1', NULL
        );
      `,
        )
        .run(),
    ).toThrow()
    raw.exec(`
      INSERT INTO opencode_mcp_test_session_owners (
        runtime_session_id, test_session_id, created_turn_id, current_turn_id,
        identity_digest, runtime_binary_digest, session_contract_digest,
        session_store_key, project_id, protocol_codec, reported_version
      ) VALUES (
        'native-valid', 'session-1', 'turn-1', 'turn-1',
        '${hash}', '${hash}', '${hash}', 'm_store', 'project-1',
        'opencode-mcp-test-control-v1', NULL
      );
    `)
    expect(() => raw.exec("DELETE FROM mcps WHERE id='mcp-1'")).toThrow()
    expect(() => raw.exec("DELETE FROM mcp_runtime_test_sessions WHERE id='session-1'")).toThrow()

    raw.exec("DELETE FROM opencode_mcp_test_session_owners WHERE runtime_session_id='native-valid'")
    raw.exec("DELETE FROM mcp_runtime_test_sessions WHERE id='session-1'")
    expect(raw.query('SELECT count(*) AS count FROM mcp_runtime_test_turns').get()).toEqual({
      count: 0,
    })
    expect(raw.query('SELECT count(*) AS count FROM mcp_runtime_test_events').get()).toEqual({
      count: 0,
    })
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})
