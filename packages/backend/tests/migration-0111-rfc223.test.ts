// RFC-223 (PR-1) — locks migration 0111 (agents' active reference columns
// backfilled from NAMES to IDS, and skills → typed AgentSkillRef).
//
// Two concerns:
//   1. FRESH install: createInMemoryDb applies 0000..0111 against an empty
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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0111 (RFC-223) — fresh install is a no-op', () => {
  test('empty agents table applies 0000..0111 without error', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const rows = db.$client.query('SELECT COUNT(*) AS n FROM agents').all() as { n: number }[]
    expect(rows[0]!.n).toBe(0)
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
    sqlite.exec('PRAGMA foreign_keys = OFF') // match openDb: 12-step migrations
    migrate(drizzle(sqlite), { migrationsFolder: tmp })
    raw = sqlite
  })
  afterEach(() => {
    sqlite?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function apply0111() {
    const sql = readFileSync(join(MIGRATIONS, '0111_rfc223_agent_refs_to_id.sql'), 'utf-8')
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
