// Locked regression — cancelling a running wrapper-fanout leaves the wrapper
// node_run row 'failed' instead of 'canceled'.
//
// DEFECT (MED): when a task is aborted mid-fanout, each shard's runNode returns
//   status='canceled' (runner.ts:953-955, after the AbortSignal SIGTERMs the
//   child). But dispatchFanoutShard maps EVERY non-done status to kind:'failed'
//   (scheduler.ts:2798-2804) — it does not distinguish canceled from failed.
//   That makes failedShards.length > 0, so markWrapperTerminal is called with
//   'failed' (scheduler.ts:2514-2516). Meanwhile the task itself short-circuits
//   to 'canceled' via the signal-aborted path (scheduler.ts:364-366 ←
//   runScope's kind:'canceled' at scheduler.ts:577-581). Result: the task row
//   is 'canceled' but its wrapper-fanout node_run row is 'failed' — a status
//   mismatch. A canceled task must not leave behind a 'failed' run.
//
// CORRECT (post-fix) behavior: a fanout aborted by signal marks the wrapper row
//   'canceled', mirroring the wrapper-loop cancel path (scheduler.ts:2194-2197,
//   which calls markWrapperTerminal('canceled')). The fix is to have
//   dispatchFanoutShard surface 'canceled' distinctly so the fanout finalizer
//   maps cancel → markWrapperTerminal('canceled').
//
// RED until dispatchFanoutShard distinguishes canceled shards and the
//   wrapper-fanout finalizer marks the wrapper row 'canceled' on cancel.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-red-cancelfan-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}
async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(agents).values({
    id: `agent-${name}`,
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify(extra),
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}
async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
    startedAt: Date.now(),
  })
  return taskId
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

// wrapper-fanout WITHOUT an aggregator: 3 shards from inputs {docs:'a.md\nb.md\nc.md'}.
function fanoutDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'files', key: 'docs', label: 'docs' }],
    nodes: [
      { id: 'inp', kind: 'input', inputKey: 'docs' },
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      {
        id: 'inner',
        kind: 'agent-single',
        agentId: 'agent-worker',
        agentName: 'worker',
        promptTemplate: 'Process {{doc}}',
      },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'inp', portName: 'docs' },
        target: { nodeId: 'fan', portName: 'docs' },
      },
      {
        id: 'eB',
        source: { nodeId: 'fan', portName: 'docs' },
        target: { nodeId: 'inner', portName: 'doc' },
        boundary: 'wrapper-input',
      },
    ],
  }
}

describe('regression: cancelling a running wrapper-fanout must mark the wrapper row canceled, not failed (scheduler.ts:2798-2804 → 2516)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  // Three readonly shards each sleep 1000ms. We abort once the fanout is
  // demonstrably live, so all live shards are SIGTERMed and their runNode returns
  // 'canceled'. The task short-circuits to 'canceled', but the fanout maps the
  // canceled shards → kind:'failed' → markWrapperTerminal('failed').
  test('aborting mid-fanout leaves task=canceled but wrapper row must NOT be failed', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const def = fanoutDef()
    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md\nc.md' })

    const controller = new AbortController()
    // The abort is **condition-based, not wall-clock**. It used to be a flat
    // `setTimeout(..., 200)`, which went red on a loaded CI runner (macOS shard
    // 4/4 of run 34111036055): task startup outran the 200ms budget, the abort
    // landed *before* the 'fan' row was ever inserted, and the headline assertion
    // read `undefined`. That is a perfectly correct product outcome — a node
    // aborted before it starts leaves no run row behind — but it is **not** the
    // defect this file locks, which surfaces as 'failed'. So a wall-clock abort
    // could silently retarget the test onto a path that can never observe the
    // regression. Waiting for the precondition (wrapper row present + a shard
    // actually running) keeps it on the intended path at any machine speed; the
    // 1000ms shard sleep still leaves ample margin after that point.
    let abortFailure: unknown
    const abortOnceFanoutIsLive = (async () => {
      const deadline = Date.now() + 20_000
      for (;;) {
        const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
        const wrapperStarted = rows.some((row) => row.nodeId === 'fan')
        const shardRunning = rows.some((row) => row.nodeId === 'inner' && row.status === 'running')
        if (wrapperStarted && shardRunning) break
        if (Date.now() > deadline) {
          throw new Error(
            `fanout never reached a running shard; rows=${JSON.stringify(
              rows.map((row) => [row.nodeId, row.status]),
            )}`,
          )
        }
        await new Promise((done) => setTimeout(done, 10))
      }
      controller.abort()
    })().catch((error: unknown) => {
      // Abort anyway so runTask cannot outlive the test, and re-raise below.
      abortFailure = error
      controller.abort()
    })

    await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '1000',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'ok' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          signal: controller.signal,
        }),
    )
    await abortOnceFanoutIsLive
    if (abortFailure !== undefined) throw abortFailure

    // Sanity: the task itself ends 'canceled' via the signal short-circuit.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('canceled')

    // Headline RED assertion: the wrapper-fanout node_run row (nodeId='fan')
    // must reflect the cancel, NOT 'failed'. Today dispatchFanoutShard maps the
    // canceled shards to kind:'failed' and markWrapperTerminal stamps 'failed'.
    const fanRow = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'fan')))
    )[0]
    expect(fanRow?.status).toBe('canceled')
  }, 30_000)
})
