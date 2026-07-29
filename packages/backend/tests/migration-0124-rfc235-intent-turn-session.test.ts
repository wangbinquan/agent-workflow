import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

function freezeThrough0123(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc235-0124-'))
  tempDirs.push(dir)
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 122)
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('migration 0124 RFC-235 intent turn Session capture', () => {
  test('upgrades legacy turns and cascades their independent event rows', () => {
    const raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    migrate(drizzle(raw), { migrationsFolder: freezeThrough0123() })
    raw.exec(`
      INSERT INTO intent_sessions (
        id, owner_user_id, title, status, context_revision,
        context_manifest_json, turn_seq, commit_seq, budget_json,
        created_at, updated_at
      ) VALUES ('session-1', 'owner-1', 'goal', 'active', 0, '[]', 1, 0, '{}', 1, 1);
      INSERT INTO intent_turns (
        id, session_id, seq, role, kind, content_json,
        context_revision, scratch_retained, created_at
      ) VALUES ('turn-1', 'session-1', 1, 'agent', 'changeset', '{}', 0, 0, 1);
    `)

    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS })

    expect(
      raw
        .query(
          `SELECT capture_state AS captureState,
                  capture_last_event_seq AS lastEventSeq,
                  capture_event_bytes AS eventBytes
             FROM intent_turns WHERE id='turn-1'`,
        )
        .get(),
    ).toEqual({ captureState: null, lastEventSeq: 0, eventBytes: 0 })

    raw.exec(`
      INSERT INTO intent_turn_events (
        turn_id, event_seq, ts, kind, payload, session_id,
        parent_session_id, source, external_event_id
      ) VALUES ('turn-1', 1, 2, 'text', '{}', 'runtime-root', NULL, 'stream', 'part-1');
    `)
    expect(raw.query('SELECT count(*) AS count FROM intent_turn_events').get()).toEqual({
      count: 1,
    })
    raw.exec("DELETE FROM intent_turns WHERE id='turn-1'")
    expect(raw.query('SELECT count(*) AS count FROM intent_turn_events').get()).toEqual({
      count: 0,
    })
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})
