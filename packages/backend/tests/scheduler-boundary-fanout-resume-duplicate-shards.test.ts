import { rimrafDir } from './helpers/cleanup'
// Regression: wrapper-fanout RESUME re-mints all shard children (no idempotency).
//
// DEFECT (HIGH): on resume, runFanoutWrapperNode reuses the wrapper row (via
// findResumableWrapperRun, scheduler.ts:2337-2354) but the per-shard dispatch
// loop (scheduler.ts:2495-2512) maps over EVERY shard and unconditionally calls
// dispatchFanoutShard, which mints a brand-new node_run row for each shard with
// NO skip for an already-present (taskId, nodeId, parentNodeRunId, shardKey)
// child (scheduler.ts:2674-2685). Unlike wrapper-loop (which resumes by
// iteration), there is no shard-resume idempotency. A half-finished prior run
// that left stale shard children therefore ends up with TWO rows per shardKey
// after resume (the stale one + the freshly re-minted one).
//
// Downstream consequence: dispatchFanoutAggregator reads inner rows by
// (taskId, nodeId, parentNodeRunId) with NO orderBy and then does
// innerRows.find((r) => r.shardKey === s.shardKey) (scheduler.ts:2854-2868).
// `find` returns the FIRST match in DB row order — which here is the OLDER
// stale child (it was inserted first, smaller ulid). That stale child carries
// NO nodeRunOutputs, so the aggregator silently drops the fresh worker output
// and aggregates empty/stale content.
//
// CORRECT post-fix behavior: resume must be shard-idempotent — each shardKey
// must end up with EXACTLY ONE inner node_run row under the wrapper. The fix is
// shard-resume idempotency (skip/reuse already-present shard children, mirroring
// wrapper-loop's per-iteration resume) plus an ordered/done-only aggregator read
// so it never picks a stale empty child.
//
// RED until scheduler.ts makes fanout shard dispatch idempotent on resume.
// Today each shardKey owns 2 rows (stale interrupted + re-minted) so the
// per-shardKey row count is 2, not 1 → the headline assertion FAILS.

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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-red-fanout-resume-dup-'))
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

describe('wrapper-fanout resume — shard children must be idempotent (no duplicate rows per shardKey)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('resume of a half-done fanout does NOT re-mint already-present shard children', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    await seedAgent(h.db, 'agg', ['result'], {
      role: 'aggregator',
      outputWrapperPortNames: { result: 'final' },
    })

    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner', 'aggNode'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        {
          id: 'inner',
          kind: 'agent-single',
          agentName: 'worker',
          promptTemplate: 'Process {{doc}}',
        },
        {
          id: 'aggNode',
          kind: 'agent-single',
          agentName: 'agg',
          promptTemplate: 'Merge {{items}}',
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
        {
          id: 'eAgg',
          source: { nodeId: 'inner', portName: 'result' },
          target: { nodeId: 'aggNode', portName: 'items' },
        },
      ],
    }

    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md' })

    // Simulate a half-done prior run that got reaped (e.g. daemon restart):
    // the wrapper row survives as 'pending' (so the resume transition
    // pending->running is legal — this isolates the bug from the separate
    // interrupted-resume THROW path) and two STALE shard children survive,
    // one per shardKey, with NO outputs.
    //
    // Seed the stale shard children FIRST so their ulids sort BEFORE the
    // wrapper row's id. That guarantees the aggregator's unordered
    // innerRows.find(...) would pick these stale (empty) children over the
    // freshly re-minted ones — the downstream symptom of the missing
    // idempotency.
    const staleAId = ulid()
    const staleBId = ulid()
    await h.db.insert(nodeRuns).values({
      id: staleAId,
      taskId,
      nodeId: 'inner',
      status: 'interrupted',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: null, // set below once wrapper id is known
      shardKey: 'a.md',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await h.db.insert(nodeRuns).values({
      id: staleBId,
      taskId,
      nodeId: 'inner',
      status: 'interrupted',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: null,
      shardKey: 'b.md',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })

    const wrapperRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: wrapperRunId,
      taskId,
      nodeId: 'fan',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: null,
      shardKey: null,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })

    // Re-parent the stale children to the wrapper row (now that we have its id).
    await h.db
      .update(nodeRuns)
      .set({ parentNodeRunId: wrapperRunId })
      .where(eq(nodeRuns.id, staleAId))
    await h.db
      .update(nodeRuns)
      .set({ parentNodeRunId: wrapperRunId })
      .where(eq(nodeRuns.id, staleBId))

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'fresh' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // The wrapper row should have been reused (resume), not duplicated.
    const wrapperRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRows.length).toBe(1)
    expect(wrapperRows[0]?.id).toBe(wrapperRunId)

    // Collect every inner shard row that hangs off THIS wrapper row, grouped
    // by shardKey.
    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === wrapperRunId)
    const byKey = new Map<string, number>()
    for (const r of innerRows) {
      const k = r.shardKey ?? '__null__'
      byKey.set(k, (byKey.get(k) ?? 0) + 1)
    }

    // HEADLINE: each shardKey must own EXACTLY ONE inner node_run row after
    // resume. Today the resume re-mints every shard unconditionally, so each
    // key has 2 rows (the pre-seeded stale 'interrupted' child + the freshly
    // re-minted one) → these assertions FAIL until fanout resume becomes
    // shard-idempotent.
    expect(byKey.get('a.md')).toBe(1)
    expect(byKey.get('b.md')).toBe(1)
  })
})
