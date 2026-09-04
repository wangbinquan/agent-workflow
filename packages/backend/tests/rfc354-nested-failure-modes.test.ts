// RFC-354 — the FAILURE side of nesting, executed.
//
// Frames introduced a lexical visibility rule ("入边是参数、出边是返回值、穿墙边是
// 闭包"), and a rule is only worth as much as what happens when it is broken. Until
// this file the broken cases were locked as PURE FUNCTIONS only
// (`rfc354-environment-chain.test.ts` on the resolver, `rfc354-validator-node-
// semantics.test.ts` on the authoring gate) — nothing said what a TASK does.
//
// Three cases, executed:
//
//   ① a loop whose exit condition reads a node BEHIND an inner wrapper's wall.
//     The source is deeper than the reader, so no frame in the reader's
//     environment chain could bind it. The task fails closed with an
//     out-of-scope diagnosis and mints no rows at all — never a silently stale
//     value. (This shape is what audit S-4b's fixture used to be — see the head
//     note of `scheduler-audit-s04-git-wrapper-cumulative-diff.test.ts`.)
//
//   ② an inner loop that exhausts its ceiling. `rfc354-nested-loop-frames`
//     covers the OUTER loop exhausting; this is the other direction — the
//     failure has to travel out through the frames, and every row along the way
//     has to settle.
//
//   ③ CURRENT-BEHAVIOR LOCK (⚠️ not an endorsement): an ordinary edge between
//     two SIBLING wrapper scopes. `loopA ∋ workerA` and `loopB ∋ workerB` are
//     neither nested nor enclosing, so under the lexical rule `workerA`'s output
//     is not visible from `workerB` at all. What actually happens today is that
//     the workflow VALIDATES, the task runs to `done`, and `workerA`'s value is
//     handed to `workerB` through the wall — the dependency is recorded against
//     the neighbouring wrapper's generation row. This test pins that as it is so
//     the behavior cannot drift unnoticed; it does not claim it is right. If the
//     product decides the lexical rule wins here too, flip this test: the task
//     becomes `failed` with `closure-binding-unresolved` and the leak assertion
//     inverts.
//
// Deterministic: in-memory SQLite, serial dispatch, real subprocesses driven by
// a per-call plan (fixtures/scenario-opencode.ts); no sleeps, no network; temp
// dirs cleaned in afterEach.

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
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
import { validateWorkflowDef } from '../src/services/workflow.validator'

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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc354-nested-fail-'))
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
    name: 'rfc354-nested-failure-task',
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
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { agent: string; callIndex: number })
}

function drive(h: Harness, taskId: string): Promise<unknown> {
  return withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
    runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      binaryOverride: ['bun', 'run', SCENARIO_OPENCODE],
    }),
  )
}

describe('RFC-354 — nested failure modes', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('a loop that reads through an inner wrapper wall fails closed with a scope diagnosis', async () => {
    await seedAgent(h.db, 'worker', ['status'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'worker', kind: 'agent-single', agentName: 'worker' },
        {
          id: 'iloop',
          kind: 'wrapper-loop',
          nodeIds: ['worker'],
          maxIterations: 1,
          continueOnMaxIterations: true,
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'worker',
            portName: 'status',
            value: '__NEVER__',
          },
          outputBindings: [{ name: 'verdict', bind: { nodeId: 'worker', portName: 'status' } }],
        },
        {
          id: 'oloop',
          kind: 'wrapper-loop',
          nodeIds: ['iloop'],
          maxIterations: 2,
          // `worker` is NOT a direct member of this loop — it sits one wall
          // deeper, inside `iloop`. Reading it here is reading INTO a scope,
          // which no environment chain can bind (the reader's chain only ever
          // walks outwards). The pre-RFC-354 picker would have answered with
          // "highest iteration ≤ my window", i.e. a value from some round of
          // some generation — plausible-looking and wrong.
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'worker',
            portName: 'status',
            value: 'STOP',
          },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    writeFileSync(h.planFile, JSON.stringify({ worker: [{ output: { status: 'STOP' } }] }))

    await drive(h, taskId)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('failed')
    // Two gates can catch this, and which one fires is an implementation
    // detail; what the user is promised is that the task STOPS and says the
    // source is out of scope. Today the loop's own return/exit gate is first
    // (`wrapper-loop-return-source-out-of-scope`); the environment chain's
    // `closure-binding-unresolved: scope-not-enclosing` sits behind it as the
    // general case. The assertion is on the shared, user-facing substring so a
    // change of which gate fires stays green while a SILENT read goes red.
    expect(task?.errorMessage ?? '').toContain('out-of-scope')

    // It fails BEFORE anything runs: no node_run is minted, no agent process is
    // spawned, no worktree is touched. An illegal read is a definition error,
    // and the user pays nothing for it.
    const allRuns = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(allRuns.map((row) => row.nodeId)).toEqual([])
    expect(readTrace(h)).toEqual([])
  }, 30000)

  test('an inner loop that exhausts its ceiling fails the whole task, and every frame settles', async () => {
    await seedAgent(h.db, 'worker', ['status'])
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
          // The worker never says STOP ⇒ the INNER loop hits its ceiling.
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'worker',
            portName: 'status',
            value: 'STOP',
          },
          outputBindings: [{ name: 'verdict', bind: { nodeId: 'worker', portName: 'status' } }],
        },
        {
          id: 'oloop',
          kind: 'wrapper-loop',
          nodeIds: ['iloop'],
          maxIterations: 2,
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'iloop',
            portName: 'verdict',
            value: 'STOP',
          },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    writeFileSync(h.planFile, JSON.stringify({ worker: [{ output: { status: 'GO' } }] }))

    await drive(h, taskId)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('failed')
    expect(task?.errorMessage ?? '').toContain('wrapper-loop-exhausted')

    // The inner loop burned its own ceiling in the FIRST outer round and the
    // failure travelled out: the outer loop never opened a second generation.
    const rowsOf = (nodeId: string) =>
      h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
    const innerRuns = await rowsOf('iloop')
    expect(innerRuns.length).toBe(1)
    expect(innerRuns[0]?.status).toBe('exhausted')
    const outerRuns = await rowsOf('oloop')
    expect(outerRuns.length).toBe(1)
    expect(innerRuns[0]?.containerRunId).toBe(outerRuns[0]!.id)
    expect(innerRuns[0]?.scopePath).toBe('oloop:0')

    // Two agent runs — the inner ceiling — both inside that one inner generation.
    const workerRuns = await rowsOf('worker')
    expect(workerRuns.length).toBe(2)
    expect(workerRuns.every((row) => row.containerRunId === innerRuns[0]!.id)).toBe(true)
    expect([...workerRuns.map((row) => row.scopePath)].sort()).toEqual([
      'oloop:0/iloop:0',
      'oloop:0/iloop:1',
    ])
    expect(readTrace(h).filter((line) => line.agent === 'worker').length).toBe(2)
  }, 30000)

  // ⚠️ CURRENT-BEHAVIOR LOCK — see ③ in the head note. Sibling scopes are not
  // lexically visible to each other, yet today the edge validates and the value
  // crosses. Flip this test if the product closes the hole.
  test('CURRENT BEHAVIOR: an edge between two SIBLING wrapper scopes validates and carries the value across the wall', async () => {
    await seedAgent(h.db, 'workerA', ['findings'])
    await seedAgent(h.db, 'workerB', ['verdict'])
    const siblingLoop = (id: string, member: string, port: string): Record<string, unknown> => ({
      id,
      kind: 'wrapper-loop',
      nodeIds: [member],
      maxIterations: 1,
      continueOnMaxIterations: true,
      exitCondition: { kind: 'port-equals', nodeId: member, portName: port, value: '__NEVER__' },
      outputBindings: [{ name: `${id}_out`, bind: { nodeId: member, portName: port } }],
    })
    const nodes = [
      { id: 'workerA', kind: 'agent-single', agentName: 'workerA' },
      { id: 'workerB', kind: 'agent-single', agentName: 'workerB' },
      siblingLoop('loopA', 'workerA', 'findings'),
      siblingLoop('loopB', 'workerB', 'verdict'),
    ]
    const edges = [
      {
        id: 'e-sibling',
        source: { nodeId: 'workerA', portName: 'findings' },
        target: { nodeId: 'workerB', portName: 'in' },
      },
    ]
    const def = { $schema_version: 1, inputs: [], nodes, edges } as unknown as WorkflowDefinition

    // (a) The authoring gate raises nothing at all on this shape.
    const validationAgents = ['workerA', 'workerB'].map(
      (name) =>
        ({
          id: `agent-${name}`,
          name,
          description: '',
          outputs: name === 'workerA' ? ['findings'] : ['verdict'],
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn: [],
          mcp: [],
          plugins: [],
          frontmatterExtra: {},
          bodyMd: '',
          schemaVersion: 1,
          createdAt: 0,
          updatedAt: 0,
        }) as Agent,
    )
    const receipt = validateWorkflowDef(
      {
        ...def,
        nodes: nodes.map((node) =>
          node.kind === 'agent-single' ? { ...node, agentId: `agent-${String(node.id)}` } : node,
        ),
      } as unknown as WorkflowDefinition,
      { agents: validationAgents, skills: [] } as never,
    )
    expect(receipt.ok).toBe(true)
    expect(receipt.issues.map((issue) => issue.code)).not.toContain('closure-binding-unresolved')

    // (b) And the task completes, with the neighbour's value in the prompt.
    const { taskId } = await seedWorkflowAndTask(h, def)
    writeFileSync(
      h.planFile,
      JSON.stringify({
        workerA: [{ output: { findings: 'A-SECRET' } }],
        workerB: [{ output: { verdict: 'B-DONE' } }],
      }),
    )

    await drive(h, taskId)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('done')

    const runsOfB = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'workerB')))
    expect(runsOfB.length).toBe(1)
    const consumerRun = runsOfB[0]!
    // The two workers live in different generations — sibling scopes, no
    // containment either way …
    const runsOfA = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'workerA')))
    expect(runsOfA[0]!.containerRunId).not.toBe(consumerRun.containerRunId)
    expect(runsOfA[0]!.scopePath).toBe('loopA:0')
    expect(consumerRun.scopePath).toBe('loopB:0')
    // … and yet the value crossed, and the dependency is recorded against the
    // neighbouring WRAPPER's generation row rather than the producing run.
    expect(consumerRun.promptText ?? '').toContain('A-SECRET')
    const consumed = JSON.parse(consumerRun.consumedUpstreamRunsJson ?? '{}') as Record<
      string,
      string
    >
    expect(Object.keys(consumed)).toEqual(['loopA'])
  }, 30000)
})
