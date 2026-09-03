// RFC-354 — closure / parameter / local semantics across nested wrapper frames,
// driven through the real scheduler (design §4 "输入边就是参数、输出边就是返回值、
// 穿墙边是闭包").
//
//   seed (top scope) ──findings──▶ worker (oloop ∋ iloop ∋ worker)   ← crossing edge = closure
//   worker ──findings──▶ checker (same inner scope)                   ← local edge
//
// Locks:
//   • the closure is bound once, in the frame that produced it: all FOUR worker
//     runs (2 outer × 2 inner rounds) consume the SAME top-scope seed run;
//   • a local is read in the reader's own frame: every checker run consumes the
//     worker run of ITS generation row and ITS round — never round 1's rows on
//     outer round 2 (the audit S-6 stale read-through, now impossible by
//     construction);
//   • a top-scope producer runs exactly once — re-entering the nested scopes
//     never re-dispatches what they capture.
//
// Counting uses scenario-opencode's trace.jsonl (one line per real spawn).

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc354-closure-'))
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
    name: 'rfc354-closure-task',
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

function consumedOf(row: { consumedUpstreamRunsJson: string | null }): Record<string, string> {
  return row.consumedUpstreamRunsJson === null
    ? {}
    : (JSON.parse(row.consumedUpstreamRunsJson) as Record<string, string>)
}

describe('RFC-354 — closure / local edges across nested loop frames', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('seed(top) → worker(oloop∋iloop) is bound once; worker → checker is read per frame', async () => {
    await seedAgent(h.db, 'seed', ['findings'])
    await seedAgent(h.db, 'worker', ['findings'])
    await seedAgent(h.db, 'checker', ['verdict'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'seed', kind: 'agent-single', agentName: 'seed' },
        { id: 'worker', kind: 'agent-single', agentName: 'worker' },
        { id: 'checker', kind: 'agent-single', agentName: 'checker' },
        {
          id: 'iloop',
          kind: 'wrapper-loop',
          nodeIds: ['worker', 'checker'],
          maxIterations: 2,
          // checker alternates GO/STOP → the inner loop exits on its round 1.
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'checker',
            portName: 'verdict',
            value: 'STOP',
          },
          outputBindings: [{ name: 'final', bind: { nodeId: 'checker', portName: 'verdict' } }],
        },
        {
          id: 'oloop',
          kind: 'wrapper-loop',
          nodeIds: ['iloop'],
          maxIterations: 2,
          // Never satisfied → the outer loop runs both rounds, then exhausts.
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'iloop',
            portName: 'final',
            value: '__NEVER__',
          },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e-closure',
          source: { nodeId: 'seed', portName: 'findings' },
          target: { nodeId: 'worker', portName: 'in' },
        },
        {
          id: 'e-local',
          source: { nodeId: 'worker', portName: 'findings' },
          target: { nodeId: 'checker', portName: 'in' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    writeFileSync(
      h.planFile,
      JSON.stringify({
        seed: [{ output: { findings: 'SEED' } }],
        worker: [
          { output: { findings: 'W-0' } },
          { output: { findings: 'W-1' } },
          { output: { findings: 'W-2' } },
          { output: { findings: 'W-3' } },
        ],
        checker: [
          { output: { verdict: 'GO' } },
          { output: { verdict: 'STOP' } },
          { output: { verdict: 'GO' } },
          { output: { verdict: 'STOP' } },
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

    // The nested topology ran to the outer loop's exhaustion.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorMessage).toContain('wrapper-loop-exhausted')

    // A top-scope producer runs exactly once; each nested agent 4 times.
    const trace = readTrace(h)
    expect(trace.filter((l) => l.agent === 'seed').length).toBe(1)
    expect(trace.filter((l) => l.agent === 'worker').length).toBe(4)
    expect(trace.filter((l) => l.agent === 'checker').length).toBe(4)

    const rowsOf = (nodeId: string) =>
      h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
    const seedRuns = await rowsOf('seed')
    expect(seedRuns.length).toBe(1)
    const seedRun = seedRuns[0]!
    expect(seedRun.containerRunId).toBeNull()

    // Closure: every worker run — across both outer rounds — consumed the ONE
    // top-scope seed run.
    const workerRuns = await rowsOf('worker')
    expect(workerRuns.length).toBe(4)
    expect(new Set(workerRuns.map((r) => consumedOf(r).seed))).toEqual(new Set([seedRun.id]))

    // Local: every checker run consumed the worker run of ITS OWN frame.
    const checkerRuns = await rowsOf('checker')
    expect(checkerRuns.length).toBe(4)
    for (const checker of checkerRuns) {
      const worker = workerRuns.find((r) => r.id === consumedOf(checker).worker)
      expect(worker).toBeDefined()
      expect(worker!.containerRunId).toBe(checker.containerRunId)
      expect(worker!.iteration).toBe(checker.iteration)
    }
    // …and the four (generation, round) frames are all distinct.
    expect(new Set(checkerRuns.map((r) => `${r.containerRunId}#${r.iteration}`)).size).toBe(4)
  }, 30000)
})
