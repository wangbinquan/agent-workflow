// RFC-223 (PR-1) — locks migration 0111 (agents' active reference columns
// backfilled from NAMES to IDS, and skills → typed AgentSkillRef).
//
// Two concerns:
//   1. FRESH install: createFrozenEpoch1Db applies 0000..0111 against an empty
//      agents table — the backfill is a no-op and the daemon boots clean.
//   2. DEV upgrade: replay 0000..0110 (agents still hold name arrays), seed
//      legacy rows referencing mcps / plugins / agents / skills by name, then
//      exec the real 0111 SQL and assert:
//        - mcp / plugins / depends_on arrays become ids, order preserved;
//        - a dangling name (no matching row) is dropped;
//        - skills become typed refs: a managed skill name → {kind:'managed',
//          skillId}; a name with NO skill row → {kind:'project', name} (RFC-178);
//        - empty arrays stay [].
//
// If this reds, RFC-223 PR-1's id-canonicalization of agents.* is broken.

import {
  migrateFrozenSqlite as migrate,
  createFrozenEpoch1Db,
  FROZEN_MIGRATIONS,
} from './migration-freeze'
import {
  setDefaultTimeout,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { LEGACY_MIGRATION_HASHES } from '@/platform/persistence/migration/epoch1/journalAliases'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { collectSourceFingerprint } from '@/platform/persistence/migration/sourceCatalog'
import {
  identifySource,
  loadSupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'
import { SourceBlockedError } from '@/platform/persistence/migration/sourceTypes'

// Identifying canonical and shipped receipts builds the full frozen prefix catalog (~11 s on CI); allow 35 s.
setDefaultTimeout(35000)

const MIGRATIONS = resolve(FROZEN_MIGRATIONS)
const TAG = '0111_rfc223_agent_refs_to_id'
const CANONICAL_SQL = join(MIGRATIONS, `${TAG}.sql`)
const SHIPPED_SQL = resolve(import.meta.dir, 'fixtures', 'shipped-migrations', `${TAG}.sql`)

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('migration 0111 (RFC-223) — fresh install is a no-op', () => {
  test('empty agents table applies 0000..0111 without error', () => {
    const db = createFrozenEpoch1Db(MIGRATIONS)
    const rows = db.$client.query('SELECT COUNT(*) AS n FROM agents').all() as { n: number }[]
    expect(rows[0]!.n).toBe(0)
  })

  test('orders rows before aggregation instead of requiring aggregate ORDER BY syntax', () => {
    const sql = readFileSync(CANONICAL_SQL, 'utf-8')
    expect(sql).not.toMatch(/json_group_array\([^\n]*\bORDER BY\b/u)
    expect(sql.match(/^\s+ORDER BY je\.key$/gmu)).toHaveLength(4)
  })
})

describe('migration 0111 (RFC-223) — name→id backfill (frozen at 0110)', () => {
  let tmp: string
  let sqlite: Database
  let raw: Database

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-mig0111-'))
    // Copy the tree, truncate the journal to idx<=109 (through 0110) so migrate()
    // stops before 0111 — agents still hold NAME arrays.
    cpSync(MIGRATIONS, tmp, { recursive: true })
    const journalPath = join(tmp, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 109)
    writeFileSync(journalPath, JSON.stringify(journal))

    sqlite = new Database(':memory:')
    sqlite.exec('PRAGMA foreign_keys = OFF') // match openFrozenEpoch1Db: 12-step migrations
    migrate(drizzle(sqlite), { migrationsFolder: tmp })
    raw = sqlite
  }, 5_000)
  afterEach(() => {
    sqlite?.close()
    rmSync(tmp, { recursive: true, force: true })
  }, 5_000)

  function apply0111() {
    const sql = readFileSync(CANONICAL_SQL, 'utf-8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) raw.exec(trimmed)
    }
  }

  function insertAgent(name: string, cols: Record<string, string>) {
    const keys = ['id', 'name', ...Object.keys(cols)]
    const vals = [ulid(), name, ...Object.values(cols)]
    raw
      .query(`INSERT INTO agents (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...vals)
  }
  const agentRefs = (name: string, col: string) =>
    JSON.parse(
      (raw.query(`SELECT ${col} AS v FROM agents WHERE name = ?`).get(name) as { v: string }).v,
    )

  test('mcp / plugins / depends_on: names → ids (order preserved); dangling dropped', () => {
    const mAId = ulid()
    const mBId = ulid()
    raw.query("INSERT INTO mcps (id, name, type) VALUES (?, 'm-a', 'local')").run(mAId)
    raw.query("INSERT INTO mcps (id, name, type) VALUES (?, 'm-b', 'local')").run(mBId)
    const pAId = ulid()
    raw
      .query(
        "INSERT INTO plugins (id, name, spec, source_kind, cached_path, installed_at) VALUES (?, 'p-a', 's@1', 'npm', '/x', 0)",
      )
      .run(pAId)
    const depId = ulid()
    raw.query('INSERT INTO agents (id, name) VALUES (?, ?)').run(depId, 'dep-agent')

    // consumer references m-b THEN m-a (order matters) + a dangling 'm-ghost'.
    insertAgent('consumer', {
      mcp: JSON.stringify(['m-b', 'm-a', 'm-ghost']),
      plugins: JSON.stringify(['p-a']),
      depends_on: JSON.stringify(['dep-agent']),
    })

    apply0111()

    expect(agentRefs('consumer', 'mcp')).toEqual([mBId, mAId]) // order preserved, ghost dropped
    expect(agentRefs('consumer', 'plugins')).toEqual([pAId])
    expect(agentRefs('consumer', 'depends_on')).toEqual([depId])
  })

  test('skills: managed name → {managed, skillId}; unknown name → {project, name}', () => {
    const lintId = ulid()
    raw
      .query("INSERT INTO skills (id, name, source_kind) VALUES (?, 'lint', 'managed')")
      .run(lintId)

    // 'lint' is a managed skill row; 'proj-only' has NO skill row (repo-local).
    insertAgent('sk-consumer', { skills: JSON.stringify(['lint', 'proj-only']) })

    apply0111()

    expect(agentRefs('sk-consumer', 'skills')).toEqual([
      { kind: 'managed', skillId: lintId },
      { kind: 'project', name: 'proj-only' },
    ])
  })

  test('empty reference arrays stay []', () => {
    insertAgent('empty', {
      mcp: '[]',
      plugins: '[]',
      depends_on: '[]',
      skills: '[]',
    })
    apply0111()
    expect(agentRefs('empty', 'mcp')).toEqual([])
    expect(agentRefs('empty', 'plugins')).toEqual([])
    expect(agentRefs('empty', 'depends_on')).toEqual([])
    expect(agentRefs('empty', 'skills')).toEqual([])
  })

  test('a second agent referencing the SAME managed skill resolves to the same id (cross-agent determinism)', () => {
    const shId = ulid()
    raw
      .query("INSERT INTO skills (id, name, source_kind) VALUES (?, 'shared', 'managed')")
      .run(shId)
    insertAgent('a1', { skills: JSON.stringify(['shared']) })
    insertAgent('a2', { skills: JSON.stringify(['shared']) })
    apply0111()
    expect(agentRefs('a1', 'skills')).toEqual([{ kind: 'managed', skillId: shId }])
    expect(agentRefs('a2', 'skills')).toEqual([{ kind: 'managed', skillId: shId }])
  })
})

// 2026-09-02 regression — this migration's bytes were amended AFTER it had
// shipped and been applied in the field: `json_group_array(x ORDER BY y)` (an
// aggregate ORDER BY, which only parses on SQLite >= 3.44) became an ordered
// subquery, and the receipt those old bytes had already written was never
// repinned. Every existing database then stopped at `migration-history-preflight`
// — "migration 0111_rfc223_agent_refs_to_id hash differs (8f7584ecb922 !=
// 3d99826a75a7)" — and the daemon refused to start.
//
// The repin is the LEGACY_MIGRATION_HASHES entry for this tag. These tests hold
// both of its ends: the alias really is the sha256 of the bytes that shipped
// (kept verbatim under fixtures/shipped-migrations/), and honouring a database
// that ran those bytes is sound because both forms leave the same rows behind.
// Amend this migration again and the second test says whether the new bytes are
// still only a rewording — if they are not, an alias is the wrong instrument and
// the change belongs in a forward migration.
describe('migration 0111 (RFC-223) — databases that ran the shipped bytes still boot', () => {
  let frozen: string
  let tmp: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-mig0111-shipped-'))
    // Same freeze as the backfill suite above: journal truncated to idx<=109 so
    // migrate() stops right before 0111 and agents still hold NAME arrays.
    frozen = join(tmp, 'migrations-0110')
    cpSync(MIGRATIONS, frozen, { recursive: true })
    const journalPath = join(frozen, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
      entries: Array<{ idx: number }>
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= 109)
    writeFileSync(journalPath, JSON.stringify(journal))
  }, 5_000)
  afterAll(() => rmSync(tmp, { recursive: true, force: true }), 5_000)

  /** True on SQLite >= 3.44, where the shipped `json_group_array(x ORDER BY y)` parses. */
  function supportsAggregateOrderBy(): boolean {
    const probe = new Database(':memory:')
    try {
      probe
        .query("SELECT json_group_array(je.value ORDER BY je.key) AS r FROM json_each('[1]') je")
        .get()
      return true
    } catch {
      return false
    } finally {
      probe.close()
    }
  }

  /** Seed one frozen-at-0110 database, run `sqlPath`, and dump what the backfill left. */
  function backfill(sqlPath: string): unknown[] {
    const sqlite = new Database(':memory:')
    try {
      sqlite.exec('PRAGMA foreign_keys = OFF')
      migrate(drizzle(sqlite), { migrationsFolder: frozen })
      // Fixed ids (not ulid()) so the two runs are comparable row for row.
      sqlite.exec(`
        INSERT INTO mcps (id, name, type) VALUES ('mcp-a', 'm-a', 'local'), ('mcp-b', 'm-b', 'local');
        INSERT INTO plugins (id, name, spec, source_kind, cached_path, installed_at)
          VALUES ('plg-a', 'p-a', 's@1', 'npm', '/x', 0);
        INSERT INTO skills (id, name, source_kind) VALUES ('skl-a', 'lint', 'managed');
        INSERT INTO agents (id, name) VALUES ('agt-dep', 'dep-agent');
      `)
      sqlite.exec(`
        INSERT INTO agents (id, name, mcp, plugins, depends_on, skills) VALUES (
          'agt-consumer', 'consumer',
          '["m-b","m-a","m-ghost"]', '["p-a"]', '["dep-agent"]', '["lint","proj-only"]'
        ), (
          'agt-empty', 'empty', '[]', '[]', '[]', '[]'
        );
      `)
      for (const stmt of readFileSync(sqlPath, 'utf-8').split('--> statement-breakpoint')) {
        const trimmed = stmt.trim()
        if (trimmed) sqlite.exec(trimmed)
      }
      return sqlite
        .query('SELECT name, mcp, plugins, depends_on, skills FROM agents ORDER BY name')
        .all()
    } finally {
      sqlite.close()
    }
  }

  test('the alias is the sha256 of the shipped bytes, and the file has since moved on', () => {
    const shipped = sha256(SHIPPED_SQL)
    expect(LEGACY_MIGRATION_HASHES[TAG]).toEqual([shipped])
    expect(sha256(CANONICAL_SQL)).not.toBe(shipped)
  })

  test('the shipped bytes and the canonical bytes leave the same rows behind', () => {
    if (!supportsAggregateOrderBy()) {
      // This runtime is exactly why the file was amended: the shipped statement
      // does not even parse here, so no database on it can hold the old receipt.
      expect(() => backfill(SHIPPED_SQL)).toThrow()
      return
    }
    expect(backfill(SHIPPED_SQL)).toEqual(backfill(CANONICAL_SQL))
  })

  test('the frozen source reader accepts only the canonical and shipped 0111 receipts', async () => {
    const history = await loadFrozenEpoch1History()
    const manifest = await loadSupportedSourceManifest()
    const stamp = history.sqlite[history.sqliteTags.indexOf(TAG)]!.folderMillis
    const admit = (hash0111: string) => {
      const db = createFrozenEpoch1Db(MIGRATIONS)
      try {
        db.$client
          .query('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?')
          .run(hash0111, stamp)
        const identified = identifySource({
          fingerprint: collectSourceFingerprint(db.$client),
          manifest,
        })
        expect(identified.source.contract!.digest).toBe(frozenEpoch1Contract.digest)
      } finally {
        db.$client.close()
      }
    }
    admit(sha256(SHIPPED_SQL))
    admit(sha256(CANONICAL_SQL))
    expect(() => admit(`${'0'.repeat(63)}1`)).toThrow(SourceBlockedError)
  })
})
