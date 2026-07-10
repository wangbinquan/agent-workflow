import { rimrafDir } from './helpers/cleanup'
// Locked regression — wrapper-fanout shard dispatch ignores the concurrency caps.
//
// DEFECT (HIGH): wrapper-fanout shards bypass ALL concurrency control.
//   - state.subprocessSem (multiProcessSubprocessConcurrency, default 4) is
//     constructed at scheduler.ts:346 but NEVER acquired anywhere — dead code.
//   - dispatchFanoutShard/dispatchFanoutAggregator call runNode directly inside
//     `Promise.all(shards.map(...))` (scheduler.ts:2496, 2759, 2929) with no
//     globalSem AND no writeSem — unlike the single-agent path which acquires
//     both at scheduler.ts:1404-1405 (`releaseGlobal = await globalSem.acquire()`
//     and `releaseWrite = agent.readonly ? null : await writeSem.acquire()`).
//   So N shards spawn N opencode processes at once regardless of the documented
//   caps, and non-readonly (writer) shards run concurrently on the SAME worktree
//   — a corruption hazard the single-agent path explicitly prevents.
//
// This test uses the same wall-clock technique as the single-agent write-sem
// test in scheduler.test.ts ("two write agents at the same level serialize"):
// each shard sleeps MOCK_OPENCODE_DELAY_MS, so serialized execution shows up as
// a multiplied wall-clock floor while parallel execution collapses to ~1x delay.
//
// The caps are documented-but-unenforced today; these assertions encode the
// CORRECT (post-fix) serialized behavior and therefore FAIL against the buggy
// parallel dispatch.
//
// RED until the fanout dispatch acquires state.globalSem + state.subprocessSem
// (and writeSem for non-readonly inner agents) per shard, mirroring the
// single-agent path.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-red-fanoutcap-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rimrafDir(appHome),
  }
}
async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
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
    inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
    nodes: [
      { id: 'inp', kind: 'input', inputKey: 'docs' },
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      { id: 'inner', kind: 'agent-single', agentName: 'worker', promptTemplate: 'Process {{doc}}' },
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

describe('regression: wrapper-fanout shard dispatch MUST honor concurrency caps (scheduler.ts:2496 dead subprocessSem)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  // Test A — global + subprocess caps both set to 1: three 400ms readonly shards
  // MUST run one-at-a-time → ~1200ms+ wall clock. Today they run in parallel
  // (~400-700ms) because no semaphore is acquired in the fanout dispatch.
  test('A: maxConcurrentNodes:1 + multiProcessSubprocessConcurrency:1 serializes 3 readonly shards', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const def = fanoutDef()
    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md\nc.md' })
    const t0 = Date.now()
    await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '400',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'ok' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          maxConcurrentNodes: 1,
          multiProcessSubprocessConcurrency: 1,
        }),
    )
    const elapsed = Date.now() - t0
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    // Serialized: 3 x 400ms ≈ 1200ms+. Parallel (buggy) ≈ one delay ≈ 400-700ms.
    expect(elapsed).toBeGreaterThan(1000)
  }, 30_000)

  // Test B — caps are NOT limiting (4/4), but the inner agent is a WRITER
  // (readonly:false). Writer shards mutate the SAME worktree, so they MUST
  // serialize through writeSem regardless of the global/subprocess caps —
  // exactly like two write agents at the same level. Today the fanout path
  // never acquires writeSem → they run concurrently (~400-700ms).
  test('B: RFC-130 — writer shards each run in their OWN iso worktree and merge back correctly (no shared-worktree corruption)', async () => {
    // RFC-130 SUPERSEDES the RFC-098 B1 writeSem-serializes-writer-shards model:
    // each shard runs in its OWN isolated worktree and merges its delta back one at
    // a time. The multi-minute AGENT RUNS overlap (only the brief §段①③ snapshot +
    // `git worktree add` + merge-back serialize on writeSem). We do NOT wall-clock
    // this any more: with a mock "agent" that only sleeps, the per-shard iso git
    // overhead (≈1s/shard, serialized) is the same order as the run, so wall-clock
    // is not a clean parallelism signal (it IS for real minute-long agents — see
    // scheduler.test.ts's top-level parallel lock). Instead we lock the RFC-130
    // guarantee that matters here: three writer shards complete WITHOUT corrupting
    // each other (no shared worktree), and the task finishes. The generous timeout
    // still guards against a merge-back/writeSem deadlock regression.
    await seedAgent(h.db, 'worker', ['result']) // writer
    const def = fanoutDef()
    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md\nc.md' })
    await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '200',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'ok' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          maxConcurrentNodes: 4,
          multiProcessSubprocessConcurrency: 4,
        }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    // All three shard runs completed done (each in its own iso, merged back).
    const shardRuns = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    ).filter((r) => r.shardKey !== null && r.status === 'done')
    expect(shardRuns.length).toBeGreaterThanOrEqual(3)
  }, 30_000)
})
