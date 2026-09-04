// RFC-354 — wrapper nesting at DEPTH 3: `loop ⊃ git ⊃ loop ⊃ agent`.
//
// Why this file exists: RFC-354 claims wrappers nest to ANY depth ("嵌套即递归",
// docs/workflow-yaml.md §wrapper-loop), but until this test the only *executed*
// nesting anywhere in the repo was two levels deep —
// `rfc354-nested-loop-frames.test.ts` (loop ⊃ loop),
// `scheduler-audit-s04-git-wrapper-cumulative-diff.test.ts` S-4b (loop ⊃ git),
// and the e2e catalog's five depth-2 combinations. Depth 3 existed only as a
// STATIC claim (`rfc354-validator-node-semantics.test.ts` "three levels"), which
// proves the validator lets it through and nothing about what then runs.
//
// Three things only depth 3 can show, all asserted below:
//   ① the frame CHAIN is transitive — a run's `scope_path` is the full
//     root→here breadcrumb (`oloop:1/gitw:0/iloop:0`), and every level's
//     `container_run_id` points at its own parent generation row, not at the
//     nearest loop;
//   ② a CLOSURE resolves across three wrapper boundaries at once — the single
//     top-scope `seed` run is what all four innermost runs consumed
//     (environmentChain walks out one generation at a time; a depth-1 or
//     "nearest enclosing loop" shortcut would fail to bind here);
//   ③ the per-round git diff subtraction (RFC-098 B3 / audit S-4) still holds
//     when the git wrapper is itself a loop body AND contains a loop: outer
//     round 2's diff carries only round 2's files, even though round 1's four
//     files are still sitting uncommitted in the worktree.
//
// Counting: the agent runs `outer 2 × inner 2 = 4` times. Both oracles are
// asserted — process truth (scenario-opencode's trace.jsonl, one line per real
// spawn) and the row axis (node_runs) — because a row-only count cannot tell
// "the inner scope re-executed" from "the same rows were reused", which is
// exactly the S-6 defect frames were introduced to kill.
//
// Deterministic: local git init/commit only (no network, no stash), serial
// dispatch, no sleeps or polling; temp dirs cleaned in afterEach.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'
import { canonicalizeWorkflowAgentIds } from './helpers/canonicalWorkflowFixture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_OPENCODE = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  worktreePath: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc354-depth3-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  const stateDir = join(appHome, 'scenario-state')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  // Local-only git fixture (the git wrapper needs a real repo): init + one commit.
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'base.txt'), 'baseline\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    repoPath,
    worktreePath,
    stateDir,
    planFile: join(appHome, 'plan.json'),
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
    name: 'rfc354-depth3-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(canonicalDefinition),
    repoPath: h.repoPath,
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
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { agent: string; callIndex: number })
}

function consumedOf(row: { consumedUpstreamRunsJson: string | null }): Record<string, string> {
  return row.consumedUpstreamRunsJson === null
    ? {}
    : (JSON.parse(row.consumedUpstreamRunsJson) as Record<string, string>)
}

describe('RFC-354 — depth 3: loop ⊃ git ⊃ loop ⊃ agent', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('every level opens its own generation: 4 agent runs, three-segment scope paths, one closure across three boundaries, per-round diffs', async () => {
    await seedAgent(h.db, 'seed', ['findings'])
    await seedAgent(h.db, 'worker', ['status'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'seed', kind: 'agent-single', agentName: 'seed' },
        { id: 'worker', kind: 'agent-single', agentName: 'worker' },
        {
          id: 'iloop',
          kind: 'wrapper-loop',
          nodeIds: ['worker'],
          maxIterations: 2,
          // The worker alternates GO / STOP, so the inner loop exits on its
          // round 1 — in EVERY generation, if it actually re-executes.
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'worker',
            portName: 'status',
            value: 'STOP',
          },
          outputBindings: [{ name: 'verdict', bind: { nodeId: 'worker', portName: 'status' } }],
        },
        { id: 'gitw', kind: 'wrapper-git', nodeIds: ['iloop'] },
        {
          id: 'oloop',
          kind: 'wrapper-loop',
          nodeIds: ['gitw'],
          maxIterations: 2,
          // Never satisfied; `continueOnMaxIterations` turns the ceiling into a
          // normal completion instead of `exhausted`, so the task ends `done`
          // and the assertions below read a fully settled topology. The exit
          // condition reads a DIRECT member (`gitw`) — `iloop` sits behind the
          // git wrapper's boundary and is not lexically visible here.
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'gitw',
            portName: 'git_diff',
            value: '__NEVER__',
          },
          continueOnMaxIterations: true,
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        // Closure across THREE boundaries (oloop, gitw, iloop): the innermost
        // agent reads a top-scope producer.
        {
          id: 'e-closure',
          source: { nodeId: 'seed', portName: 'findings' },
          target: { nodeId: 'worker', portName: 'in' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)

    // Per-call plan: GO, STOP, GO, STOP — the same cadence in both outer
    // rounds, so the topology terminates identically whether or not the inner
    // scope re-executes; only the call COUNT and the frames differ. Each call
    // leaves one uncommitted file named after the round it belongs to.
    writeFileSync(
      h.planFile,
      JSON.stringify({
        seed: [{ output: { findings: 'SEED' } }],
        worker: [
          { output: { status: 'GO' }, writeFiles: { 'nested/r0-i0.txt': 'r0-i0\n' } },
          { output: { status: 'STOP' }, writeFiles: { 'nested/r0-i1.txt': 'r0-i1\n' } },
          { output: { status: 'GO' }, writeFiles: { 'nested/r1-i0.txt': 'r1-i0\n' } },
          { output: { status: 'STOP' }, writeFiles: { 'nested/r1-i1.txt': 'r1-i1\n' } },
        ],
      }),
    )

    await withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        binaryOverride: ['bun', 'run', SCENARIO_OPENCODE],
      }),
    )

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('done')

    const rowsOf = (nodeId: string) =>
      h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))

    // Oracle #1 (process truth): outer 2 × inner 2 = 4 real spawns, and the
    // top-scope producer ran exactly once for the whole task.
    const trace = readTrace(h)
    expect(trace.filter((line) => line.agent === 'worker').length).toBe(4)
    expect(trace.filter((line) => line.agent === 'seed').length).toBe(1)

    // Level 0 — the outer loop is a top-scope row.
    const oloopRuns = await rowsOf('oloop')
    expect(oloopRuns.length).toBe(1)
    const oloop = oloopRuns[0]!
    expect(oloop.status).toBe('done')
    expect(oloop.containerRunId).toBeNull()
    expect(oloop.scopePath).toBe('')

    // Level 1 — one git generation per outer round, hanging off the outer row.
    const gitRuns = await rowsOf('gitw')
    expect(gitRuns.length).toBe(2)
    expect(gitRuns.every((row) => row.status === 'done')).toBe(true)
    expect(gitRuns.every((row) => row.containerRunId === oloop.id)).toBe(true)
    expect(new Set(gitRuns.map((row) => row.iteration))).toEqual(new Set([0, 1]))
    expect(new Set(gitRuns.map((row) => row.scopePath))).toEqual(new Set(['oloop:0', 'oloop:1']))

    // Level 2 — one inner-loop generation per git generation. A git wrapper is
    // transparent to the iteration axis: it never opens rounds of its own, so a
    // row inside it keeps the round of the loop it is nested in (the inner loop
    // of outer round 1 is `gitw:1`, not `gitw:0`). What separates the two inner
    // generations is therefore the generation ROW, never the counter — which is
    // the whole point of the frame.
    const innerRuns = await rowsOf('iloop')
    expect(innerRuns.length).toBe(2)
    expect(innerRuns.every((row) => row.status === 'done')).toBe(true)
    expect(new Set(innerRuns.map((row) => row.containerRunId))).toEqual(
      new Set(gitRuns.map((row) => row.id)),
    )
    for (const inner of innerRuns) {
      const container = gitRuns.find((row) => row.id === inner.containerRunId)!
      expect(inner.iteration).toBe(container.iteration)
    }
    expect(new Set(innerRuns.map((row) => row.scopePath))).toEqual(
      new Set(['oloop:0/gitw:0', 'oloop:1/gitw:1']),
    )

    // Level 3 — the agent: two rounds inside each inner generation, breadcrumbed
    // root→here through all three wrappers.
    const workerRuns = await rowsOf('worker')
    expect(workerRuns.length).toBe(4)
    expect(workerRuns.every((row) => row.status === 'done')).toBe(true)
    for (const generation of innerRuns) {
      const inGeneration = workerRuns.filter((row) => row.containerRunId === generation.id)
      expect(inGeneration.map((row) => row.iteration).sort()).toEqual([0, 1])
    }
    expect(new Set(workerRuns.map((row) => row.scopePath))).toEqual(
      new Set([
        'oloop:0/gitw:0/iloop:0',
        'oloop:0/gitw:0/iloop:1',
        'oloop:1/gitw:1/iloop:0',
        'oloop:1/gitw:1/iloop:1',
      ]),
    )
    // …and the four frames are all distinct (the bare counter alone is not).
    expect(new Set(workerRuns.map((row) => `${row.containerRunId}#${row.iteration}`)).size).toBe(4)

    // Oracle #2 (closure across three boundaries): the ONE top-scope seed run is
    // what every innermost run consumed — in both outer rounds.
    const seedRuns = await rowsOf('seed')
    expect(seedRuns.length).toBe(1)
    expect(new Set(workerRuns.map((row) => consumedOf(row).seed))).toEqual(
      new Set([seedRuns[0]!.id]),
    )

    // Oracle #3 (per-round diff at depth 3): each git generation reports only
    // the files ITS round produced, even though round 0's two files are still
    // uncommitted when round 1 captures its baseline.
    const diffPaths = async (runId: string): Promise<string[]> => {
      const rows = await h.db
        .select()
        .from(nodeRunOutputs)
        .where(and(eq(nodeRunOutputs.nodeRunId, runId), eq(nodeRunOutputs.portName, 'git_diff')))
      return (rows[0]?.content ?? '')
        .split('\n')
        .filter((path) => path.length > 0)
        .sort()
    }
    const round0 = gitRuns.find((row) => row.iteration === 0)!
    const round1 = gitRuns.find((row) => row.iteration === 1)!
    expect(await diffPaths(round0.id)).toEqual(['nested/r0-i0.txt', 'nested/r0-i1.txt'])
    expect(await diffPaths(round1.id)).toEqual(['nested/r1-i0.txt', 'nested/r1-i1.txt'])
  }, 40000)
})
