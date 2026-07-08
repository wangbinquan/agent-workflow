// RFC-074 PR-C — migration 0041 (SQLite 12-step rebuild that DROPs
// node_runs.clarify_iteration) DATA-COPY lock.
//
// WHY THIS FILE EXISTS (regression intent):
//   migration-0040 / rfc074-prc-cci-retirement build a fully-migrated DB then
//   insert, so they only exercise the rebuild's structural copy on an EMPTY
//   table. The riskiest part of a 12-step rebuild is the INSERT..SELECT data
//   copy: a wrong / misordered column list silently corrupts or drops rows.
//   This test applies migrations THROUGH 0040 (clarify_iteration still present),
//   inserts node_runs rows with DISTINCT values across columns + a non-null
//   clarify_iteration, applies 0041, and asserts every surviving column
//   round-trips byte-for-byte, the row count is unchanged, clarify_iteration is
//   gone, and both indexes + the task_id FK survive the rebuild. A misordered
//   INSERT..SELECT (e.g. started_at/finished_at swapped) or a dropped column
//   goes RED here instead of corrupting production data.

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
  rmSync,
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

/** Apply the first `idx + 1` migrations to a fresh sqlite file at `outDbPath`
 *  (mirrors upgrade-rolling.test.ts freezeAt). DB is closed before return. */
function freezeAt(idx: number, outDbPath: string): void {
  const full = readJournal()
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig0041-partial-'))
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
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('RFC-074 migration 0041 — DROP clarify_iteration preserves row data', () => {
  test('node_runs rows round-trip through the 12-step rebuild; cci dropped, indexes + FK survive', () => {
    const idx0040 = readJournal().entries.find((e) => e.tag.startsWith('0040'))?.idx
    expect(idx0040).toBeGreaterThan(0)

    const tmp = mkdtempSync(join(tmpdir(), 'aw-mig0041-'))
    const dbPath = join(tmp, 'pre.sqlite')
    try {
      // 1. Migrate THROUGH 0040 — clarify_iteration still present, consumed col added.
      freezeAt(idx0040!, dbPath)

      // 2. Insert node_runs rows with distinct values across columns + a
      //    NON-NULL clarify_iteration. FK off so we need no real task row; the
      //    rebuild copies rows regardless of referential integrity.
      const pre = new Database(dbPath)
      pre.exec('PRAGMA foreign_keys = OFF;')
      const cols0040 = (
        pre.query('PRAGMA table_info(node_runs)').all() as Array<{ name: string }>
      ).map((c) => c.name)
      expect(cols0040).toContain('clarify_iteration')
      expect(cols0040).toContain('consumed_upstream_runs_json')
      pre.run(
        `INSERT INTO node_runs
          (id, task_id, node_id, parent_node_run_id, iteration, shard_key, retry_index,
           review_iteration, clarify_iteration, status, started_at, finished_at, pid,
           exit_code, error_message, prompt_text, tok_total, pre_snapshot, opencode_session_id,
           inventory_snapshot_json, injected_memories_json, port_validation_failures_json,
           commit_push_json, pre_snapshot_repos_json, consumed_upstream_runs_json)
         VALUES
          ('01ROWA','task1','designer',NULL,2,'src/a.ts',3,1,5,'done',100,200,4242,0,
           'err-a','prompt-a',110,'snap-a','sess-a','{"inv":1}','[{"m":1}]','[{"pv":1}]',
           '{"cp":1}','{"r":1}','{"designer":"01UP"}'),
          ('01ROWB','task1','builder','01ROWA',0,NULL,0,0,0,'failed',NULL,NULL,NULL,NULL,
           NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
      )
      pre.close()

      // 3. Apply 0041 (drizzle is incremental by hash → only 0041 runs).
      //    FK enforcement OFF for the apply: drizzle wraps each migration in a
      //    transaction where the migration's own `PRAGMA foreign_keys=OFF` is a
      //    no-op, so with enforcement ON the rebuild's INSERT..SELECT would
      //    reject our deliberately-orphan rows (no real `tasks` row). This test
      //    targets the DATA COPY, not FK enforcement; the FK STRUCTURE survival
      //    is still asserted below via foreign_key_list.
      const up = new Database(dbPath)
      up.exec('PRAGMA foreign_keys = OFF;')
      migrate(drizzle(up, {}), { migrationsFolder: MIGRATIONS })

      // 4a. clarify_iteration gone; net column delta vs the 0040 freeze is
      //     +6: 0041 drops exactly one (cci), and LATER migrations (applied by
      //     the same HEAD migrate) add SEVEN back onto node_runs — 0043
      //     shard_value_hash + 0044 rerun_cause + 0051 spawn_binary_path (RFC-108 T9)
      //     + 0054 runtime (RFC-111) + 0055 runtime_binary (RFC-112)
      //     + 0056 runtime_params_json (RFC-113) + 0067 agent_override_name (RFC-127)
      //     + 0071 iso_worktree_path/iso_base_snapshot(+_repos_json)/iso_node_tree(+_repos_json)/
      //       merge_state (RFC-130, 6 cols).
      const cols = (up.query('PRAGMA table_info(node_runs)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      )
      expect(cols).not.toContain('clarify_iteration')
      expect(cols).toContain('consumed_upstream_runs_json')
      expect(cols).toContain('shard_value_hash')
      expect(cols).toContain('rerun_cause')
      expect(cols).toContain('spawn_binary_path')
      expect(cols).toContain('runtime')
      expect(cols).toContain('runtime_binary')
      expect(cols).toContain('runtime_params_json')
      expect(cols).toContain('agent_override_name')
      // RFC-130 (0071): 6 per-node isolated-worktree bookkeeping columns.
      expect(cols).toContain('iso_worktree_path')
      expect(cols).toContain('iso_base_snapshot')
      expect(cols).toContain('iso_base_snapshot_repos_json')
      expect(cols).toContain('iso_node_tree')
      expect(cols).toContain('iso_node_tree_repos_json')
      expect(cols).toContain('merge_state')
      // RFC-145 (0077): failure_code + superseded_by_review + rolled_back.
      expect(cols).toContain('failure_code')
      expect(cols).toContain('superseded_by_review')
      expect(cols).toContain('rolled_back')
      expect(cols.length).toBe(cols0040.length - 1 + 7 + 6 + 3)

      // 4b. row count unchanged.
      const n = (up.query('SELECT count(*) AS n FROM node_runs').get() as { n: number }).n
      expect(n).toBe(2)

      // 4c. every set column round-trips byte-for-byte for ROWA (distinct values
      //     catch a misordered INSERT..SELECT, e.g. started_at/finished_at swap).
      const a = up.query("SELECT * FROM node_runs WHERE id='01ROWA'").get() as Record<
        string,
        unknown
      >
      expect(a.task_id).toBe('task1')
      expect(a.node_id).toBe('designer')
      expect(a.parent_node_run_id).toBeNull()
      expect(a.iteration).toBe(2)
      expect(a.shard_key).toBe('src/a.ts')
      expect(a.retry_index).toBe(3)
      expect(a.review_iteration).toBe(1)
      expect(a.status).toBe('done')
      expect(a.started_at).toBe(100)
      expect(a.finished_at).toBe(200)
      expect(a.pid).toBe(4242)
      expect(a.exit_code).toBe(0)
      expect(a.error_message).toBe('err-a')
      expect(a.prompt_text).toBe('prompt-a')
      expect(a.tok_total).toBe(110)
      expect(a.pre_snapshot).toBe('snap-a')
      expect(a.opencode_session_id).toBe('sess-a')
      expect(a.inventory_snapshot_json).toBe('{"inv":1}')
      expect(a.injected_memories_json).toBe('[{"m":1}]')
      expect(a.port_validation_failures_json).toBe('[{"pv":1}]')
      expect(a.commit_push_json).toBe('{"cp":1}')
      expect(a.pre_snapshot_repos_json).toBe('{"r":1}')
      expect(a.consumed_upstream_runs_json).toBe('{"designer":"01UP"}')
      expect('clarify_iteration' in a).toBe(false)

      // ROWB: NULLs + the parent pointer survive.
      const b = up.query("SELECT * FROM node_runs WHERE id='01ROWB'").get() as Record<
        string,
        unknown
      >
      expect(b.parent_node_run_id).toBe('01ROWA')
      expect(b.status).toBe('failed')
      expect(b.shard_key).toBeNull()
      expect(b.consumed_upstream_runs_json).toBeNull()

      // 4d. both indexes survive the rebuild.
      const idxNames = new Set(
        (up.query('PRAGMA index_list(node_runs)').all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      )
      expect(idxNames.has('idx_node_runs_task')).toBe(true)
      expect(idxNames.has('idx_node_runs_parent')).toBe(true)

      // 4e. the task_id → tasks(id) FK survives the rebuild.
      const fks = up.query('PRAGMA foreign_key_list(node_runs)').all() as Array<{
        table: string
        from: string
        to: string
      }>
      const taskFk = fks.find((f) => f.from === 'task_id')
      expect(taskFk?.table).toBe('tasks')
      expect(taskFk?.to).toBe('id')

      up.close()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
