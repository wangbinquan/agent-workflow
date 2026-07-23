// RFC-223 (PR-3a) — locks migration 0113: frozen-snapshot agent references
// NAME → canonical ID, with R4-1 backfill-safety.
//
// Two concerns (mirrors migration-0112-rfc223-pr2.test.ts):
//   1. FRESH install: 0000..0113 against empty tables — every backfill is a
//      no-op, and node_runs.agent_override_id is a selectable column.
//   2. DEV upgrade: replay 0000..0112 (snapshots still name-only), seed legacy
//      task rows, exec the real 0113 SQL and assert R4-1:
//        - single-agent snapshot node gains agentId = the TRUSTED source_agent_id
//          (NOT the current name → an ABA rename+recreate must not bind the new
//          same-named agent);
//        - single-agent with source_agent_id NULL (pre-0091) → QUARANTINE sentinel;
//        - workflow snapshot name-only agent nodes → sentinel (no trusted id);
//        - workgroup config agent members with no frozen id → sentinel;
//        - terminal (done/failed) tasks are LEFT ALONE (no re-dispatch risk);
//        - a node that already carries agentId is untouched (idempotent).
//
// If this reds, RFC-223 PR-3a's R4-1 snapshot backfill safety is broken — the
// exact failure it guards is a stale frozen name silently re-binding a DIFFERENT
// tenant's agent on resume/retry.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { QUARANTINED_SNAPSHOT_AGENT_ID } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0113 (RFC-223 PR-3a) — fresh install is a no-op', () => {
  test('empty tables apply 0000..0113; agent_override_id column exists', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = db.$client.query("SELECT name FROM pragma_table_info('node_runs')").all() as {
      name: string
    }[]
    expect(cols.map((c) => c.name)).toContain('agent_override_id')
    const n = db.$client.query('SELECT COUNT(*) AS n FROM tasks').all() as { n: number }[]
    expect(n[0]!.n).toBe(0)
  })
})

describe('migration 0113 (RFC-223 PR-3a) — R4-1 snapshot backfill (frozen at 0112)', () => {
  let tmp: string
  let raw: Database

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-mig0113-'))
    // Freeze the journal at idx<=111 (through 0112) so migrate() stops before
    // 0113 — node_runs has no agent_override_id column, snapshots still name-only.
    cpSync(MIGRATIONS, tmp, { recursive: true })
    const journalPath = join(tmp, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 111)
    writeFileSync(journalPath, JSON.stringify(journal))

    raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = OFF') // match openDb: 12-step migrations
    migrate(drizzle(raw), { migrationsFolder: tmp })
  })
  afterEach(() => {
    raw?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function apply0113() {
    const sql = readFileSync(join(MIGRATIONS, '0113_rfc223_pr3_snapshot_ids.sql'), 'utf-8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) raw.exec(trimmed)
    }
  }
  function insertAgent(name: string, id = ulid()): string {
    raw.query('INSERT INTO agents (id, name) VALUES (?, ?)').run(id, name)
    return id
  }
  function insertTask(fields: {
    id: string
    status?: string
    sourceAgentName?: string | null
    sourceAgentId?: string | null
    workgroupId?: string | null
    snapshot?: string
    configJson?: string | null
  }) {
    raw
      .query(
        `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
           base_branch, branch, status, inputs, started_at,
           source_agent_name, source_agent_id, workgroup_id, workgroup_config_json)
         VALUES (?, ?, 'wf', ?, '/tmp/x', '/tmp/x-wt', 'main', ?, ?, '{}', 1, ?, ?, ?, ?)`,
      )
      .run(
        fields.id,
        fields.id,
        fields.snapshot ?? '{}',
        `aw/${fields.id}`,
        fields.status ?? 'running',
        fields.sourceAgentName ?? null,
        fields.sourceAgentId ?? null,
        fields.workgroupId ?? null,
        fields.configJson ?? null,
      )
  }
  function snapshotOf(id: string): { nodes: Array<Record<string, unknown>> } {
    const row = raw.query('SELECT workflow_snapshot AS s FROM tasks WHERE id = ?').get(id) as {
      s: string
    }
    return JSON.parse(row.s)
  }
  function configOf(id: string): { members: Array<Record<string, unknown>> } {
    const row = raw.query('SELECT workgroup_config_json AS c FROM tasks WHERE id = ?').get(id) as {
      c: string
    }
    return JSON.parse(row.c)
  }

  const singleAgentSnapshot = (agentName: string) =>
    JSON.stringify({
      nodes: [
        { id: '__agent_input__', kind: 'input', inputKey: 'description' },
        { id: '__agent_main__', kind: 'agent-single', agentName },
      ],
    })

  test('single-agent: node gains agentId = the TRUSTED source_agent_id', () => {
    const aId = insertAgent('writer')
    insertTask({
      id: 't-trusted',
      sourceAgentName: 'writer',
      sourceAgentId: aId,
      snapshot: singleAgentSnapshot('writer'),
    })
    apply0113()
    const node = snapshotOf('t-trusted').nodes.find((n) => n.kind === 'agent-single')!
    expect(node.agentId).toBe(aId)
    expect(node.agentName).toBe('writer') // display name preserved
    // input node untouched
    expect(snapshotOf('t-trusted').nodes.find((n) => n.kind === 'input')!.agentId).toBeUndefined()
  })

  test('R4-1 ABA lock ①: rename A + recreate B(same name) → node binds A, NOT B', () => {
    // Task froze agent A (id aId, name "writer") by NAME only, launch-time id aId.
    const aId = insertAgent('writer')
    insertTask({
      id: 't-aba',
      sourceAgentName: 'writer',
      sourceAgentId: aId,
      snapshot: singleAgentSnapshot('writer'),
    })
    // Simulate a rename+recreate that happened BEFORE the migration (global
    // uniqueness is intact, so we free the name first, then re-take it): A → "writer_old",
    // then a DIFFERENT agent B takes the name "writer".
    raw.query('UPDATE agents SET name = ? WHERE id = ?').run('writer_old', aId)
    const bId = insertAgent('writer')
    apply0113()
    const node = snapshotOf('t-aba').nodes.find((n) => n.kind === 'agent-single')!
    // The migration must bind the ORIGINAL A via the trusted source_agent_id —
    // never the same-named replacement B (that would be a cross-tenant leak).
    expect(node.agentId).toBe(aId)
    expect(node.agentId).not.toBe(bId)
  })

  test('R4-1 lock ②: pre-0091 single-agent (source_agent_id NULL) → quarantine sentinel', () => {
    insertAgent('solo')
    insertTask({
      id: 't-null',
      sourceAgentName: 'solo',
      sourceAgentId: null, // 0091 set it NULL and forbade a name backfill
      snapshot: singleAgentSnapshot('solo'),
    })
    apply0113()
    const node = snapshotOf('t-null').nodes.find((n) => n.kind === 'agent-single')!
    expect(node.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
    expect(node.agentName).toBe('solo') // preserved for display/audit
  })

  test('workflow snapshot: every name-only agent node → quarantine sentinel', () => {
    insertAgent('foo')
    insertAgent('bar')
    insertTask({
      id: 't-wf',
      sourceAgentName: null,
      workgroupId: null,
      snapshot: JSON.stringify({
        nodes: [
          { id: 'n1', kind: 'agent-single', agentName: 'foo' },
          { id: 'n2', kind: 'agent-single', agentName: 'bar' },
          { id: 'n3', kind: 'output' },
        ],
      }),
    })
    apply0113()
    const nodes = snapshotOf('t-wf').nodes
    expect(nodes.find((n) => n.id === 'n1')!.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
    expect(nodes.find((n) => n.id === 'n2')!.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
    expect(nodes.find((n) => n.id === 'n3')!.agentId).toBeUndefined() // non-agent untouched
  })

  test('workflow snapshot: a node that already has agentId is left untouched', () => {
    insertTask({
      id: 't-stamped',
      sourceAgentName: null,
      workgroupId: null,
      snapshot: JSON.stringify({
        nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'foo', agentId: 'REAL_ID_ABC' }],
      }),
    })
    apply0113()
    expect(snapshotOf('t-stamped').nodes[0]!.agentId).toBe('REAL_ID_ABC')
  })

  test('workgroup config: agent member with no frozen id → sentinel; human untouched', () => {
    insertTask({
      id: 't-wg',
      sourceAgentName: null,
      workgroupId: 'g1',
      snapshot: '{}',
      configJson: JSON.stringify({
        members: [
          { id: 'm1', memberType: 'agent', agentName: 'x' },
          { id: 'm2', memberType: 'human', userId: 'u1' },
        ],
      }),
    })
    apply0113()
    const members = configOf('t-wg').members
    expect(members.find((m) => m.id === 'm1')!.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
    expect(members.find((m) => m.id === 'm2')!.agentId).toBeUndefined() // human untouched
  })

  test('terminal tasks (done/failed) are left alone — no re-dispatch risk', () => {
    const aId = insertAgent('writer')
    insertTask({
      id: 't-done',
      status: 'done',
      sourceAgentName: 'writer',
      sourceAgentId: aId,
      snapshot: singleAgentSnapshot('writer'),
    })
    apply0113()
    // Snapshot untouched: no agentId stamped (name-only preserved).
    expect(
      snapshotOf('t-done').nodes.find((n) => n.kind === 'agent-single')!.agentId,
    ).toBeUndefined()
  })
})
