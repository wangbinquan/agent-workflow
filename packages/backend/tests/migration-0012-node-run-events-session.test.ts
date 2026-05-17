// RFC-027 T2 — locks migration 0012: node_run_events gains nullable
// `session_id` and `parent_session_id` columns plus a composite index
// `idx_events_session` on (node_run_id, session_id, id). Legacy rows
// inserted pre-RFC-027 (without the fields) come back as NULL. New
// rows can write and read the values back.
//
// If this test fails, the Session view tab's session bucketing
// assumption breaks (frontend parseSessionTree relies on session_id
// being present per row, with NULL meaning "root bucket").

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedNodeRun(db: DbClient): string {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  const nodeRunId = ulid()
  db.insert(nodeRuns)
    .values({
      id: nodeRunId,
      taskId,
      nodeId: 'n1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: 0,
      status: 'done',
    })
    .run()
  return nodeRunId
}

describe('migration 0012 (RFC-027 node_run_events.session_id / parent_session_id)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('session_id stores values and is null when omitted', () => {
    const nodeRunId = seedNodeRun(db)
    db.insert(nodeRunEvents)
      .values({
        nodeRunId,
        ts: 1,
        kind: 'text',
        payload: '{"part":{"type":"text","text":"hi"}}',
        sessionId: 'root-sess',
      })
      .run()
    db.insert(nodeRunEvents)
      .values({
        nodeRunId,
        ts: 2,
        kind: 'text',
        payload: '{"part":{"type":"text","text":"legacy"}}',
        // sessionId intentionally omitted — should land as NULL
      })
      .run()
    const rows = db.select().from(nodeRunEvents).all()
    expect(rows).toHaveLength(2)
    const bySession = new Map(rows.map((r) => [r.payload, r]))
    expect(bySession.get('{"part":{"type":"text","text":"hi"}}')?.sessionId).toBe('root-sess')
    expect(bySession.get('{"part":{"type":"text","text":"legacy"}}')?.sessionId).toBeNull()
  })

  test('parent_session_id stores child→parent linkage and is null for root', () => {
    const nodeRunId = seedNodeRun(db)
    db.insert(nodeRunEvents)
      .values({
        nodeRunId,
        ts: 1,
        kind: 'text',
        payload: '{"part":{"type":"text","text":"root"}}',
        sessionId: 'root-sess',
        parentSessionId: null,
      })
      .run()
    db.insert(nodeRunEvents)
      .values({
        nodeRunId,
        ts: 2,
        kind: 'text',
        payload: '{"part":{"type":"text","text":"child"}}',
        sessionId: 'child-sess',
        parentSessionId: 'root-sess',
      })
      .run()
    const rows = db.select().from(nodeRunEvents).all()
    const root = rows.find((r) => r.sessionId === 'root-sess')
    const child = rows.find((r) => r.sessionId === 'child-sess')
    expect(root?.parentSessionId).toBeNull()
    expect(child?.parentSessionId).toBe('root-sess')
  })

  test('subagent_capture_failed marker kind is accepted by the enum', () => {
    const nodeRunId = seedNodeRun(db)
    db.insert(nodeRunEvents)
      .values({
        nodeRunId,
        ts: 1,
        kind: 'subagent_capture_failed',
        payload: '{"sessionID":"child-x","reason":"opencode-db-not-found"}',
        sessionId: 'child-x',
        parentSessionId: 'root-sess',
      })
      .run()
    const rows = db.select().from(nodeRunEvents).all()
    expect(rows[0]?.kind).toBe('subagent_capture_failed')
  })

  test('idx_events_session index exists on (node_run_id, session_id, id)', () => {
    // sqlite_master.sql carries the full CREATE INDEX statement; assert it
    // names all three columns so a refactor that drops session_id from the
    // index makes this fail loudly.
    const row = db
      .select({
        sql: sql<string>`sql`,
      })
      .from(sql`sqlite_master`)
      .where(sql`name = 'idx_events_session'`)
      .all()
    expect(row).toHaveLength(1)
    const ddl = row[0]!.sql.toLowerCase()
    expect(ddl).toContain('node_run_id')
    expect(ddl).toContain('session_id')
    expect(ddl).toMatch(/[`"]?id[`"]?\s*\)/)
  })
})
