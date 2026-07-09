import { rimrafDir } from './helpers/cleanup'
// LOCKS: RFC-096 (audit S-13 / 附录 C #5, design §3.3) — readPortAtIteration
// reads DONE rows only.
//
// readPortAtIteration (scheduler.ts, not exported) is the single read point
// for wrapper-loop exit-condition evaluation AND wrapper outputBindings.
// Before RFC-096 it picked the freshest TOP-LEVEL row of (node, iteration) by
// pure id with NO status filter (verified against HEAD): a freshly minted
// non-done row in the same iteration — e.g. a concurrent designer-rerun
// `pending` row landing in the window between the inner scope settling and
// the exit-condition read — was picked as freshest, had no node_run_outputs
// (the runner only persists ports on done), and the read returned ''. Two
// observable failures, one per consumer site:
//   1. exit check (scheduler.ts:2439): a `port-empty` condition false-fired
//      → the loop exited 'done' on iteration 0 regardless of real content;
//   2. output bindings (scheduler.ts:2442): the wrapper persisted '' outputs,
//      clobbering real upstream content.
// The fix adds statusIn:['done'] (pickFreshestRun), aligning the read with
// buildFreshestDonePerNode / the RFC-074 freshness口径. Non-done rows never
// have outputs, so skipping them can only surface the newest REAL content.
//
// Test shape (behavioral — the helper is private, so we drive the real chain
// runTask → runLoopWrapperNode → readPortAtIteration → evaluateExitCondition
// against a real in-memory DB):
//   The pathological row pair (done row WITH output + younger pending row
//   WITHOUT) is seeded on a cond-source node id that appears in NO dispatch
//   scope ("ghost"). Why: scheduler-audit-gap4-loop-exit-out-of-scope-port
//   .test.ts locks that runTask only schema-parses the snapshot and resolves
//   exit-condition refs purely through readPortAtIteration (a node-agnostic
//   (taskId, nodeId, iteration) DB query — scope membership never reaches the
//   picker). Hosting the pre-seeded orphan pending row on an in-scope node is
//   NOT deterministically possible instead: RFC-095's frontier would release
//   it once as a pending anchor, re-run the node, and then surface the
//   still-latest pending row as blocked('pending-anchor-consumed') → the
//   scope fails 'scheduler stalled' BEFORE any exit check runs. In production
//   the row lands inside the settle→read window via an out-of-band rerun mint
//   (the unified dispatch minting a cross-clarify designer rerun), an
//   interleaving a deterministic test cannot reproduce without runtime hooks.
//
// Red-before-fix proof (assertion semantics, since the fix is already in the
// working tree): the seeded pending id starts with 'nr_' — lowercase 'n'
// (0x6E) sorts above every Crockford-ULID char ('Z' = 0x5A), so it is
// PROVABLY the freshest top-level row of the iteration whenever the old
// picker runs, and it provably has zero node_run_outputs rows → the old read
// returned '' deterministically. Test 1 then exits at iteration 0 with
// final='w0' / worker iterations [0]; test 2 persists final=''. Both flip.
//
// Control (no pending interference → unchanged behavior) is NOT duplicated
// here — existing suites already cover it: exit-condition.test.ts (pure
// evaluator), scheduler-audit-gap4-loop-exit-out-of-scope-port.test.ts
// (loop + real readPortAtIteration reads, including the "no rows at all → ''"
// path that test 1's own iteration-1 exit re-traverses below).
//
// Orphan non-goal (design §3.3): the skipped pending row stays untouched —
// asserted explicitly so the consumption question stays visibly parked with
// RFC-096 rather than silently absorbed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_OPENCODE = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

// Lowercase 'n' > 'Z' ⇒ above every ULID the scheduler will ever mint, so the
// pending row stays the freshest top-level row of its iteration for the whole
// run (the precondition of the old picker's failure).
const PENDING_RERUN_ID = 'nr_zz_rfc096_pending_rerun_window'

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc096-portread-'))
  const worktreePath = join(appHome, 'wt')
  const stateDir = join(appHome, 'scenario-state')
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    stateDir,
    planFile: join(appHome, 'plan.json'),
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
}

async function seedWorkflowAndTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf-rfc096-portread',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await h.db.insert(tasks).values({
    name: 't-rfc096-portread',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

/** done row WITH a port value + younger pending row WITHOUT outputs, same iteration. */
async function seedGhostPair(
  h: Harness,
  taskId: string,
  nodeId: string,
  portName: string,
  content: string,
): Promise<void> {
  const doneId = ulid()
  await h.db.insert(nodeRuns).values({
    id: doneId,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 100,
    finishedAt: Date.now() - 50,
  })
  await h.db.insert(nodeRunOutputs).values({ nodeRunId: doneId, portName, content })
  // The concurrent-rerun-window mint: no startedAt (rerun mints never write
  // it — the very pathology RFC-096 §3.1 fixed elsewhere), no outputs.
  await h.db.insert(nodeRuns).values({
    id: PENDING_RERUN_ID,
    taskId,
    nodeId,
    status: 'pending',
    retryIndex: 1,
    iteration: 0,
  })
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

async function runSeededTask(h: Harness, taskId: string): Promise<void> {
  await withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
    runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
    }),
  )
}

async function loopOutput(
  h: Harness,
  loopRunId: string,
  port: string,
): Promise<string | undefined> {
  const rows = await h.db
    .select()
    .from(nodeRunOutputs)
    .where(and(eq(nodeRunOutputs.nodeRunId, loopRunId), eq(nodeRunOutputs.portName, port)))
  return rows[0]?.content
}

describe('RFC-096 §3.3 — readPortAtIteration done-only (loop exit + output bindings)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('exit surface: port-empty cond source has done("keep-looping") + younger pending row → loop does NOT false-exit at iteration 0 (red before fix)', async () => {
    // worker emits a distinct port value per iteration so `final` pins WHICH
    // iteration the loop exited on, not just that it exited.
    writeFileSync(
      h.planFile,
      JSON.stringify({ worker: [{ output: { out: 'w0' } }, { output: { out: 'w1' } }] }),
    )
    await seedAgent(h.db, 'worker', ['out'])
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'worker', kind: 'agent-single', agentName: 'worker' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['worker'],
          maxIterations: 3,
          exitCondition: { kind: 'port-empty', nodeId: 'ghost_flag', portName: 'signal' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'worker', portName: 'out' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const taskId = await seedWorkflowAndTask(h, definition)
    await seedGhostPair(h, taskId, 'ghost_flag', 'signal', 'keep-looping')

    await runSeededTask(h, taskId)

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(`${t?.status}:${t?.errorSummary ?? ''}`).toBe('done:')

    // Iteration 0's exit check must read the DONE row ('keep-looping' →
    // non-empty → continue), NOT the younger pending row ('' → false exit).
    // Iteration 1 then reads ghost_flag@1 — no rows → '' → port-empty fires
    // (the gap4-locked out-of-scope/no-row semantics, doubling as the in-file
    // control that done-only did not change the no-row path).
    // Red before fix: iterations [0] and final 'w0'.
    const workerRuns = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    ).filter((r) => r.nodeId === 'worker')
    expect(workerRuns.map((r) => r.iteration).sort()).toEqual([0, 1])

    const loopRun = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.nodeId === 'loop',
    )
    expect(loopRun?.status).toBe('done')
    expect(await loopOutput(h, loopRun!.id, 'final')).toBe('w1')

    // Orphan non-goal (design §3.3): the skipped pending row is left exactly
    // as minted — no consumption, no status flip.
    const orphan = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, PENDING_RERUN_ID)))[0]
    expect(orphan?.status).toBe('pending')
  })

  test('output-binding surface: bound port with done("real-content") + younger pending row → wrapper output is NOT clobbered to "" (red before fix)', async () => {
    writeFileSync(h.planFile, JSON.stringify({ worker: [{ output: { out: 'w0' } }] }))
    await seedAgent(h.db, 'worker', ['out'])
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'worker', kind: 'agent-single', agentName: 'worker' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['worker'],
          maxIterations: 2,
          // ghost_absent has ZERO rows → reads '' → port-empty fires on
          // iteration 0 (gap4-locked no-row semantics): the loop exits
          // immediately and persists its outputBindings — the surface under
          // test.
          exitCondition: { kind: 'port-empty', nodeId: 'ghost_absent', portName: 'nothing' },
          outputBindings: [
            { name: 'final', bind: { nodeId: 'ghost_src', portName: 'signal' } },
            { name: 'wout', bind: { nodeId: 'worker', portName: 'out' } },
          ],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const taskId = await seedWorkflowAndTask(h, definition)
    await seedGhostPair(h, taskId, 'ghost_src', 'signal', 'real-content')

    await runSeededTask(h, taskId)

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(`${t?.status}:${t?.errorSummary ?? ''}`).toBe('done:')

    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const workerRuns = rows.filter((r) => r.nodeId === 'worker')
    expect(workerRuns.map((r) => r.iteration)).toEqual([0]) // exited on iteration 0
    const loopRun = rows.find((r) => r.nodeId === 'loop')
    expect(loopRun?.status).toBe('done')

    // Red before fix: '' (the younger pending row won the pick and had no
    // outputs). Green: the DONE row's real content.
    expect(await loopOutput(h, loopRun!.id, 'final')).toBe('real-content')
    expect(await loopOutput(h, loopRun!.id, 'wout')).toBe('w0')

    const orphan = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, PENDING_RERUN_ID)))[0]
    expect(orphan?.status).toBe('pending')
  })
})
