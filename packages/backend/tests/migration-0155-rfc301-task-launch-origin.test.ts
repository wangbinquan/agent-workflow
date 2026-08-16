// RFC-301 migration 0155 — deterministic historical origin and rollback fence.
//
// Historical API cannot be reconstructed, canonical webhook JSON must be
// strict, roots overwrite descendant-local evidence, malformed graph rows must
// terminate, and an old writer's default-manual child must be repaired by the
// DB trigger inside its INSERT transaction.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { CODE_HOST_EVENT_TYPES, TRIGGER_CONTEXT_FIELDS } from '@agent-workflow/shared'

const SQL = readFileSync(
  resolve(import.meta.dir, '..', 'db', 'migrations', '0155_rfc301_task_launch_origin.sql'),
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
    CREATE TABLE tasks (
      id text PRIMARY KEY NOT NULL,
      parent_task_id text,
      scheduled_task_id text,
      webhook_trigger_id text,
      webhook_fire_id text,
      trigger_context_json text
    );

    INSERT INTO tasks VALUES
      ('manual-root', NULL, NULL, NULL, NULL, NULL),
      ('historical-api-unknown', NULL, NULL, NULL, NULL, NULL),
      ('scheduled-root', NULL, 'schedule-1', NULL, NULL, NULL),
      ('scheduled-child-local-webhook', 'scheduled-root', NULL, 'trigger-child', NULL, NULL),
      ('scheduled-grandchild', 'scheduled-child-local-webhook', NULL, NULL, NULL, NULL),
      ('webhook-id-root', NULL, NULL, 'trigger-1', NULL, NULL),
      ('webhook-context-root', NULL, NULL, NULL, NULL,
        '{"trigger":{"webhook":{"event_type":"note","mr_iid":"42"}}}'),
      ('bad-json', NULL, NULL, NULL, NULL, '{'),
      ('extra-root-key', NULL, NULL, NULL, NULL,
        '{"trigger":{"webhook":{"event_type":"note"}},"surprise":"x"}'),
      ('extra-trigger-key', NULL, NULL, NULL, NULL,
        '{"trigger":{"webhook":{"event_type":"note"},"other":{}}}'),
      ('unknown-webhook-key', NULL, NULL, NULL, NULL,
        '{"trigger":{"webhook":{"event_type":"note","surprise":"x"}}}'),
      ('non-text-leaf', NULL, NULL, NULL, NULL,
        '{"trigger":{"webhook":{"event_type":"note","mr_iid":42}}}'),
      ('unknown-event', NULL, NULL, NULL, NULL,
        '{"trigger":{"webhook":{"event_type":"future"}}}'),
      ('dangling-scheduled', 'missing-parent', 'schedule-dangling', NULL, NULL, NULL),
      ('cycle-webhook', 'cycle-scheduled', NULL, NULL, 'fire-cycle', NULL),
      ('cycle-scheduled', 'cycle-webhook', 'schedule-cycle', NULL, NULL, NULL);
  `)
  db.exec(SQL)
  return db
}

function origins(db: Database): Map<string, string> {
  return new Map(
    db
      .query<{ id: string; launch_origin: string }, []>(
        'SELECT id, launch_origin FROM tasks ORDER BY id',
      )
      .all()
      .map((row) => [row.id, row.launch_origin]),
  )
}

describe('migration 0155 · RFC-301 task launch origin', () => {
  test('backfills durable roots, propagates root origin, and never guesses historical API', () => {
    const rows = origins(fixture())
    expect(rows.get('manual-root')).toBe('manual')
    expect(rows.get('historical-api-unknown')).toBe('manual')
    expect(rows.get('scheduled-root')).toBe('scheduled')
    expect(rows.get('scheduled-child-local-webhook')).toBe('scheduled')
    expect(rows.get('scheduled-grandchild')).toBe('scheduled')
    expect(rows.get('webhook-id-root')).toBe('webhook')
    expect(rows.get('webhook-context-root')).toBe('webhook')

    for (const id of [
      'bad-json',
      'extra-root-key',
      'extra-trigger-key',
      'unknown-webhook-key',
      'non-text-leaf',
      'unknown-event',
    ]) {
      expect(rows.get(id)).toBe('manual')
    }

    // Rows outside a rooted tree keep their best local evidence and the
    // migration terminates instead of inventing a root.
    expect(rows.get('dangling-scheduled')).toBe('scheduled')
    expect(rows.get('cycle-webhook')).toBe('webhook')
    expect(rows.get('cycle-scheduled')).toBe('scheduled')
  })

  test('CHECK rejects unknown values and child trigger repairs omitted or conflicting writes', () => {
    const db = fixture()
    expect(() =>
      db.query('INSERT INTO tasks (id, launch_origin) VALUES (?, ?)').run('bad-origin', 'node'),
    ).toThrow()

    db.query("UPDATE tasks SET launch_origin='api' WHERE id='manual-root'").run()
    db.query("INSERT INTO tasks (id, parent_task_id) VALUES ('old-child', 'manual-root')").run()
    db.query(
      "INSERT INTO tasks (id, parent_task_id, launch_origin) VALUES ('wrong-child', 'manual-root', 'scheduled')",
    ).run()
    db.query("INSERT INTO tasks (id, parent_task_id) VALUES ('grandchild', 'old-child')").run()
    db.query("INSERT INTO tasks (id) VALUES ('new-root-default')").run()

    const rows = origins(db)
    expect(rows.get('old-child')).toBe('api')
    expect(rows.get('wrong-child')).toBe('api')
    expect(rows.get('grandchild')).toBe('api')
    expect(rows.get('new-root-default')).toBe('manual')
  })

  test('the SQL allowlists are a SUBSET of today’s canonical constants', () => {
    // This assertion used to demand exact equality, which was right while the
    // two lists could not diverge — and wrong the first time one grew. RFC-304
    // T46a added `issue_labeled` / `issue_comment` and six issue fields, and
    // the correct response is NOT to edit this migration.
    //
    // 0155 is a one-time backfill that classified rows written BEFORE it ran.
    // Its allowlist describes what a legacy trigger context could legitimately
    // contain at that moment; a field that did not exist then could not have
    // appeared in one. Editing an applied migration to mention it would change
    // history to say something that was never true, and would rewrite a file
    // every existing database has already executed.
    //
    // What is still worth asserting is the other direction: everything the
    // migration allowed must STILL EXIST. A rename or removal upstream would
    // silently change which legacy rows this backfill matched, and nothing else
    // would notice.
    const fieldBlock = SQL.match(
      /FROM json_each\(`tasks`\.`trigger_context_json`, '\$\.trigger\.webhook'\) AS `webhook_ctx`[\s\S]*?NOT IN \(([\s\S]*?)\)\n\s*\)/,
    )?.[1]
    expect(fieldBlock).toBeDefined()
    const fields = [...(fieldBlock?.matchAll(/'([^']+)'/g) ?? [])].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    )
    // Non-empty first: a regex that stopped matching would make every
    // containment check below vacuously true.
    expect(fields.length).toBeGreaterThan(0)
    const knownFields: readonly string[] = TRIGGER_CONTEXT_FIELDS
    for (const field of fields) expect(knownFields).toContain(field)

    const eventBlock = SQL.match(
      /json_extract\(`trigger_context_json`, '\$\.trigger\.webhook\.event_type'\) IN \(([\s\S]*?)\)/,
    )?.[1]
    expect(eventBlock).toBeDefined()
    const events = [...(eventBlock?.matchAll(/'([^']+)'/g) ?? [])].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    )
    expect(events.length).toBeGreaterThan(0)
    const knownEvents: readonly string[] = CODE_HOST_EVENT_TYPES
    for (const event of events) expect(knownEvents).toContain(event)
  })
})
