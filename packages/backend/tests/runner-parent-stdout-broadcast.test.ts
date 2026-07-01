// Regression test for the parent-stdout live broadcast gap that left the
// SessionTab stuck mid-run for workflows whose worker never spawned a
// subagent (so RFC-048's subagent live poller never fired). Once the runner
// writes a `node_run_events` row from `stdoutPump`, it now broadcasts a
// throttled `node.status: running` ping so the frontend `useTaskSync`
// invalidates `['tasks', taskId, 'node-runs', nodeRunId, 'session']` and
// the conversation list refreshes without the user switching tabs.
//
// Locks in: at least ONE `node.status: running` broadcast carrying the
// runner's own nodeRunId is observed before the run reaches its terminal
// status. The 500ms throttle and the scheduler-emitted trailing
// `node.status: done` are intentionally NOT asserted here — they're
// implementation details that would over-constrain the test.

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'
import { TASK_CHANNEL, resetBroadcastersForTests, taskBroadcaster } from '../src/ws/broadcaster'

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
    name: 'parent-broadcast-agent',
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

function seedTask(db: DbClient): string {
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
  return taskId
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-parent-broadcast-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const taskId = seedTask(db)
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
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

describe('runner parent-stdout live broadcast', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
    resetBroadcastersForTests()
  })
  afterEach(() => {
    h.cleanup()
    resetBroadcastersForTests()
  })

  test('stdoutPump emits at least one node.status:running ping per parent event burst', async () => {
    const nodeRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: nodeRunId,
      taskId: h.taskId,
      nodeId: 'n1',
      status: 'pending',
    })

    const captured: Array<{ type: string; nodeRunId?: string; status?: string }> = []
    const unsub = taskBroadcaster.subscribe(TASK_CHANNEL(h.taskId), (msg) => {
      captured.push(msg as { type: string; nodeRunId?: string; status?: string })
    })

    try {
      await withEnv(
        {
          // Two synthetic text events: the first should trigger a broadcast
          // (lastParentBroadcastTs starts at 0); the second is throttled
          // within the same 500ms window — both assertions stay agnostic to
          // exact count.
          MOCK_OPENCODE_EVENTS: JSON.stringify([
            { type: 'text', timestamp: 1, part: { type: 'text', text: 'hello' } },
            { type: 'text', timestamp: 2, part: { type: 'text', text: 'world' } },
          ]),
          MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
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
            // Disable RFC-048 live poller so the only `node.status: running`
            // pings on the channel come from the parent stdoutPump under test.
            subagentLiveCapture: { pollMs: 0, consecutiveFailureLimit: 5 },
          }),
      )
    } finally {
      unsub()
    }

    const parentPings = captured.filter(
      (m) => m.type === 'node.status' && m.nodeRunId === nodeRunId && m.status === 'running',
    )
    // >=2 distinguishes the stdoutPump broadcast from the single RFC-047
    // eager injected-memory-snapshot broadcast (which fires before
    // stdoutPump runs). Without the stdoutPump fix, the count would be
    // exactly 1 (eager only), because the RFC-048 subagent live poller is
    // disabled here via `pollMs: 0`.
    expect(parentPings.length).toBeGreaterThanOrEqual(2)
  })
})
