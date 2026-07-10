import { rimrafDir } from './helpers/cleanup'
// RFC-115 PR-E — migration 0058 (SQLite 12-step rebuild that DROPs the dead
// doc_versions.agent_snapshot column) data-copy + index/FK survival lock.
//
// WHY THIS FILE EXISTS (regression intent):
//   agent_snapshot was always NULL (review.ts wrote `?? null`, no producer), so
//   there's no data to lose — but the 12-step rebuild still copies every OTHER
//   column and must preserve both FKs + all three indexes. A wrong / misordered
//   INSERT..SELECT list silently corrupts review rows; a forgotten CREATE INDEX
//   silently drops a lookup path. This test applies migrations THROUGH 0057
//   (agent_snapshot still present), inserts a doc_version row with distinct
//   values, applies 0058, and asserts agent_snapshot is gone, every other column
//   round-trips, the row count is unchanged, and the 3 indexes + 2 FKs survive.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}
interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8')) as Journal
}

function freezeAt(idx: number, outDbPath: string): void {
  const full = readJournal()
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig0058-partial-'))
  try {
    mkdirSync(join(dir, 'meta'), { recursive: true })
    const partial: Journal = { ...full, entries: full.entries.slice(0, idx + 1) }
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(partial, null, 2), 'utf-8')
    for (const e of partial.entries) {
      copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`))
      const snap = `${String(e.idx).padStart(4, '0')}_snapshot.json`
      if (existsSync(join(MIGRATIONS, 'meta', snap))) {
        copyFileSync(join(MIGRATIONS, 'meta', snap), join(dir, 'meta', snap))
      }
    }
    const sqlite = new Database(outDbPath, { create: true })
    sqlite.exec('PRAGMA foreign_keys = ON;')
    migrate(drizzle(sqlite, {}), { migrationsFolder: dir })
    sqlite.close()
  } finally {
    rimrafDir(dir)
  }
}

const docVersionCols = (db: Database): string[] =>
  (db.query('PRAGMA table_info(doc_versions)').all() as Array<{ name: string }>).map((c) => c.name)

const idx0057 = (): number => {
  const e = readJournal().entries.find((j) => j.tag.startsWith('0057'))
  if (e === undefined) throw new Error('0057 not in journal')
  return e.idx
}

describe('RFC-115 migration 0058 — DROP doc_versions.agent_snapshot', () => {
  test('agent_snapshot dropped; row data, indexes and FKs survive the rebuild', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-mig0058-'))
    const dbPath = join(tmp, 'pre.sqlite')
    try {
      freezeAt(idx0057(), dbPath)
      const pre = new Database(dbPath)
      pre.exec('PRAGMA foreign_keys = OFF;')
      expect(docVersionCols(pre)).toContain('agent_snapshot')
      // Distinct values across columns; agent_snapshot NULL (it always was).
      pre.run(
        `INSERT INTO doc_versions (id, task_id, review_node_id, review_node_run_id,
           source_node_id, source_port_name, version_index, review_iteration, body_path,
           comments_json, decision, decision_reason, prompt_snapshot, source_file_path,
           item_index, selection, item_path, created_at, decided_at, decided_by, decided_by_role)
         VALUES ('01DV1','task1','rev-node','run1','src-node','design',2,3,'rev/a.md',
           '[{"c":1}]','approved','looks good','prompt-x','src/a.md',1,'accepted','m/a.md',
           12345,67890,'local','owner')`,
      )
      pre.close()

      const up = new Database(dbPath)
      up.exec('PRAGMA foreign_keys = OFF;')
      migrate(drizzle(up, {}), { migrationsFolder: MIGRATIONS })

      const cols = docVersionCols(up)
      expect(cols).not.toContain('agent_snapshot')
      // Every other column survives (prompt_snapshot + the multi-doc fields).
      for (const c of ['prompt_snapshot', 'item_index', 'selection', 'decided_by_role']) {
        expect(cols).toContain(c)
      }

      // Row + values round-trip.
      const row = up.query('SELECT * FROM doc_versions WHERE id = ?').get('01DV1') as Record<
        string,
        unknown
      >
      expect(row.decision).toBe('approved')
      expect(row.comments_json).toBe('[{"c":1}]')
      expect(row.item_index).toBe(1)
      expect(row.selection).toBe('accepted')
      expect(row.decided_by_role).toBe('owner')
      expect((up.query('SELECT COUNT(*) AS n FROM doc_versions').get() as { n: number }).n).toBe(1)

      // All 3 indexes recreated.
      const idxNames = (
        up.query('PRAGMA index_list(doc_versions)').all() as Array<{ name: string }>
      ).map((i) => i.name)
      for (const i of [
        'idx_doc_versions_review_run',
        'idx_doc_versions_task',
        'idx_doc_versions_review_item',
      ]) {
        expect(idxNames).toContain(i)
      }

      // Both FKs survive (task_id → tasks, review_node_run_id → node_runs).
      const fks = (
        up.query('PRAGMA foreign_key_list(doc_versions)').all() as Array<{ table: string }>
      ).map((f) => f.table)
      expect(fks).toContain('tasks')
      expect(fks).toContain('node_runs')
      up.close()
    } finally {
      rimrafDir(tmp)
    }
  })
})

// Codex audit F1 regression: 0058's 12-step rebuild DROPs doc_versions, which —
// if migrations run with foreign_keys ON — cascade-deletes EVERY review_comments
// row (FK doc_version_id ON DELETE cascade). The fix (db/client.ts openDb /
// migratedSnapshot) runs migrations with FK OFF so the rebuild is FK-inert and
// child rows survive the upgrade. New installs never hit it (empty child table
// on replay), which is why CI was green — only "DB with review comments → RFC-115"
// loses data.
describe('RFC-115 migration 0058 — Codex F1: review_comments survive the upgrade', () => {
  test('FK-safe migrate (FK OFF, as openDb does) keeps review_comments through the rebuild', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-mig0058-fk-'))
    const dbPath = join(tmp, 'pre.sqlite')
    try {
      freezeAt(idx0057(), dbPath) // pre-0058: doc_versions still has agent_snapshot
      const pre = new Database(dbPath)
      pre.exec('PRAGMA foreign_keys = OFF;')
      pre.run(
        `INSERT INTO doc_versions (id, task_id, review_node_id, review_node_run_id,
           source_node_id, source_port_name, version_index, review_iteration, body_path,
           comments_json, decision, created_at)
         VALUES ('01DVX','t1','rev','run1','src','answer',1,0,'b.md','[]','approved',1)`,
      )
      pre.run(
        `INSERT INTO review_comments (id, doc_version_id, anchor_section_path,
           anchor_paragraph_idx, anchor_offset_start, anchor_offset_end, selected_text,
           context_before, context_after, occurrence_index, comment_text, created_at)
         VALUES ('01RC1','01DVX','/s',0,0,5,'sel','before','after',0,'nice work',1)`,
      )
      pre.close()

      // Apply 0058 the way production openDb does: FK OFF OUTSIDE drizzle's tx →
      // migrate → FK ON. Under the OLD FK-ON path the DROP TABLE doc_versions
      // would cascade-delete the review_comment.
      const up = new Database(dbPath)
      up.exec('PRAGMA foreign_keys = OFF;')
      migrate(drizzle(up, {}), { migrationsFolder: MIGRATIONS })
      up.exec('PRAGMA foreign_keys = ON;')
      expect(docVersionCols(up)).not.toContain('agent_snapshot')
      expect((up.query('SELECT COUNT(*) AS n FROM review_comments').get() as { n: number }).n).toBe(
        1,
      )
      expect((up.query('SELECT COUNT(*) AS n FROM doc_versions').get() as { n: number }).n).toBe(1)
      up.close()
    } finally {
      rimrafDir(tmp)
    }
  })

  test('openDb source runs migrations with foreign_keys OFF (防回退到 FK-ON 级联)', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'db', 'client.ts'), 'utf8')
    // The FK-OFF toggle must precede migrate() so a 12-step rebuild's DROP TABLE
    // can't cascade-delete child rows.
    expect(src).toMatch(/foreign_keys = OFF[\s\S]{0,400}migrate\(/)
  })
})
