// RFC-292 — migration 0150 must wrap only valid historical flat contexts.
// Corrupt rows stay untouched so runtime can diagnose them as invalid instead
// of laundering them into a seemingly canonical snapshot.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTempDirSync } from './fixtures/tempDir'

const tempDirs: string[] = []
const migrationSql = readFileSync(
  resolve(import.meta.dir, '..', 'db', 'migrations', '0150_rfc292_trigger_namespace.sql'),
  'utf8',
)

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDirSync(dir)
})

function fixtureDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), 'rfc292-0150-'))
  tempDirs.push(dir)
  const raw = new Database(join(dir, 'db.sqlite'))
  raw.exec(`
    CREATE TABLE webhook_triggers (id text PRIMARY KEY NOT NULL);
    CREATE TABLE tasks (id text PRIMARY KEY NOT NULL, trigger_context_json text);

    INSERT INTO webhook_triggers (id) VALUES ('existing-trigger');
    INSERT INTO tasks (id, trigger_context_json) VALUES
      ('flat-valid', '{"event_type":"note","mr_iid":"42","event_json":"{}"}'),
      ('already-nested', '{"trigger":{"webhook":{"event_type":"note","mr_iid":"7"}}}'),
      ('bad-json', '{'),
      ('unknown-key', '{"event_type":"note","surprise":"x"}'),
      ('bad-value-type', '{"event_type":"note","mr_iid":42}'),
      ('missing-discriminator', '{"mr_iid":"42"}'),
      ('none', NULL);
  `)
  raw.exec(migrationSql)
  return raw
}

describe('migration 0150 · RFC-292 trigger namespace', () => {
  test('adds syntax version 1 for historical and defaulted rows', () => {
    const raw = fixtureDb()
    expect(
      raw
        .query<
          { template_syntax_version: number },
          []
        >(`SELECT template_syntax_version FROM webhook_triggers WHERE id='existing-trigger'`)
        .get()?.template_syntax_version,
    ).toBe(1)
    raw.query(`INSERT INTO webhook_triggers (id) VALUES ('new-default')`).run()
    expect(
      raw
        .query<
          { template_syntax_version: number },
          []
        >(`SELECT template_syntax_version FROM webhook_triggers WHERE id='new-default'`)
        .get()?.template_syntax_version,
    ).toBe(1)
  })

  test('wraps a valid flat row and preserves all invalid/non-flat bytes', () => {
    const raw = fixtureDb()
    const rows = new Map(
      raw
        .query<{ id: string; trigger_context_json: string | null }, []>(
          `SELECT id, trigger_context_json FROM tasks`,
        )
        .all()
        .map((row) => [row.id, row.trigger_context_json]),
    )
    expect(JSON.parse(rows.get('flat-valid')!)).toEqual({
      trigger: {
        webhook: { event_type: 'note', mr_iid: '42', event_json: '{}' },
      },
    })
    expect(rows.get('already-nested')).toBe(
      '{"trigger":{"webhook":{"event_type":"note","mr_iid":"7"}}}',
    )
    expect(rows.get('bad-json')).toBe('{')
    expect(rows.get('unknown-key')).toBe('{"event_type":"note","surprise":"x"}')
    expect(rows.get('bad-value-type')).toBe('{"event_type":"note","mr_iid":42}')
    expect(rows.get('missing-discriminator')).toBe('{"mr_iid":"42"}')
    expect(rows.get('none')).toBeNull()
  })
})
