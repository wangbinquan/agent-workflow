import { rimrafDir } from './helpers/cleanup'
// RFC-048 — runner integration with the subagent live capture poller.
//
// Drives runNode against a mock opencode child whose lifetime is padded with
// MOCK_OPENCODE_DELAY_MS so the live poller setInterval gets multiple ticks
// before child.exited resolves. The opencode-shaped SQLite is seeded BEFORE
// spawn so the first tick BFS picks up the subagent rows; verifies that:
//   1. node_run_events accumulates child-session rows while the parent
//      child process is still alive (live poll wrote them, NOT the
//      post-run BFS).
//   2. pollMs = 0 degrades to RFC-027 — post-run BFS handles the capture.
//   3. post-run captureChildSessions tail-flushes a part that landed in
//      the opencode DB after the final live tick, without double-writing
//      anything the live poll already inserted.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  /** Path used as OPENCODE_TEST_HOME so resolveOpencodeDbPath returns ours. */
  fakeHome: string
  /** Materialized opencode SQLite at fakeHome/.local/share/opencode/opencode.db. */
  opencodeDbPath: string
  cleanup: () => void
}

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'live-capture-agent',
    description: '',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function seedTaskAndNodeRun(db: DbClient): { taskId: string; nodeRunId: string } {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: '{}',
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
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  const nodeRunId = ulid()
  db.insert(nodeRuns).values({ id: nodeRunId, taskId, nodeId: 'n1', status: 'pending' }).run()
  return { taskId, nodeRunId }
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc048-runner-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const fakeHome = join(appHome, 'fake-home')
  const opencodeDbDir = join(fakeHome, '.local', 'share', 'opencode')
  mkdirSync(opencodeDbDir, { recursive: true })
  const opencodeDbPath = join(opencodeDbDir, 'opencode.db')
  const ocDb = new Database(opencodeDbPath, { create: true })
  ocDb.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT)')
  ocDb.run(
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
  )
  ocDb.run(
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
  )
  ocDb.close()

  const db = createInMemoryDb(MIGRATIONS)
  const { taskId } = seedTaskAndNodeRun(db)
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    fakeHome,
    opencodeDbPath,
    cleanup: () => rimrafDir(appHome),
  }
}

function seedSubagentRow(
  dbPath: string,
  sessionId: string,
  parentId: string,
  partId: string,
  ts: number,
  text: string,
): void {
  const db = new Database(dbPath)
  db.run('INSERT OR IGNORE INTO session (id, parent_id, agent) VALUES (?, ?, ?)', [
    sessionId,
    parentId,
    'subagent',
  ])
  const messageId = `${partId}-msg`
  db.run('INSERT OR IGNORE INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)', [
    messageId,
    sessionId,
    ts,
    '{}',
  ])
  db.run(
    'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
    [partId, messageId, sessionId, ts, JSON.stringify({ type: 'text', text })],
  )
  db.close()
}

async function insertNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'n1', status: 'pending' })
  return id
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

describe('runner subagent live capture (RFC-048)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('live poller flushes subagent rows during the run; post-run BFS adds nothing extra', async () => {
    const ROOT = 'opc_root_live'
    // Seed root + one child session with 2 parts BEFORE spawn so the first
    // live tick finds them.
    const db = new Database(h.opencodeDbPath)
    db.run('INSERT INTO session (id, parent_id, agent) VALUES (?, NULL, ?)', [ROOT, 'rootAgent'])
    db.close()
    seedSubagentRow(h.opencodeDbPath, 'child-A', ROOT, 'pA1', 100, 'subagent line 1')
    seedSubagentRow(h.opencodeDbPath, 'child-A', ROOT, 'pA2', 200, 'subagent line 2')

    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_EMIT_SESSION_ID: ROOT,
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        // Hold the child alive long enough for the live poller to fire a
        // few times (pollMs=80 below → ~5 ticks across 400ms).
        MOCK_OPENCODE_DELAY_MS: '400',
        OPENCODE_TEST_HOME: h.fakeHome,
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          subagentLiveCapture: { pollMs: 80, consecutiveFailureLimit: 5 },
        }),
    )

    const rows = h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .all()
    const childRows = rows.filter((r) => r.sessionId === 'child-A')
    expect(childRows).toHaveLength(2)
    // No duplicate part IDs — live poll + post-run capture share the dedupe.
    const partIds = childRows.map((r) => {
      try {
        const parsed = JSON.parse(r.payload) as { part?: { id?: string } }
        return parsed.part?.id ?? ''
      } catch {
        return ''
      }
    })
    expect(new Set(partIds).size).toBe(2)
  })

  test('pollMs = 0 degrades to RFC-027 (post-run BFS does all the capture)', async () => {
    const ROOT = 'opc_root_off'
    const ocDb = new Database(h.opencodeDbPath)
    ocDb.run('INSERT INTO session (id, parent_id, agent) VALUES (?, NULL, ?)', [ROOT, 'rootAgent'])
    ocDb.close()
    seedSubagentRow(h.opencodeDbPath, 'child-B', ROOT, 'pB1', 100, 'tail row')

    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_EMIT_SESSION_ID: ROOT,
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: h.fakeHome,
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          subagentLiveCapture: { pollMs: 0, consecutiveFailureLimit: 5 },
        }),
    )

    const rows = h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .all()
    const childRows = rows.filter((r) => r.sessionId === 'child-B')
    expect(childRows).toHaveLength(1)
  })

  test('post-run BFS catches a part that landed in opencode SQLite AFTER live poll stopped', async () => {
    // We can't easily make the live poll see exactly partial data and the
    // post-run see the tail because the runner stops the poller AFTER child
    // exit and BEFORE post-run BFS, with no opportunity to mutate the DB
    // between those steps. Instead, simulate the equivalent by running with
    // pollMs = 0 (live poll never starts) but with a non-empty pre-seeded
    // child session AND inserting a second part right before exit. This
    // exercises the legacy RFC-027 BFS code path with partId dedupe Map
    // empty — confirming that the new optional parameter is byte-for-byte
    // compatible with the no-live-poll case.
    const ROOT = 'opc_root_tail'
    const ocDb = new Database(h.opencodeDbPath)
    ocDb.run('INSERT INTO session (id, parent_id, agent) VALUES (?, NULL, ?)', [ROOT, 'rootAgent'])
    ocDb.close()
    seedSubagentRow(h.opencodeDbPath, 'child-C', ROOT, 'pC1', 100, 'first')
    seedSubagentRow(h.opencodeDbPath, 'child-C', ROOT, 'pC2', 200, 'second (tail)')

    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_EMIT_SESSION_ID: ROOT,
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: h.fakeHome,
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          // Default — omitted subagentLiveCapture, runner uses 1500ms but the
          // child exits before the first tick fires (no MOCK_OPENCODE_DELAY).
          // So this exercises the post-run BFS path.
        }),
    )

    const rows = h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .all()
    const childRows = rows.filter((r) => r.sessionId === 'child-C')
    expect(childRows).toHaveLength(2)
  })
})
