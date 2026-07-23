// RFC-223 (PR-2) — locks migration 0112: workflow / workgroup / scheduled agent
// + workgroup references backfilled from NAMES to canonical IDS.
//
// Two concerns (mirrors migration-0111-rfc223.test.ts):
//   1. FRESH install: 0000..0112 against empty tables — every backfill is a
//      no-op and the daemon boots clean.
//   2. DEV upgrade: replay 0000..0111 (references still by name), seed legacy
//      rows, exec the real 0112 SQL and assert:
//        - workgroup_members.agent_id backfilled from agent_name (dangling → NULL,
//          human member → NULL);
//        - scheduled agent payload gains $.agentId; workgroup payload gains
//          $.workgroupId; a dangling target gains NEITHER (fire falls back to name);
//        - every agent-single workflow node gains $.agentId (dangling node keeps
//          none; non-agent nodes untouched; order preserved).
//
// If this reds, RFC-223 PR-2's id-canonicalization of the non-agent references
// is broken.

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

describe('migration 0112 (RFC-223 PR-2) — fresh install is a no-op', () => {
  test('empty tables apply 0000..0112 without error; agent_id column exists', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wgm = db.$client.query('SELECT COUNT(*) AS n FROM workgroup_members').all() as {
      n: number
    }[]
    expect(wgm[0]!.n).toBe(0)
    // The ALTER TABLE ran: agent_id is a selectable column.
    const cols = db.$client
      .query("SELECT name FROM pragma_table_info('workgroup_members')")
      .all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('agent_id')
  })
})

describe('migration 0112 (RFC-223 PR-2) — name→id backfill (frozen at 0111)', () => {
  let tmp: string
  let sqlite: Database
  let raw: Database

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-mig0112-'))
    // Truncate the journal to idx<=110 (through 0111) so migrate() stops before
    // 0112 — workgroup_members has no agent_id column, references still by name.
    cpSync(MIGRATIONS, tmp, { recursive: true })
    const journalPath = join(tmp, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 110)
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

  function apply0112() {
    const sql = readFileSync(join(MIGRATIONS, '0112_rfc223_pr2_refs_to_id.sql'), 'utf-8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) raw.exec(trimmed)
    }
  }
  function insertAgent(name: string): string {
    const id = ulid()
    raw.query('INSERT INTO agents (id, name) VALUES (?, ?)').run(id, name)
    return id
  }

  test('workgroup_members.agent_id: name → id; dangling + human → NULL', () => {
    const a1 = insertAgent('a1')
    const g1 = ulid()
    raw.query('INSERT INTO workgroups (id, name) VALUES (?, ?)').run(g1, 'grp1')
    const mAgent = ulid()
    const mGhost = ulid()
    const mHuman = ulid()
    raw
      .query(
        "INSERT INTO workgroup_members (id, workgroup_id, member_type, agent_name, display_name) VALUES (?, ?, 'agent', 'a1', 'A1')",
      )
      .run(mAgent, g1)
    raw
      .query(
        "INSERT INTO workgroup_members (id, workgroup_id, member_type, agent_name, display_name) VALUES (?, ?, 'agent', 'ghost', 'Ghost')",
      )
      .run(mGhost, g1)
    raw
      .query(
        "INSERT INTO workgroup_members (id, workgroup_id, member_type, user_id, display_name) VALUES (?, ?, 'human', 'u1', 'Human')",
      )
      .run(mHuman, g1)

    apply0112()

    const idOf = (id: string) =>
      (
        raw.query('SELECT agent_id AS v FROM workgroup_members WHERE id = ?').get(id) as {
          v: string | null
        }
      ).v
    expect(idOf(mAgent)).toBe(a1)
    expect(idOf(mGhost)).toBeNull()
    expect(idOf(mHuman)).toBeNull()
  })

  function insertSchedule(kind: string, payload: unknown): string {
    const id = ulid()
    raw
      .query(
        'INSERT INTO scheduled_tasks (id, name, owner_user_id, launch_kind, launch_payload, schedule_spec) VALUES (?, ?, \'u1\', ?, ?, \'{"kind":"interval","every":1,"unit":"hours"}\')',
      )
      .run(id, `sched-${kind}`, kind, JSON.stringify(payload))
    return id
  }
  const payloadOf = (id: string) =>
    JSON.parse(
      (
        raw.query('SELECT launch_payload AS v FROM scheduled_tasks WHERE id = ?').get(id) as {
          v: string
        }
      ).v,
    )

  test('scheduled agent payload → $.agentId; workgroup payload → $.workgroupId; dangling gains none', () => {
    const a1 = insertAgent('a1')
    const g1 = ulid()
    raw.query('INSERT INTO workgroups (id, name) VALUES (?, ?)').run(g1, 'grp1')

    const sAgent = insertSchedule('agent', { name: 't', description: 'x', agentName: 'a1' })
    const sGhost = insertSchedule('agent', { name: 't', description: 'x', agentName: 'ghost' })
    const sWg = insertSchedule('workgroup', { name: 't', goal: 'g', workgroupName: 'grp1' })
    const sWgGhost = insertSchedule('workgroup', { name: 't', goal: 'g', workgroupName: 'ghost' })

    apply0112()

    expect(payloadOf(sAgent).agentId).toBe(a1)
    expect(payloadOf(sAgent).agentName).toBe('a1') // display name preserved
    expect(payloadOf(sGhost).agentId).toBeUndefined() // dangling: no id stamped
    expect(payloadOf(sWg).workgroupId).toBe(g1)
    expect(payloadOf(sWgGhost).workgroupId).toBeUndefined()
  })

  test('workflow agent-single nodes → node.agentId; order preserved; non-agent + dangling untouched', () => {
    const a1 = insertAgent('a1')
    const a2 = insertAgent('a2')
    const wfId = ulid()
    const def = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' },
        { id: 'n1', kind: 'agent-single', agentName: 'a1', promptTemplate: 'p1' },
        { id: 'n2', kind: 'agent-single', agentName: 'ghost', promptTemplate: 'p2' },
        { id: 'n3', kind: 'agent-single', agentName: 'a2', promptTemplate: 'p3' },
      ],
      edges: [],
    }
    raw
      .query('INSERT INTO workflows (id, name, definition) VALUES (?, ?, ?)')
      .run(wfId, 'wf1', JSON.stringify(def))

    apply0112()

    const stored = JSON.parse(
      (raw.query('SELECT definition AS v FROM workflows WHERE id = ?').get(wfId) as { v: string })
        .v,
    )
    const byId = Object.fromEntries(stored.nodes.map((n: { id: string }) => [n.id, n]))
    // order preserved
    expect(stored.nodes.map((n: { id: string }) => n.id)).toEqual(['in1', 'n1', 'n2', 'n3'])
    // input node untouched (no agentId key)
    expect(byId.in1.agentId).toBeUndefined()
    expect(byId.in1.inputKey).toBe('req')
    // resolvable agent nodes stamped; agentName kept
    expect(byId.n1.agentId).toBe(a1)
    expect(byId.n1.agentName).toBe('a1')
    expect(byId.n1.promptTemplate).toBe('p1')
    expect(byId.n3.agentId).toBe(a2)
    // dangling agent node keeps no agentId (scheduler falls back to name)
    expect(byId.n2.agentId).toBeUndefined()
    expect(byId.n2.agentName).toBe('ghost')
  })

  test('workflow with empty nodes array is left intact', () => {
    const wfId = ulid()
    raw
      .query('INSERT INTO workflows (id, name, definition) VALUES (?, ?, ?)')
      .run(
        wfId,
        'wf-empty',
        JSON.stringify({ $schema_version: 4, inputs: [], nodes: [], edges: [] }),
      )
    apply0112()
    const stored = JSON.parse(
      (raw.query('SELECT definition AS v FROM workflows WHERE id = ?').get(wfId) as { v: string })
        .v,
    )
    expect(stored.nodes).toEqual([])
  })
})
