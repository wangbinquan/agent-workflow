import { rimrafDir } from './helpers/cleanup'
// RFC-115 PR-C — migration 0057 (SQLite 12-step rebuild that DROPs the dead
// agent generation-param columns model/variant/temperature/steps/max_steps)
// data-copy + pre-drop guard lock.
//
// WHY THIS FILE EXISTS (regression intent):
//   The riskiest parts of 0057 are (1) the INSERT..SELECT column copy — a
//   wrong / misordered list silently drops or corrupts agent rows — and (2) the
//   pre-drop fail-loud guard (Codex design-gate F2): a DB that never ran the
//   RFC-113 re-home (params still non-NULL) MUST abort the migration rather than
//   silently dropping the only copy of the user's model/variant/etc. This test
//   applies migrations THROUGH 0056 (the 5 param columns still present), then:
//     • (data path) inserts an agent with all params NULL (already re-homed),
//       applies 0057, asserts the 5 columns are gone, `runtime` + every other
//       column survive byte-for-byte, the row count is unchanged, and the
//       agents_name_unique index survives the rebuild;
//     • (guard path) inserts an agent with a NON-NULL `model`, applies 0057,
//       asserts the migration THROWS (CHECK(n=0) violated → ABORT) and the
//       agents table is left intact (params NOT dropped).

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
const PARAM_COLS = ['model', 'variant', 'temperature', 'steps', 'max_steps']

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

/** Apply the first `idx + 1` migrations to a fresh sqlite file (mirrors 0041). */
function freezeAt(idx: number, outDbPath: string): void {
  const full = readJournal()
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig0057-partial-'))
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

/** Build (but do NOT apply) a temp migrations folder holding the first `idx + 1`
 *  migrations. The caller runs migrate() against an EXISTING db so only the
 *  not-yet-applied tail runs, isolating one migration's effect from later ones.
 *  Needed because RFC-130's 0072 also drops an `agents` column, so applying the
 *  full folder would confound 0057's column-delta assertion. */
function buildPartialFolder(idx: number): { dir: string; cleanup: () => void } {
  const full = readJournal()
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig0057-thru-'))
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
  return { dir, cleanup: () => rimrafDir(dir) }
}

function agentCols(db: Database): string[] {
  return (db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>).map((c) => c.name)
}

const idx0056 = (): number => {
  const e = readJournal().entries.find((j) => j.tag.startsWith('0056'))
  if (e === undefined) throw new Error('0056 not in journal')
  return e.idx
}

const idx0057 = (): number => {
  const e = readJournal().entries.find((j) => j.tag.startsWith('0057'))
  if (e === undefined) throw new Error('0057 not in journal')
  return e.idx
}

describe('RFC-115 migration 0057 — DROP agent params (re-homed DBs)', () => {
  test('5 param columns dropped; runtime + rows + unique index survive the rebuild', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-mig0057-'))
    const dbPath = join(tmp, 'pre.sqlite')
    try {
      freezeAt(idx0056(), dbPath)
      const pre = new Database(dbPath)
      pre.exec('PRAGMA foreign_keys = OFF;')
      const cols0056 = agentCols(pre)
      for (const c of PARAM_COLS) expect(cols0056).toContain(c)
      expect(cols0056).toContain('runtime')
      // A re-homed agent: every param column is NULL (RFC-113 left them so).
      pre.run(
        `INSERT INTO agents (id, name, description, outputs, readonly, permission,
           skills, frontmatter_extra, body_md, schema_version, runtime, visibility, builtin)
         VALUES ('01AGENTA','coder','desc-a','["design"]',1,'{"edit":true}','["s1"]',
           '{"x":1}','body-a',1,'opencode-opus','private',0)`,
      )
      pre.close()

      // Apply migrations only THROUGH 0057 (partial folder), NOT the full folder:
      // RFC-130's 0072 also drops an `agents` column (`readonly`), so applying
      // everything would make the column-delta below 6, not 5. drizzle skips
      // 0..0056 (already applied by hash) and runs just 0057. FK OFF so the
      // rebuild's INSERT..SELECT doesn't reject (agents has no real FK anyway).
      const up = new Database(dbPath)
      up.exec('PRAGMA foreign_keys = OFF;')
      const thru0057 = buildPartialFolder(idx0057())
      migrate(drizzle(up, {}), { migrationsFolder: thru0057.dir })
      thru0057.cleanup()

      const cols0057 = agentCols(up)
      for (const c of PARAM_COLS) expect(cols0057).not.toContain(c)
      expect(cols0057).toContain('runtime')
      // Exactly the 5 param columns were dropped — nothing else.
      expect(cols0056.length - cols0057.length).toBe(5)
      const dropped = cols0056.filter((c) => !cols0057.includes(c)).sort()
      expect(dropped).toEqual([...PARAM_COLS].sort())

      // Row + values round-trip; runtime preserved.
      const row = up.query('SELECT * FROM agents WHERE id = ?').get('01AGENTA') as Record<
        string,
        unknown
      >
      expect(row.name).toBe('coder')
      expect(row.runtime).toBe('opencode-opus')
      expect(row.permission).toBe('{"edit":true}')
      expect(row.visibility).toBe('private')
      expect((up.query('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n).toBe(1)

      // agents_name_unique survives → duplicate name rejected.
      const idxList = (up.query('PRAGMA index_list(agents)').all() as Array<{ name: string }>).map(
        (i) => i.name,
      )
      expect(idxList).toContain('agents_name_unique')
      expect(() =>
        up.run(
          `INSERT INTO agents (id, name, permission, runtime) VALUES ('01DUP','coder','{}',NULL)`,
        ),
      ).toThrow()
      up.close()
    } finally {
      rimrafDir(tmp)
    }
  })
})

describe('RFC-115 migration 0057 — pre-drop fail-loud guard (Codex F2)', () => {
  test('a NON-re-homed DB (param still non-NULL) ABORTs instead of silently dropping', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-mig0057-guard-'))
    const dbPath = join(tmp, 'pre.sqlite')
    try {
      freezeAt(idx0056(), dbPath)
      const pre = new Database(dbPath)
      pre.exec('PRAGMA foreign_keys = OFF;')
      // A legacy agent that NEVER went through RFC-113 re-home: model is set.
      pre.run(
        `INSERT INTO agents (id, name, permission, runtime, model)
         VALUES ('01LEGACY','legacy','{}',NULL,'anthropic/claude-opus-4-8')`,
      )
      pre.close()

      const up = new Database(dbPath)
      up.exec('PRAGMA foreign_keys = OFF;')
      // The guard's CHECK(n = 0) is violated (1 row with non-NULL model) → ABORT.
      expect(() => migrate(drizzle(up, {}), { migrationsFolder: MIGRATIONS })).toThrow()
      // Fail-loud, not silent: the param columns + the row are still intact.
      const cols = agentCols(up)
      expect(cols).toContain('model')
      const row = up.query('SELECT model FROM agents WHERE id = ?').get('01LEGACY') as {
        model: string
      }
      expect(row.model).toBe('anthropic/claude-opus-4-8')
      up.close()
    } finally {
      rimrafDir(tmp)
    }
  })
})
