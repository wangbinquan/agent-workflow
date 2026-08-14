// RFC-303 migration lock: old rows stay unprotected, body_json remains the
// physical tail column, MR fact dedupe excludes replay rows, and every control
// ledger link is soft (no trigger/task/delivery cascade).
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SQL = readFileSync(
  resolve(import.meta.dir, '..', 'db', 'migrations', '0157_rfc303_mr_terminal_control.sql'),
  'utf8',
)

const opened: Database[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function fixture(): Database {
  const db = new Database(':memory:')
  opened.push(db)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE webhook_triggers (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL
    );
    CREATE TABLE tasks (
      id text PRIMARY KEY NOT NULL,
      workspace_pruning_at integer
    );
    CREATE TABLE webhook_deliveries (
      id text PRIMARY KEY NOT NULL,
      endpoint_id text NOT NULL,
      event_uuid text,
      attempt_count integer NOT NULL DEFAULT 1,
      gitlab_event_header text,
      object_kind text,
      event_type text,
      repo_path text,
      stream_hint text,
      status text NOT NULL,
      status_reason text,
      replayed_from_delivery_id text,
      received_at integer NOT NULL DEFAULT (unixepoch() * 1000),
      body_json text
    );
    CREATE UNIQUE INDEX idx_webhook_deliveries_dedupe
      ON webhook_deliveries(endpoint_id,event_uuid)
      WHERE event_uuid IS NOT NULL AND status NOT IN ('rejected','failed');
    CREATE INDEX idx_webhook_deliveries_endpoint_time
      ON webhook_deliveries(endpoint_id,received_at);
    CREATE INDEX idx_webhook_deliveries_received_at ON webhook_deliveries(received_at);
    CREATE INDEX idx_webhook_deliveries_status_time ON webhook_deliveries(status,received_at);
    CREATE INDEX idx_webhook_deliveries_event_time ON webhook_deliveries(event_type,received_at);
    CREATE INDEX idx_webhook_deliveries_repo_time ON webhook_deliveries(repo_path,received_at);
    CREATE INDEX idx_webhook_deliveries_body_retention
      ON webhook_deliveries(received_at) WHERE body_json IS NOT NULL;

    INSERT INTO webhook_triggers(id,name) VALUES ('trigger-old','old');
    INSERT INTO tasks(id,workspace_pruning_at) VALUES ('task-old',NULL);
    INSERT INTO webhook_deliveries(
      id,endpoint_id,event_uuid,event_type,repo_path,status,received_at,body_json
    ) VALUES ('delivery-old','endpoint-1','uuid-old','mr_opened','a/b','matched',1,'{"old":true}');
  `)
  for (const statement of SQL.split('--> statement-breakpoint')) {
    if (statement.trim() !== '') db.exec(statement)
  }
  return db
}

describe('migration 0157 RFC-303 MR terminal control', () => {
  test('upgrade preserves rows and defaults every historical trigger/task to unprotected', () => {
    const db = fixture()
    expect(
      db.query('SELECT cancel_on_mr_terminal FROM webhook_triggers WHERE id=?').get('trigger-old'),
    ).toEqual({ cancel_on_mr_terminal: 0 })
    expect(
      db
        .query(
          `SELECT source_termination_binding, source_termination_launch_rev,
                  source_termination_fence, source_termination_effect_rev
             FROM tasks WHERE id=?`,
        )
        .get('task-old'),
    ).toEqual({
      source_termination_binding: null,
      source_termination_launch_rev: null,
      source_termination_fence: null,
      source_termination_effect_rev: null,
    })
    expect(
      db
        .query(
          'SELECT mr_fact_key,mr_stream_key,mr_stream_revision,mr_state_after,body_json FROM webhook_deliveries WHERE id=?',
        )
        .get('delivery-old'),
    ).toEqual({
      mr_fact_key: null,
      mr_stream_key: null,
      mr_stream_revision: null,
      mr_state_after: null,
      body_json: '{"old":true}',
    })
  })

  test('body_json remains last and root fact dedupe permits explicit replay rows', () => {
    const db = fixture()
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(webhook_deliveries)').all()
    expect(columns.at(-1)?.name).toBe('body_json')

    const insert = db.query(`
      INSERT INTO webhook_deliveries(
        id,endpoint_id,event_uuid,event_type,status,replayed_from_delivery_id,
        mr_fact_key,mr_stream_key,mr_stream_revision,mr_state_after,body_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `)
    insert.run(
      'root',
      'endpoint-1',
      null,
      'mr_closed',
      'received',
      null,
      'body:v1:same',
      '["mr-stream-v1","p","1"]',
      1,
      'closed',
      '{}',
    )
    expect(() =>
      insert.run(
        'duplicate-root',
        'endpoint-1',
        null,
        'mr_closed',
        'received',
        null,
        'body:v1:same',
        '["mr-stream-v1","p","1"]',
        1,
        'closed',
        '{}',
      ),
    ).toThrow()
    expect(() =>
      insert.run(
        'explicit-replay',
        'endpoint-1',
        null,
        'mr_closed',
        'received',
        'root',
        'body:v1:same',
        '["mr-stream-v1","p","1"]',
        1,
        'closed',
        '{}',
      ),
    ).not.toThrow()
  })

  test('checks reject invalid values and new ledgers carry no foreign keys', () => {
    const db = fixture()
    expect(() =>
      db.query("UPDATE webhook_triggers SET cancel_on_mr_terminal=2 WHERE id='trigger-old'").run(),
    ).toThrow()
    expect(() =>
      db.query("UPDATE tasks SET source_termination_fence='reopened' WHERE id='task-old'").run(),
    ).toThrow()

    for (const table of [
      'webhook_mr_stream_states',
      'webhook_mr_launch_guards',
      'webhook_mr_control_effects',
      'webhook_mr_control_targets',
    ]) {
      expect(db.query(`PRAGMA foreign_key_list(${table})`).all()).toEqual([])
    }
  })
})
