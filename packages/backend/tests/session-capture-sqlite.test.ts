// RFC-027 T3 — exercises captureChildSessions against a hand-built
// opencode-shaped SQLite fixture. Covers the path BFS, message+part
// transcoding, the missing-DB fallback, and the readonly contract.

import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { captureChildSessions, resolveOpencodeDbPath } from '../src/services/sessionCapture'

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

interface BuildOpts {
  /** session graph: root → [child A → [grandchild C], child B]. */
  sessions: Array<{ id: string; parent_id: string | null; agent: string | null }>
  messages: Array<{ id: string; session_id: string; time_created: number; data: string }>
  parts: Array<{
    id: string
    message_id: string
    session_id: string
    time_created: number
    data: string
  }>
}

function buildOpencodeDb(opts: BuildOpts): string {
  const dir = mkdtempSync(join(tmpdir(), 'rfc027-oc-'))
  const dbPath = join(dir, 'opencode.db')
  const db = new Database(dbPath, { create: true })
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT)')
  db.run(
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
  )
  db.run(
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
  )
  for (const s of opts.sessions) {
    db.run('INSERT INTO session (id, parent_id, agent) VALUES (?, ?, ?)', [
      s.id,
      s.parent_id,
      s.agent,
    ])
  }
  for (const m of opts.messages) {
    db.run('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)', [
      m.id,
      m.session_id,
      m.time_created,
      m.data,
    ])
  }
  for (const p of opts.parts) {
    db.run(
      'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
      [p.id, p.message_id, p.session_id, p.time_created, p.data],
    )
  }
  db.close()
  return dbPath
}

describe('resolveOpencodeDbPath', () => {
  test('honors OPENCODE_TEST_HOME override', () => {
    const path = resolveOpencodeDbPath({
      OPENCODE_TEST_HOME: '/tmp/fake-home',
      XDG_DATA_HOME: '/tmp/fake-home/data',
    } as NodeJS.ProcessEnv)
    expect(path).toBe('/tmp/fake-home/data/opencode/opencode.db')
  })

  test('falls back to XDG default per platform when no overrides set', () => {
    const path = resolveOpencodeDbPath({
      OPENCODE_TEST_HOME: '/users/me',
    } as NodeJS.ProcessEnv)
    expect(path).toMatch(
      /\/users\/me\/(Library\/Application Support|\.local\/share)\/opencode\/opencode\.db/,
    )
  })
})

describe('captureChildSessions', () => {
  let db: DbClient
  let nodeRunId: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    nodeRunId = seedNodeRun(db)
  })

  test('missing opencode DB writes a subagent_capture_failed marker and returns failed=true', async () => {
    const result = await captureChildSessions({
      rootSessionId: 'root',
      nodeRunId,
      db,
      opencodeDbPath: '/tmp/definitely-does-not-exist-xyz/opencode.db',
    })
    expect(result.failed).toBe(true)
    expect(result.failureReason).toBe('opencode-db-not-found')
    const rows = db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('subagent_capture_failed')
  })

  test('BFS pulls a three-level nested session tree (root → A → B → C)', async () => {
    const opencodeDb = buildOpencodeDb({
      sessions: [
        { id: 'root', parent_id: null, agent: 'rootAgent' },
        { id: 'A', parent_id: 'root', agent: 'midAgent' },
        { id: 'B', parent_id: 'A', agent: 'leafAgent' },
        { id: 'C', parent_id: 'B', agent: 'tinyAgent' },
      ],
      messages: [
        { id: 'mA', session_id: 'A', time_created: 10, data: '{}' },
        { id: 'mB', session_id: 'B', time_created: 20, data: '{}' },
        { id: 'mC', session_id: 'C', time_created: 30, data: '{}' },
      ],
      parts: [
        {
          id: 'pA',
          message_id: 'mA',
          session_id: 'A',
          time_created: 10,
          data: '{"type":"text","text":"a"}',
        },
        {
          id: 'pB',
          message_id: 'mB',
          session_id: 'B',
          time_created: 20,
          data: '{"type":"text","text":"b"}',
        },
        {
          id: 'pC',
          message_id: 'mC',
          session_id: 'C',
          time_created: 30,
          data: '{"type":"text","text":"c"}',
        },
      ],
    })
    const result = await captureChildSessions({
      rootSessionId: 'root',
      nodeRunId,
      db,
      opencodeDbPath: opencodeDb,
    })
    expect(result.failed).toBe(false)
    expect(result.capturedSessionIds.sort()).toEqual(['A', 'B', 'C'])
    expect(result.insertedEventRows).toBe(3)
    const rows = db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId)).all()
    const bySession = new Map<string, typeof rows>()
    for (const r of rows) {
      const key = r.sessionId ?? '<null>'
      const arr = bySession.get(key) ?? []
      arr.push(r)
      bySession.set(key, arr)
    }
    expect(bySession.get('A')?.[0]!.parentSessionId).toBe('root')
    expect(bySession.get('B')?.[0]!.parentSessionId).toBe('A')
    expect(bySession.get('C')?.[0]!.parentSessionId).toBe('B')
  })

  test('skips the root session itself — parent stdout already wrote root events', async () => {
    const opencodeDb = buildOpencodeDb({
      sessions: [{ id: 'root', parent_id: null, agent: 'rootAgent' }],
      messages: [{ id: 'mR', session_id: 'root', time_created: 1, data: '{}' }],
      parts: [
        {
          id: 'pR',
          message_id: 'mR',
          session_id: 'root',
          time_created: 1,
          data: '{"type":"text","text":"root"}',
        },
      ],
    })
    const result = await captureChildSessions({
      rootSessionId: 'root',
      nodeRunId,
      db,
      opencodeDbPath: opencodeDb,
    })
    expect(result.capturedSessionIds).toEqual([])
    expect(result.insertedEventRows).toBe(0)
    const rows = db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId)).all()
    expect(rows).toHaveLength(0)
  })

  test('readonly contract — capture does not write to the opencode DB', async () => {
    const opencodeDb = buildOpencodeDb({
      sessions: [
        { id: 'root', parent_id: null, agent: 'r' },
        { id: 'A', parent_id: 'root', agent: 'a' },
      ],
      messages: [{ id: 'mA', session_id: 'A', time_created: 1, data: '{}' }],
      parts: [
        {
          id: 'pA',
          message_id: 'mA',
          session_id: 'A',
          time_created: 1,
          data: '{"type":"text","text":"x"}',
        },
      ],
    })
    await captureChildSessions({
      rootSessionId: 'root',
      nodeRunId,
      db,
      opencodeDbPath: opencodeDb,
    })
    // Verify no writes happened to the opencode db (row counts unchanged).
    const verify = new Database(opencodeDb, { readonly: true })
    const sessionCount = verify.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM session').get()!
      .c
    const partCount = verify.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM part').get()!.c
    verify.close()
    expect(sessionCount).toBe(2)
    expect(partCount).toBe(1)
  })

  test('schema mismatch (missing column) lands a capture-failed marker, does not throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc027-broken-'))
    const dbPath = join(dir, 'opencode.db')
    const broken = new Database(dbPath, { create: true })
    broken.run('CREATE TABLE session (id TEXT PRIMARY KEY)') // missing parent_id, agent
    broken.close()
    const result = await captureChildSessions({
      rootSessionId: 'root',
      nodeRunId,
      db,
      opencodeDbPath: dbPath,
    })
    expect(result.failed).toBe(true)
    const rows = db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId)).all()
    expect(rows.some((r) => r.kind === 'subagent_capture_failed')).toBe(true)
  })

  test('cycle in session.parent_id (root → A → root) is bounded by visited set', async () => {
    // While opencode shouldn't ever insert such a cycle, the BFS must
    // terminate even on malformed data so capture failures don't hang
    // the runner.
    const opencodeDb = buildOpencodeDb({
      sessions: [
        { id: 'root', parent_id: 'A', agent: 'r' },
        { id: 'A', parent_id: 'root', agent: 'a' },
      ],
      messages: [],
      parts: [],
    })
    const result = await captureChildSessions({
      rootSessionId: 'root',
      nodeRunId,
      db,
      opencodeDbPath: opencodeDb,
    })
    expect(result.failed).toBe(false)
    expect(result.capturedSessionIds).toEqual(['A'])
  })
})
