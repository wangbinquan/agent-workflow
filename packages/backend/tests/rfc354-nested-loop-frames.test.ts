// RFC-354 — loop-in-loop re-executes the inner scope on EVERY outer round.
//
// This file was the audit S-6 current-behavior lock
// (`scheduler-audit-s06-nested-loop-inner-noop.test.ts`): before frames, the
// inner wrapper-loop drove its body with `runScope({iteration: i})` and
// node_runs had no parent-scope axis, so outer round 2 re-entered the inner
// scope, hit round 1's done rows keyed by the same (nodeId, iteration) and
// dispatched NOTHING — the inner agent ran 2 times where the topology
// (outer 2 rounds × inner 2 rounds) promises 4, and the inner loop's exit
// condition / bindings silently re-read round 1's outputs.
//
// RFC-354 gives every row a frame — `(container_run_id, iteration)`: the
// generation row of the wrapper it belongs to plus the round INSIDE it. The
// outer loop's round 2 opens a fresh inner generation, the inner body rows
// hang off that generation and the frontier only ever looks at rows of the
// frame it dispatches in. Every assertion below is the [FLIP-ON-FIX] value
// the lock announced, plus the frame bookkeeping that makes it hold.
//
// Counting: scenario-opencode.ts appends one trace line per real spawn
// (fixtures/scenario-opencode.ts), so the call count is process truth and does
// not depend on node_runs row reuse. Deterministic: single agent, serial
// dispatch; no sleep / polling / network; temp dirs cleaned in afterEach.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'
import { canonicalizeWorkflowAgentIds } from './helpers/canonicalWorkflowFixture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_OPENCODE = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc354-nested-'))
  const worktreePath = join(appHome, 'wt')
  const stateDir = join(appHome, 'scenario-state')
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const planFile = join(appHome, 'plan.json')
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    stateDir,
    planFile,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
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

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
): Promise<{ taskId: string }> {
  const canonicalDefinition = await canonicalizeWorkflowAgentIds(h.db, definition)
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(canonicalDefinition),
  })
  await h.db.insert(tasks).values({
    name: 'rfc354-nested-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(canonicalDefinition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId }
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

function readTrace(h: Harness): Array<{ agent: string; callIndex: number }> {
  const tracePath = join(h.stateDir, 'trace.jsonl')
  if (!existsSync(tracePath)) return []
  return readFileSync(tracePath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { agent: string; callIndex: number })
}

describe('RFC-354 — loop-in-loop: the inner scope re-executes on every outer round (frames)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('outer loop(max 2) ∋ inner loop(max 2) ∋ agent: the agent really runs 4 times, one frame per outer×inner round', async () => {
    await seedAgent(h.db, 'worker', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'worker', kind: 'agent-single', agentName: 'worker' },
        {
          id: 'iloop',
          kind: 'wrapper-loop',
          nodeIds: ['worker'],
          maxIterations: 2,
          // worker plan alternates GO/STOP per call → inner exits exactly
          // at its iteration 1 each round (if it actually ran).
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'worker',
            portName: 'findings',
            value: 'STOP',
          },
          outputBindings: [{ name: 'final', bind: { nodeId: 'worker', portName: 'findings' } }],
        },
        {
          id: 'oloop',
          kind: 'wrapper-loop',
          nodeIds: ['iloop'],
          maxIterations: 2,
          // Never satisfied → outer runs its full 2 rounds, then exhausts.
          // That forces a SECOND entry into the inner loop, which is where
          // the no-op replay manifests.
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'iloop',
            portName: 'final',
            value: '__NEVER__',
          },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)

    // Per-call plan: GO, STOP, GO, STOP. If the fix lands and the inner
    // loop truly re-executes on outer round 2, calls 2/3 reproduce the
    // same GO→STOP cadence so the topology still terminates identically
    // (outer exhausts either way) — only the call COUNT flips 2 → 4.
    writeFileSync(
      h.planFile,
      JSON.stringify({
        worker: [
          { output: { findings: 'GO' } },
          { output: { findings: 'STOP' } },
          { output: { findings: 'GO' } },
          { output: { findings: 'STOP' } },
        ],
      }),
    )

    await withEnv(
      {
        SCENARIO_PLAN_FILE: h.planFile,
        SCENARIO_STATE_DIR: h.stateDir,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', SCENARIO_OPENCODE],
        }),
    )

    // The outer loop legitimately exhausts (its exit condition is never
    // satisfied) — this anchors that the nested topology was driven to
    // completion rather than rejected up front (runTask runs no validator).
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorMessage).toContain('wrapper-loop-exhausted')
    const oloopRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'oloop')))
    expect(oloopRuns.length).toBe(1)
    const oloop = oloopRuns[0]!
    expect(oloop.status).toBe('exhausted')
    // The outer generation row lives at the top scope.
    expect(oloop.containerRunId).toBeNull()
    expect(oloop.scopePath).toBe('')

    // One inner GENERATION per outer round, each hanging off the outer
    // generation row with its round as the frame iteration.
    const iloopRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'iloop')))
    expect(iloopRuns.length).toBe(2)
    expect(new Set(iloopRuns.map((r) => r.iteration))).toEqual(new Set([0, 1]))
    expect(iloopRuns.every((r) => r.status === 'done')).toBe(true)
    expect(iloopRuns.every((r) => r.containerRunId === oloop.id)).toBe(true)
    expect(new Set(iloopRuns.map((r) => r.scopePath))).toEqual(new Set(['oloop:0', 'oloop:1']))

    // Oracle #1 (process truth): 2 outer rounds × 2 inner iterations = 4 spawns.
    const workerTrace = readTrace(h).filter((l) => l.agent === 'worker')
    expect(workerTrace.length).toBe(4)

    // Oracle #2 (row axis): 4 distinct worker rows — for EACH inner generation
    // exactly its two rounds, breadcrumbed root→here.
    const workerRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'worker')))
    expect(workerRuns.length).toBe(4)
    expect(workerRuns.every((r) => r.status === 'done')).toBe(true)
    for (const gen of iloopRuns) {
      const inGen = workerRuns.filter((r) => r.containerRunId === gen.id)
      expect(inGen.map((r) => r.iteration).sort()).toEqual([0, 1])
      expect(new Set(inGen.map((r) => r.scopePath))).toEqual(
        new Set([`oloop:${gen.iteration}/iloop:0`, `oloop:${gen.iteration}/iloop:1`]),
      )
    }

    // Oracle #3 (no stale read-through): round 2's inner loop settled its
    // exit condition and bindings against ITS OWN worker runs. The plan repeats
    // GO→STOP for calls 3/4, so round 2 ends with final='STOP' again — what
    // proves the read was fresh is the time axis: both round-2 worker runs
    // started at/after the round-2 generation row was minted.
    const iloopRound2 = iloopRuns.find((r) => r.iteration === 1)!
    const round2Final = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(
        and(eq(nodeRunOutputs.nodeRunId, iloopRound2.id), eq(nodeRunOutputs.portName, 'final')),
      )
    expect(round2Final[0]?.content).toBe('STOP')
    const round2Start = iloopRound2.startedAt
    expect(round2Start).not.toBeNull()
    expect(workerRuns.every((r) => r.startedAt !== null)).toBe(true)
    const round2Workers = workerRuns.filter((r) => r.containerRunId === iloopRound2.id)
    expect(round2Workers.length).toBe(2)
    expect(round2Workers.every((r) => (r.startedAt ?? 0) >= round2Start!)).toBe(true)
  }, 20000)
})
