// RFC-223 (PR-3a impl-gate, C1 + C2) — locks migration 0115: extend the R4-1
// frozen-snapshot backfill to the two populations 0113 wrongly excluded.
//
// 0113 scoped every backfill to `status NOT IN (done, failed)` AND excluded
// workgroup tasks from the workflow-snapshot quarantine. Both are fail-OPEN:
//   - C1: a `failed` task can resume and a `done`/`failed` task can retry, and
//     no terminal state blocks the agent rename/delete guard — so a name-only
//     terminal snapshot lets an ABA rename+recreate re-bind a DIFFERENT tenant's
//     agent on the next dispatch.
//   - C2: a workgroup task's generated `workflow_snapshot` DAG (name-only
//     agent-single nodes from the dynamic runner, pre-PR-3b) was never
//     quarantined for ANY status.
//
// This freezes the 0113 → 0115 delta: replay 0000..0114 (snapshots still
// name-only for the terminal/workgroup populations), seed legacy rows, exec the
// real 0115 SQL and assert:
//   - terminal single-agent snapshot node gains agentId = the TRUSTED
//     source_agent_id (NOT the current name → ABA-safe);
//   - terminal single-agent with source_agent_id NULL (pre-0091) → sentinel;
//   - terminal workflow snapshot name-only agent nodes → sentinel;
//   - terminal workgroup config agent members → sentinel;
//   - workgroup workflow_snapshot name-only agent nodes → sentinel, for BOTH a
//     resumable (running) and a terminal (done) workgroup task (C2 + C1);
//   - a node that already carries agentId is untouched (idempotent alongside 0113).
//
// If this reds, the fail-open holes the impl-gate found are back: a stale frozen
// name silently re-binding a DIFFERENT tenant's agent on a terminal-task
// resume/retry, or a legacy workgroup DAG re-binding by the mutable name.

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

describe('migration 0115 (RFC-223 PR-3a terminal) — fresh install is a no-op', () => {
  test('empty tables apply 0000..0115 with zero tasks', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const n = db.$client.query('SELECT COUNT(*) AS n FROM tasks').all() as { n: number }[]
    expect(n[0]!.n).toBe(0)
  })
})

describe('migration 0115 (RFC-223 PR-3a terminal) — C1 + C2 backfill (frozen at 0114)', () => {
  let tmp: string
  let raw: Database

  beforeEach(() => {
    // Freeze the journal at idx<=113 (through 0114) so migrate() stops before
    // 0115 — the terminal / workgroup-snapshot populations are still name-only.
    tmp = mkdtempSync(join(tmpdir(), 'aw-mig0115-'))
    cpSync(MIGRATIONS, tmp, { recursive: true })
    const journalPath = join(tmp, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 113)
    writeFileSync(journalPath, JSON.stringify(journal))

    raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = OFF') // match openDb: 12-step migrations
    migrate(drizzle(raw), { migrationsFolder: tmp })
  })
  afterEach(() => {
    raw?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function apply0115() {
    const sql = readFileSync(join(MIGRATIONS, '0115_rfc223_pr3a_terminal_backfill.sql'), 'utf-8')
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

  // -- C1: terminal single-agent -------------------------------------------
  test('C1: terminal single-agent node gains agentId = the TRUSTED source_agent_id', () => {
    const aId = insertAgent('writer')
    insertTask({
      id: 't-done-trusted',
      status: 'done',
      sourceAgentName: 'writer',
      sourceAgentId: aId,
      snapshot: singleAgentSnapshot('writer'),
    })
    apply0115()
    const node = snapshotOf('t-done-trusted').nodes.find((n) => n.kind === 'agent-single')!
    expect(node.agentId).toBe(aId)
    expect(node.agentName).toBe('writer') // display name preserved
  })

  test('C1 ABA lock: terminal task, rename A + recreate B(same name) → binds A, NOT B', () => {
    // A `failed` task that can be resumed/retried. It froze agent A by NAME only,
    // launch-time id aId. An ABA rename+recreate happened before the migration.
    const aId = insertAgent('writer')
    insertTask({
      id: 't-failed-aba',
      status: 'failed',
      sourceAgentName: 'writer',
      sourceAgentId: aId,
      snapshot: singleAgentSnapshot('writer'),
    })
    raw.query('UPDATE agents SET name = ? WHERE id = ?').run('writer_old', aId)
    const bId = insertAgent('writer')
    apply0115()
    const node = snapshotOf('t-failed-aba').nodes.find((n) => n.kind === 'agent-single')!
    // Must bind ORIGINAL A via the trusted id — never the same-named replacement B.
    expect(node.agentId).toBe(aId)
    expect(node.agentId).not.toBe(bId)
  })

  test('C1: terminal single-agent with source_agent_id NULL (pre-0091) → sentinel', () => {
    insertAgent('solo')
    insertTask({
      id: 't-failed-null',
      status: 'failed',
      sourceAgentName: 'solo',
      sourceAgentId: null,
      snapshot: singleAgentSnapshot('solo'),
    })
    apply0115()
    const node = snapshotOf('t-failed-null').nodes.find((n) => n.kind === 'agent-single')!
    expect(node.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
    expect(node.agentName).toBe('solo')
  })

  // -- C1: terminal workflow (non-workgroup) -------------------------------
  test('C1: terminal workflow snapshot — every name-only agent node → sentinel', () => {
    insertAgent('foo')
    insertTask({
      id: 't-done-wf',
      status: 'done',
      sourceAgentName: null,
      workgroupId: null,
      snapshot: JSON.stringify({
        nodes: [
          { id: 'n1', kind: 'agent-single', agentName: 'foo' },
          { id: 'n2', kind: 'output' },
        ],
      }),
    })
    apply0115()
    const nodes = snapshotOf('t-done-wf').nodes
    expect(nodes.find((n) => n.id === 'n1')!.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
    expect(nodes.find((n) => n.id === 'n2')!.agentId).toBeUndefined()
  })

  // -- C1: terminal workgroup members --------------------------------------
  test('C1: terminal workgroup config agent member → sentinel; human untouched', () => {
    insertTask({
      id: 't-done-wg-cfg',
      status: 'done',
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
    apply0115()
    const members = configOf('t-done-wg-cfg').members
    expect(members.find((m) => m.id === 'm1')!.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
    expect(members.find((m) => m.id === 'm2')!.agentId).toBeUndefined()
  })

  // -- C2: workgroup workflow_snapshot (dynamic DAG), both statuses ---------
  test('C2: RESUMABLE workgroup snapshot — name-only agent nodes → sentinel', () => {
    insertAgent('planner')
    insertTask({
      id: 't-run-wg-snap',
      status: 'running',
      sourceAgentName: null,
      workgroupId: 'g1',
      snapshot: JSON.stringify({
        nodes: [
          { id: 'd1', kind: 'agent-single', agentName: 'planner' },
          { id: 'd2', kind: 'output' },
        ],
      }),
    })
    apply0115()
    const nodes = snapshotOf('t-run-wg-snap').nodes
    // 0113 left this fully un-quarantined (its stmt 3 required workgroup_id IS NULL).
    expect(nodes.find((n) => n.id === 'd1')!.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
    expect(nodes.find((n) => n.id === 'd2')!.agentId).toBeUndefined()
  })

  test('C2: TERMINAL workgroup snapshot — name-only agent nodes → sentinel', () => {
    insertAgent('planner')
    insertTask({
      id: 't-done-wg-snap',
      status: 'done',
      sourceAgentName: null,
      workgroupId: 'g1',
      snapshot: JSON.stringify({
        nodes: [{ id: 'd1', kind: 'agent-single', agentName: 'planner' }],
      }),
    })
    apply0115()
    expect(snapshotOf('t-done-wg-snap').nodes[0]!.agentId).toBe(QUARANTINED_SNAPSHOT_AGENT_ID)
  })

  // -- idempotency / already-stamped ---------------------------------------
  test('a node that already carries agentId is left untouched (idempotent with 0113)', () => {
    insertTask({
      id: 't-done-stamped',
      status: 'done',
      sourceAgentName: null,
      workgroupId: 'g1',
      snapshot: JSON.stringify({
        nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'foo', agentId: 'REAL_ID_ABC' }],
      }),
    })
    apply0115()
    expect(snapshotOf('t-done-stamped').nodes[0]!.agentId).toBe('REAL_ID_ABC')
  })

  test('a RESUMABLE non-workgroup task is untouched here (0113 already handled it)', () => {
    // 0115 must not double-process the population 0113 owns: a running single-agent
    // task's node keeps whatever 0113 stamped. We assert 0115 alone (frozen at 0114,
    // so 0113 already ran in the migrate() replay) leaves a running task's fresh
    // name-only node to 0113's own domain — here we just confirm 0115's terminal
    // filter does not touch a running single-agent task.
    const aId = insertAgent('runner')
    insertTask({
      id: 't-running-single',
      status: 'running',
      sourceAgentName: 'runner',
      sourceAgentId: aId,
      // Node intentionally name-only to prove 0115's status filter skips it.
      snapshot: singleAgentSnapshot('runner'),
    })
    apply0115()
    // 0115 (terminal-only for single-agent) must NOT stamp this running task.
    expect(
      snapshotOf('t-running-single').nodes.find((n) => n.kind === 'agent-single')!.agentId,
    ).toBeUndefined()
  })
})
