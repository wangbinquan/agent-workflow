import { rimrafDir } from './helpers/cleanup'
// RFC-027 T3 — locks the runner's per-row session_id / parent_session_id
// tagging for stdout-derived events. The Session view's session
// bucketing assumes every stdout-derived row carries the captured root
// sessionID and a null parentSessionID. Regressions here let parent
// events spill into a "(unknown)" bucket and break the conversation
// view.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
  cleanup: () => void
}

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'test-agent',
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

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc027-runner-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rimrafDir(appHome),
  }
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

describe('runner stdout → node_run_events session tagging', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('every stdout-derived row gets the root sessionID and parentSessionId=null', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_EMIT_SESSION_ID: 'sess_root_test',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: JSON.stringify([
          { type: 'step_start' },
          { type: 'text', text: 'hi' },
          { type: 'step_finish' },
        ]),
        // Point post-run capture at a non-existent home so it doesn't read
        // the developer's actual opencode DB during this unit test.
        OPENCODE_TEST_HOME: join(h.appHome, 'fake-home'),
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
        }),
    )

    const rows = h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .all()
    const stdoutRows = rows.filter((r) => r.kind !== 'subagent_capture_failed')
    expect(stdoutRows.length).toBeGreaterThan(0)
    for (const r of stdoutRows) {
      expect(r.sessionId).toBe('sess_root_test')
      expect(r.parentSessionId).toBeNull()
    }
  })

  test('post-run subagent_capture_failed marker is tagged with the root sessionId, parent=null', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_EMIT_SESSION_ID: 'sess_root_marker',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'x' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-such-home'),
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
        }),
    )
    const rows = h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .all()
    const marker = rows.find((r) => r.kind === 'subagent_capture_failed')
    expect(marker).toBeDefined()
    expect(marker!.sessionId).toBe('sess_root_marker')
    expect(marker!.parentSessionId).toBeNull()
  })
})
