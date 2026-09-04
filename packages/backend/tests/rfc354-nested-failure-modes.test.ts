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
//   ③ the three wrapper WALLS, compared. Reading a node that lives inside
//     another wrapper (a sibling scope — neither nested nor enclosing) is the
//     same authoring action in all three cases, and today it gets two different
//     answers:
//
//       wrapper-git    → refused, `wrapper-output-boundary-missing`, task failed
//       wrapper-fanout → refused, `wrapper-output-boundary-missing`, task failed
//       wrapper-loop   → ALLOWED; the value crosses and the task completes
//
//     The loop case is a CURRENT-BEHAVIOR LOCK (⚠️ not an endorsement). It reads
//     the loop's LAST round and it resolves in the right frame — an outer loop's
//     second generation reads that generation's value, not the first one's, so
//     this is not a frame leak — but it does bypass the wrapper's declared
//     return contract, and it is inconsistent with the other two walls. Pinned
//     here so neither side can drift silently. If the product closes the hole,
//     flip the loop test: it becomes `failed` with
//     `wrapper-output-boundary-missing` like its siblings, and note that doing
//     so is a capability contraction for any stored workflow already wired this
//     way (CLAUDE.md §RFC workflow 第 7 条).
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
import { runGit } from '../src/util/git'
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
  inputs: Record<string, string> = {},
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
    inputs: JSON.stringify(inputs),
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

/** The git wrapper needs a real repo; the other cases do not pay for one. */
async function initRepo(h: Harness): Promise<void> {
  await runGit(h.worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(h.worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(h.worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(h.worktreePath, 'base.txt'), 'baseline\n')
  await runGit(h.worktreePath, ['add', '.'])
  await runGit(h.worktreePath, ['commit', '-q', '-m', 'init'])
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

  test('a git wrapper wall refuses a sibling read: the inner agent port is not exposed', async () => {
    await initRepo(h)
    await seedAgent(h.db, 'gitWorker', ['findings'])
    await seedAgent(h.db, 'workerB', ['verdict'])
    const def = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'gitWorker', kind: 'agent-single', agentName: 'gitWorker' },
        { id: 'gitw', kind: 'wrapper-git', nodeIds: ['gitWorker'] },
        { id: 'workerB', kind: 'agent-single', agentName: 'workerB' },
        {
          id: 'loopB',
          kind: 'wrapper-loop',
          nodeIds: ['workerB'],
          maxIterations: 1,
          continueOnMaxIterations: true,
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'workerB',
            portName: 'verdict',
            value: '__NEVER__',
          },
          outputBindings: [{ name: 'b_out', bind: { nodeId: 'workerB', portName: 'verdict' } }],
        },
      ],
      edges: [
        {
          id: 'e-cross',
          source: { nodeId: 'gitWorker', portName: 'findings' },
          target: { nodeId: 'workerB', portName: 'in' },
        },
      ],
    } as unknown as WorkflowDefinition
    const { taskId } = await seedWorkflowAndTask(h, def)
    writeFileSync(
      h.planFile,
      JSON.stringify({
        gitWorker: [{ output: { findings: 'INSIDE-GIT' } }],
        workerB: [{ output: { verdict: 'B' } }],
      }),
    )

    await drive(h, taskId)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('failed')
    expect(task?.errorMessage ?? '').toContain('wrapper-output-boundary-missing')
    // A git wrapper exposes exactly `git_diff`; an inner agent's own ports never
    // leak, so the consumer never runs.
    expect(task?.errorMessage ?? '').toContain('gitWorker.findings')
    expect(readTrace(h).filter((line) => line.agent === 'workerB').length).toBe(0)
  }, 30000)

  test('a fan-out wall refuses a sibling read: shard ports are not exposed either', async () => {
    await seedAgent(h.db, 'shardWorker', ['result'])
    await seedAgent(h.db, 'workerB', ['verdict'])
    const def = {
      $schema_version: 4,
      inputs: [{ kind: 'files', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['shardWorker'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'shardWorker', kind: 'agent-single', agentName: 'shardWorker' },
        { id: 'workerB', kind: 'agent-single', agentName: 'workerB' },
        {
          id: 'loopB',
          kind: 'wrapper-loop',
          nodeIds: ['workerB'],
          maxIterations: 1,
          continueOnMaxIterations: true,
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'workerB',
            portName: 'verdict',
            value: '__NEVER__',
          },
          outputBindings: [{ name: 'b_out', bind: { nodeId: 'workerB', portName: 'verdict' } }],
        },
      ],
      edges: [
        {
          id: 'e-docs',
          source: { nodeId: 'inp', portName: 'docs' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
        {
          id: 'e-cross',
          source: { nodeId: 'shardWorker', portName: 'result' },
          target: { nodeId: 'workerB', portName: 'in' },
        },
      ],
    } as unknown as WorkflowDefinition
    const { taskId } = await seedWorkflowAndTask(h, def, { docs: 'docs/a.md\ndocs/b.md' })
    writeFileSync(
      h.planFile,
      JSON.stringify({
        shardWorker: [{ output: { result: 'SHARD-0' } }, { output: { result: 'SHARD-1' } }],
        workerB: [{ output: { verdict: 'B' } }],
      }),
    )

    await drive(h, taskId)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('failed')
    expect(task?.errorMessage ?? '').toContain('wrapper-output-boundary-missing')
    expect(task?.errorMessage ?? '').toContain('shardWorker.result')
    // Which shard would it even have been? The refusal is what keeps that
    // question from having to be answered.
    expect(readTrace(h).filter((line) => line.agent === 'workerB').length).toBe(0)
  }, 30000)

  // ⚠️ CURRENT-BEHAVIOR LOCK — see ③ in the head note. The two tests above show
  // git and fan-out refusing this exact authoring action; the loop does not.
  // Flip this test (and the one after it) if the product closes the hole.
  test('CURRENT BEHAVIOR: a wrapper-loop wall does NOT refuse it — the value crosses, in the right frame', async () => {
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

  // ⚠️ CURRENT-BEHAVIOR LOCK (companion to the one above).
  //
  // What the crossing is NOT: a frame leak. Put both sibling loops inside an
  // outer loop and run two generations — each generation's consumer reads ITS
  // OWN generation's producer, never the previous one's. So the hole is about
  // the wrapper's declared return CONTRACT being bypassed, not about the
  // scheduler losing track of which round it is in; a fix should keep this
  // property (a "read the freshest row" repair would break it and go red here).
  test('CURRENT BEHAVIOR: the sibling crossing still resolves per frame across outer generations', async () => {
    await seedAgent(h.db, 'workerA', ['findings'])
    await seedAgent(h.db, 'workerB', ['verdict'])
    const innerLoop = (id: string, member: string, port: string): Record<string, unknown> => ({
      id,
      kind: 'wrapper-loop',
      nodeIds: [member],
      maxIterations: 1,
      continueOnMaxIterations: true,
      exitCondition: { kind: 'port-equals', nodeId: member, portName: port, value: '__NEVER__' },
      outputBindings: [{ name: `${id}_out`, bind: { nodeId: member, portName: port } }],
    })
    const def = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'workerA', kind: 'agent-single', agentName: 'workerA' },
        { id: 'workerB', kind: 'agent-single', agentName: 'workerB' },
        innerLoop('loopA', 'workerA', 'findings'),
        innerLoop('loopB', 'workerB', 'verdict'),
        {
          id: 'outer',
          kind: 'wrapper-loop',
          nodeIds: ['loopA', 'loopB'],
          maxIterations: 2,
          continueOnMaxIterations: true,
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'loopB',
            portName: 'loopB_out',
            value: '__NEVER__',
          },
          outputBindings: [],
        },
      ],
      edges: [
        {
          id: 'e-sibling',
          source: { nodeId: 'workerA', portName: 'findings' },
          target: { nodeId: 'workerB', portName: 'in' },
        },
      ],
    } as unknown as WorkflowDefinition
    const { taskId } = await seedWorkflowAndTask(h, def)
    writeFileSync(
      h.planFile,
      JSON.stringify({
        workerA: [{ output: { findings: 'GEN-0' } }, { output: { findings: 'GEN-1' } }],
        workerB: [{ output: { verdict: 'B' } }],
      }),
    )

    await drive(h, taskId)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('done')

    const consumers = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'workerB')))
    expect(consumers.length).toBe(2)
    const byScope = new Map(consumers.map((row) => [row.scopePath, row.promptText ?? '']))
    expect([...byScope.keys()].sort()).toEqual(['outer:0/loopB:0', 'outer:1/loopB:0'])
    expect(byScope.get('outer:0/loopB:0')).toContain('GEN-0')
    expect(byScope.get('outer:0/loopB:0')).not.toContain('GEN-1')
    expect(byScope.get('outer:1/loopB:0')).toContain('GEN-1')
    expect(byScope.get('outer:1/loopB:0')).not.toContain('GEN-0')
  }, 30000)
})
