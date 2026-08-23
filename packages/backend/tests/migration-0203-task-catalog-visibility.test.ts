import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  import.meta.dir,
  '..',
  'db',
  'migrations',
  '0203_task_catalog_visibility.sql',
)

describe('migration 0203 — generic task catalog visibility', () => {
  test('defaults ordinary rows to public and backfills every legacy internal execution descendant', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        parent_task_id TEXT,
        digital_employee_round_id TEXT
      );
      INSERT INTO tasks (id, parent_task_id, digital_employee_round_id) VALUES
        ('public-root', NULL, NULL),
        ('public-child', 'public-root', NULL),
        ('internal-root', NULL, 'legacy-round'),
        ('internal-child', 'internal-root', NULL),
        ('internal-grandchild', 'internal-child', NULL),
        ('internal-marked-child', 'public-root', 'legacy-round-2'),
        ('internal-marked-grandchild', 'internal-marked-child', NULL);
    `)

    sqlite.exec(readFileSync(MIGRATION, 'utf8'))

    const rows = sqlite
      .query('SELECT id, catalog_visibility AS visibility FROM tasks ORDER BY id')
      .all() as Array<{ id: string; visibility: string }>
    expect(rows).toEqual([
      { id: 'internal-child', visibility: 'internal' },
      { id: 'internal-grandchild', visibility: 'internal' },
      { id: 'internal-marked-child', visibility: 'internal' },
      { id: 'internal-marked-grandchild', visibility: 'internal' },
      { id: 'internal-root', visibility: 'internal' },
      { id: 'public-child', visibility: 'public' },
      { id: 'public-root', visibility: 'public' },
    ])

    sqlite.query("INSERT INTO tasks (id) VALUES ('future-public')").run()
    expect(
      sqlite
        .query("SELECT catalog_visibility AS visibility FROM tasks WHERE id = 'future-public'")
        .get(),
    ).toEqual({ visibility: 'public' })
    sqlite.close()
  })
})
