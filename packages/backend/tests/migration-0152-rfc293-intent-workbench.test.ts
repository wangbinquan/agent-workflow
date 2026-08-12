// RFC-293 — migration 0152 is intentionally additive: it gives the existing
// Intent engine a durable working-context queue and immutable draft resolution
// without rebuilding or rewriting historical turns/drafts.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTempDirSync } from './fixtures/tempDir'

const tempDirs: string[] = []
const migrationSql = readFileSync(
  resolve(import.meta.dir, '..', 'db', 'migrations', '0152_rfc293_intent_workbench.sql'),
  'utf8',
)

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDirSync(dir)
})

function fixtureDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), 'rfc293-0152-'))
  tempDirs.push(dir)
  const raw = new Database(join(dir, 'db.sqlite'))
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(`
    CREATE TABLE intent_sessions (
      id text PRIMARY KEY NOT NULL
    );
    CREATE TABLE intent_turns (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL REFERENCES intent_sessions(id) ON DELETE CASCADE,
      seq integer NOT NULL,
      content_json text NOT NULL
    );
    CREATE TABLE intent_drafts (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL REFERENCES intent_sessions(id) ON DELETE CASCADE
    );
    INSERT INTO intent_sessions (id) VALUES ('S1');
    INSERT INTO intent_turns (id, session_id, seq, content_json) VALUES ('T1','S1',1,'{}');
    INSERT INTO intent_drafts (id, session_id) VALUES ('D1','S1');
  `)
  raw.exec(migrationSql)
  return raw
}

describe('migration 0152 · RFC-293 Intent workbench', () => {
  test('preserves historical rows and adds nullable mutation identity', () => {
    const raw = fixtureDb()
    expect(
      raw
        .query<
          { client_mutation_id: string | null },
          []
        >("SELECT client_mutation_id FROM intent_turns WHERE id='T1'")
        .get()?.client_mutation_id,
    ).toBeNull()
    raw
      .query(
        "INSERT INTO intent_turns (id,session_id,seq,content_json,client_mutation_id) VALUES ('T2','S1',2,'{}','M1')",
      )
      .run()
    expect(() =>
      raw
        .query(
          "INSERT INTO intent_turns (id,session_id,seq,content_json,client_mutation_id) VALUES ('T3','S1',3,'{}','M1')",
        )
        .run(),
    ).toThrow()
  })

  test('allows one unresolved working-set row and keeps terminal history', () => {
    const raw = fixtureDb()
    const insert = raw.query(`
      INSERT INTO intent_working_set_changes (
        id,session_id,client_mutation_id,request_hash,expected_turn_seq,
        expected_context_revision,mode,delta_json,state,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `)
    insert.run('C1', 'S1', 'M1', 'h1', 1, 0, 'after-current', '{}', 'queued', 1, 1)
    expect(() =>
      insert.run('C2', 'S1', 'M2', 'h2', 1, 0, 'interrupt', '{}', 'failed', 2, 2),
    ).toThrow()
    raw.query("UPDATE intent_working_set_changes SET state='applied' WHERE id='C1'").run()
    insert.run('C2', 'S1', 'M2', 'h2', 1, 0, 'interrupt', '{}', 'failed', 2, 2)
    expect(
      raw
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM intent_working_set_changes')
        .get()?.count,
    ).toBe(2)
  })

  test('records one immutable resolution per draft and cascades with session deletion', () => {
    const raw = fixtureDb()
    raw
      .query(
        "INSERT INTO intent_draft_resolutions (draft_id,session_id,reason,created_at) VALUES ('D1','S1','discarded',1)",
      )
      .run()
    expect(() =>
      raw
        .query(
          "INSERT INTO intent_draft_resolutions (draft_id,session_id,reason,created_at) VALUES ('D1','S1','superseded',2)",
        )
        .run(),
    ).toThrow()
    raw.query("DELETE FROM intent_sessions WHERE id='S1'").run()
    expect(
      raw.query<{ count: number }, []>('SELECT COUNT(*) count FROM intent_draft_resolutions').get()
        ?.count,
    ).toBe(0)
  })
})
