// RFC-043 T3 — exercises captureDistillJobSession against a hand-built
// opencode-shaped SQLite fixture. Mirrors session-capture-sqlite.test.ts
// but writes to memory_distill_events instead of node_run_events and
// keys rows by (distillJobId, attemptIndex) — distiller has no
// task-scoped sibling dedup.

import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memoryDistillEvents, memoryDistillJobs } from '../src/db/schema'
import {
  captureDistillJobSession,
  DISTILL_CAPTURE_FAILED_KIND,
} from '../src/services/runtime/opencode/distillSessionCapture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedJob(db: DbClient): string {
  const id = ulid()
  db.insert(memoryDistillJobs)
    .values({
      id,
      debounceKey: 'task-x:clarify',
      sourceKind: 'clarify',
      sourceEventId: 'src-1',
      taskId: null,
      scopeResolvedJson: '{}',
      status: 'running',
      attempts: 0,
      nextRunAt: Date.now(),
      createdAt: Date.now(),
    })
    .run()
  return id
}

interface BuildOpts {
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
  const dir = mkdtempSync(join(tmpdir(), 'rfc043-oc-'))
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

describe('captureDistillJobSession', () => {
  let db: DbClient
  let jobId: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    jobId = seedJob(db)
  })

  test('missing opencode DB writes a capture-failed marker and returns failed=true', async () => {
    const result = await captureDistillJobSession({
      rootSessionId: 'root',
      distillJobId: jobId,
      attemptIndex: 0,
      db,
      opencodeDbPath: '/tmp/definitely-does-not-exist-rfc043/opencode.db',
    })
    expect(result.failed).toBe(true)
    expect(result.failureReason).toBe('opencode-db-not-found')
    const rows = db
      .select()
      .from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, jobId))
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe(DISTILL_CAPTURE_FAILED_KIND)
    expect(rows[0]!.attemptIndex).toBe(0)
  })

  test('captures root session events (unlike worker-node path where stdout already wrote them)', async () => {
    const opencodeDb = buildOpencodeDb({
      sessions: [{ id: 'root-distill', parent_id: null, agent: 'aw-memory-distiller' }],
      messages: [{ id: 'm1', session_id: 'root-distill', time_created: 10, data: '{}' }],
      parts: [
        {
          id: 'p1',
          message_id: 'm1',
          session_id: 'root-distill',
          time_created: 10,
          data: '{"type":"text","text":"distilled reasoning"}',
        },
      ],
    })
    const result = await captureDistillJobSession({
      rootSessionId: 'root-distill',
      distillJobId: jobId,
      attemptIndex: 0,
      db,
      opencodeDbPath: opencodeDb,
    })
    expect(result.failed).toBe(false)
    expect(result.insertedEventRows).toBe(1)
    const rows = db
      .select()
      .from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, jobId))
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('root-distill')
    expect(rows[0]!.parentSessionId).toBeNull()
    expect(rows[0]!.attemptIndex).toBe(0)
  })

  test('attemptIndex tags rows per retry round so detail page can group them', async () => {
    const opencodeDb = buildOpencodeDb({
      sessions: [{ id: 'sess-X', parent_id: null, agent: 'aw-memory-distiller' }],
      messages: [{ id: 'm', session_id: 'sess-X', time_created: 5, data: '{}' }],
      parts: [
        {
          id: 'p',
          message_id: 'm',
          session_id: 'sess-X',
          time_created: 5,
          data: '{"type":"text","text":"hi"}',
        },
      ],
    })
    await captureDistillJobSession({
      rootSessionId: 'sess-X',
      distillJobId: jobId,
      attemptIndex: 0,
      db,
      opencodeDbPath: opencodeDb,
    })
    await captureDistillJobSession({
      rootSessionId: 'sess-X',
      distillJobId: jobId,
      attemptIndex: 1,
      db,
      opencodeDbPath: opencodeDb,
    })
    const rows = db
      .select()
      .from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, jobId))
      .all()
    const indexes = rows.map((r) => r.attemptIndex).sort()
    expect(indexes).toEqual([0, 1])
  })

  test('BFS reaches child subagent sessions even though distiller has none in practice', async () => {
    const opencodeDb = buildOpencodeDb({
      sessions: [
        { id: 'root', parent_id: null, agent: 'aw-memory-distiller' },
        { id: 'child', parent_id: 'root', agent: 'subagent' },
      ],
      messages: [
        { id: 'mR', session_id: 'root', time_created: 1, data: '{}' },
        { id: 'mC', session_id: 'child', time_created: 2, data: '{}' },
      ],
      parts: [
        {
          id: 'pR',
          message_id: 'mR',
          session_id: 'root',
          time_created: 1,
          data: '{"type":"text","text":"root"}',
        },
        {
          id: 'pC',
          message_id: 'mC',
          session_id: 'child',
          time_created: 2,
          data: '{"type":"text","text":"child"}',
        },
      ],
    })
    const result = await captureDistillJobSession({
      rootSessionId: 'root',
      distillJobId: jobId,
      attemptIndex: 0,
      db,
      opencodeDbPath: opencodeDb,
    })
    expect(result.capturedSessionIds.sort()).toEqual(['child', 'root'])
    expect(result.insertedEventRows).toBe(2)
    const rows = db
      .select()
      .from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, jobId))
      .all()
    const bySession = new Map(rows.map((r) => [r.sessionId, r]))
    expect(bySession.get('root')?.parentSessionId).toBeNull()
    expect(bySession.get('child')?.parentSessionId).toBe('root')
  })
})
