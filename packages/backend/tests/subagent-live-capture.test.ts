import { rimrafDir } from './helpers/cleanup'
// RFC-048 — Subagent live capture poller unit tests.
//
// Exercises startLiveSubagentCapture's pure logic against a hand-built
// opencode-shaped SQLite fixture: partId-level dedupe across ticks, new
// child sessions appearing mid-run, sibling sessionId skip, onInsert
// callback semantics, and the consecutive-failure auto-disable path.
//
// These tests run ticks synchronously via the test-only `tickOnce()`
// method on the LivePollerHandle — the production setInterval fire calls
// the same closure, so any behavior we lock in here matches what the
// timer produces.

import { describe, expect, test, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { startLiveSubagentCapture } from '../src/services/subagentLiveCapture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTaskWithNodeRun(db: DbClient): { taskId: string; nodeRunId: string } {
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
      name: 'fixture-task',
      id: taskId,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'running',
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
      status: 'running',
    })
    .run()
  return { taskId, nodeRunId }
}

function createOpencodeDb(dbPath: string): void {
  const db = new Database(dbPath, { create: true })
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT)')
  db.run(
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
  )
  db.run(
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
  )
  db.close()
}

function insertSession(
  dbPath: string,
  s: { id: string; parent_id: string | null; agent: string | null },
): void {
  const db = new Database(dbPath)
  db.run('INSERT INTO session (id, parent_id, agent) VALUES (?, ?, ?)', [
    s.id,
    s.parent_id,
    s.agent,
  ])
  db.close()
}

function insertMessage(
  dbPath: string,
  m: { id: string; session_id: string; time_created: number; data: string },
): void {
  const db = new Database(dbPath)
  db.run('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)', [
    m.id,
    m.session_id,
    m.time_created,
    m.data,
  ])
  db.close()
}

function insertPart(
  dbPath: string,
  p: { id: string; message_id: string; session_id: string; time_created: number; data: string },
): void {
  const db = new Database(dbPath)
  db.run(
    'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
    [p.id, p.message_id, p.session_id, p.time_created, p.data],
  )
  db.close()
}

describe('startLiveSubagentCapture', () => {
  let db: DbClient
  let taskId: string
  let nodeRunId: string
  let workdir: string
  let opencodeDbPath: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    const seeded = seedTaskWithNodeRun(db)
    taskId = seeded.taskId
    nodeRunId = seeded.nodeRunId
    workdir = mkdtempSync(join(tmpdir(), 'rfc048-'))
    opencodeDbPath = join(workdir, 'opencode.db')
    createOpencodeDb(opencodeDbPath)
  })

  test('pollMs = 0 returns a no-op handle (live capture disabled)', () => {
    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 0,
      consecutiveFailureLimit: 5,
      opencodeDbPath,
    })
    expect(handle.stats().disabled).toBe(true)
    expect(handle.stats().ticks).toBe(0)
    handle.stop()
  })

  test('first tick inserts all parts; ticks counter advances', async () => {
    insertSession(opencodeDbPath, { id: 'root', parent_id: null, agent: 'rootAgent' })
    insertSession(opencodeDbPath, { id: 'A', parent_id: 'root', agent: 'subagent' })
    insertMessage(opencodeDbPath, { id: 'mA1', session_id: 'A', time_created: 10, data: '{}' })
    insertPart(opencodeDbPath, {
      id: 'pA1',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 10,
      data: '{"type":"text","text":"hello"}',
    })
    insertPart(opencodeDbPath, {
      id: 'pA2',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 11,
      data: '{"type":"text","text":"world"}',
    })

    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000, // long — we drive ticks manually
      consecutiveFailureLimit: 5,
      opencodeDbPath,
    })
    const inserted = await handle.tickOnce()
    expect(inserted).toBe(2)
    expect(handle.stats().ticks).toBe(1)
    expect(handle.stats().insertedRows).toBe(2)
    const rows = db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId)).all()
    expect(rows).toHaveLength(2)
    expect(handle.stats().insertedPartIdsBySession.get('A')?.size).toBe(2)
    handle.stop()
  })

  test('second tick is idempotent when no new parts arrived', async () => {
    insertSession(opencodeDbPath, { id: 'root', parent_id: null, agent: 'rootAgent' })
    insertSession(opencodeDbPath, { id: 'A', parent_id: 'root', agent: 'subagent' })
    insertMessage(opencodeDbPath, { id: 'mA1', session_id: 'A', time_created: 10, data: '{}' })
    insertPart(opencodeDbPath, {
      id: 'pA1',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 10,
      data: '{"type":"text","text":"hello"}',
    })

    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 5,
      opencodeDbPath,
    })
    expect(await handle.tickOnce()).toBe(1)
    expect(await handle.tickOnce()).toBe(0)
    expect(handle.stats().ticks).toBe(2)
    expect(handle.stats().insertedRows).toBe(1)
    handle.stop()
  })

  test('incremental tick: new parts appended between ticks are inserted, prior parts skipped', async () => {
    insertSession(opencodeDbPath, { id: 'root', parent_id: null, agent: 'rootAgent' })
    insertSession(opencodeDbPath, { id: 'A', parent_id: 'root', agent: 'subagent' })
    insertMessage(opencodeDbPath, { id: 'mA1', session_id: 'A', time_created: 10, data: '{}' })
    insertPart(opencodeDbPath, {
      id: 'pA1',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 10,
      data: '{"type":"text","text":"hello"}',
    })

    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 5,
      opencodeDbPath,
    })
    expect(await handle.tickOnce()).toBe(1)

    // Append two more parts.
    insertPart(opencodeDbPath, {
      id: 'pA2',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 20,
      data: '{"type":"text","text":"again"}',
    })
    insertPart(opencodeDbPath, {
      id: 'pA3',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 30,
      data: '{"type":"text","text":"more"}',
    })

    expect(await handle.tickOnce()).toBe(2)
    expect(handle.stats().insertedRows).toBe(3)
    expect(handle.stats().insertedPartIdsBySession.get('A')?.size).toBe(3)
    handle.stop()
  })

  test('new child session appearing mid-run is picked up on the next tick', async () => {
    insertSession(opencodeDbPath, { id: 'root', parent_id: null, agent: 'rootAgent' })
    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 5,
      opencodeDbPath,
    })
    expect(await handle.tickOnce()).toBe(0) // no children yet

    insertSession(opencodeDbPath, { id: 'NewKid', parent_id: 'root', agent: 'subagent' })
    insertMessage(opencodeDbPath, {
      id: 'mN1',
      session_id: 'NewKid',
      time_created: 5,
      data: '{}',
    })
    insertPart(opencodeDbPath, {
      id: 'pN1',
      message_id: 'mN1',
      session_id: 'NewKid',
      time_created: 5,
      data: '{"type":"text","text":"hi"}',
    })

    expect(await handle.tickOnce()).toBe(1)
    expect(handle.stats().insertedPartIdsBySession.has('NewKid')).toBe(true)
    handle.stop()
  })

  test('sibling sessionId already captured by another nodeRun is fully skipped', async () => {
    // Pre-seed a sibling node_run that already wrote rows for session 'A'.
    const siblingId = ulid()
    db.insert(nodeRuns)
      .values({
        id: siblingId,
        taskId,
        nodeId: 'n2',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        status: 'done',
      })
      .run()
    db.insert(nodeRunEvents)
      .values({
        nodeRunId: siblingId,
        ts: 1,
        kind: 'text',
        payload: '{"part":{"type":"text"}}',
        sessionId: 'A',
        parentSessionId: 'root',
      })
      .run()

    insertSession(opencodeDbPath, { id: 'root', parent_id: null, agent: 'rootAgent' })
    insertSession(opencodeDbPath, { id: 'A', parent_id: 'root', agent: 'subagent' })
    insertMessage(opencodeDbPath, { id: 'mA1', session_id: 'A', time_created: 10, data: '{}' })
    insertPart(opencodeDbPath, {
      id: 'pA1',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 10,
      data: '{"type":"text","text":"x"}',
    })

    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 5,
      opencodeDbPath,
    })
    expect(await handle.tickOnce()).toBe(0)
    expect(handle.stats().insertedPartIdsBySession.has('A')).toBe(false)
    const myRows = db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .all()
    expect(myRows).toHaveLength(0)
    handle.stop()
  })

  test('onInsert fires once per tick with insertedRows > 0; empty ticks do not fire it', async () => {
    insertSession(opencodeDbPath, { id: 'root', parent_id: null, agent: 'rootAgent' })
    insertSession(opencodeDbPath, { id: 'A', parent_id: 'root', agent: 'subagent' })
    insertMessage(opencodeDbPath, { id: 'mA1', session_id: 'A', time_created: 10, data: '{}' })
    insertPart(opencodeDbPath, {
      id: 'pA1',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 10,
      data: '{"type":"text","text":"x"}',
    })
    const onInsert = (() => {
      const calls: Array<{ insertedRows: number; sessionIds: string[] }> = []
      const fn = (info: { insertedRows: number; sessionIds: string[] }): void => {
        calls.push(info)
      }
      return Object.assign(fn, { calls })
    })()
    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 5,
      opencodeDbPath,
      onInsert,
    })
    await handle.tickOnce()
    await handle.tickOnce()
    expect(onInsert.calls).toHaveLength(1)
    expect(onInsert.calls[0]!.insertedRows).toBe(1)
    expect(onInsert.calls[0]!.sessionIds).toEqual(['A'])
    handle.stop()
  })

  test('getRootSessionId returning null short-circuits ticks without IO', async () => {
    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => null,
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 5,
      opencodeDbPath,
    })
    expect(await handle.tickOnce()).toBe(0)
    expect(handle.stats().ticks).toBe(0) // not counted because we returned before BFS
    handle.stop()
  })

  test('consecutive failures auto-disable after the configured limit; subsequent ticks no-op', async () => {
    // Delete the opencode DB so every tick fails with "opencode-db-not-found".
    unlinkSync(opencodeDbPath)
    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 3,
      opencodeDbPath,
    })
    expect(await handle.tickOnce()).toBe(0)
    expect(handle.stats().disabled).toBe(false)
    await handle.tickOnce()
    await handle.tickOnce()
    expect(handle.stats().disabled).toBe(true)
    expect(handle.stats().failedTicks).toBe(3)
    const before = handle.stats().failedTicks
    await handle.tickOnce()
    expect(handle.stats().failedTicks).toBe(before) // disabled → tick early returns
    handle.stop()
  })

  test('successful tick resets the consecutive-failure counter', async () => {
    // Start with the DB missing.
    unlinkSync(opencodeDbPath)
    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 10,
      opencodeDbPath,
    })
    await handle.tickOnce()
    await handle.tickOnce()
    expect(handle.stats().failedTicks).toBe(2)

    // Recreate + seed.
    createOpencodeDb(opencodeDbPath)
    insertSession(opencodeDbPath, { id: 'root', parent_id: null, agent: 'r' })
    insertSession(opencodeDbPath, { id: 'A', parent_id: 'root', agent: 'a' })
    insertMessage(opencodeDbPath, { id: 'mA1', session_id: 'A', time_created: 1, data: '{}' })
    insertPart(opencodeDbPath, {
      id: 'pA1',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 1,
      data: '{"type":"text","text":"x"}',
    })

    expect(await handle.tickOnce()).toBe(1)
    // After a successful tick, failure count is back at 0 so the poller
    // tolerates fresh streaks of 10 without disabling.
    expect(handle.stats().disabled).toBe(false)
    handle.stop()
  })

  test('AbortSignal abort stops the poller (further ticks return 0)', async () => {
    insertSession(opencodeDbPath, { id: 'root', parent_id: null, agent: 'r' })
    insertSession(opencodeDbPath, { id: 'A', parent_id: 'root', agent: 'a' })
    insertMessage(opencodeDbPath, { id: 'mA1', session_id: 'A', time_created: 1, data: '{}' })
    insertPart(opencodeDbPath, {
      id: 'pA1',
      message_id: 'mA1',
      session_id: 'A',
      time_created: 1,
      data: '{"type":"text","text":"x"}',
    })

    const ctrl = new AbortController()
    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 5,
      opencodeDbPath,
      signal: ctrl.signal,
    })
    ctrl.abort()
    expect(await handle.tickOnce()).toBe(0)
    const rows = db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId)).all()
    expect(rows).toHaveLength(0)
    handle.stop() // idempotent
  })

  test('stop() is idempotent', async () => {
    const handle = startLiveSubagentCapture({
      nodeRunId,
      taskId,
      nodeId: 'n1',
      getRootSessionId: () => 'root',
      db,
      pollMs: 50_000,
      consecutiveFailureLimit: 5,
      opencodeDbPath,
    })
    handle.stop()
    handle.stop()
    expect(await handle.tickOnce()).toBe(0)
  })

  // Best-effort cleanup of the per-test temp dir. Bun's beforeEach runs
  // sequentially so leaking is bounded by the test count, but rmSync keeps
  // CI tidy.
  test('cleanup', () => {
    rimrafDir(workdir)
  })
})
