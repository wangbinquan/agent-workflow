// Regression: wrapper scope boundaries must not erase execution dependencies.
//
// The scheduler historically filtered each recursive scope to edges whose two
// endpoints were already in that scope. For `external → wrapper-inner`, the
// parent scope dropped the inner target and the child scope dropped the
// external source, so wrapper-loop / wrapper-git could launch their agent while
// the real upstream was still running. These tests block the upstream process
// on a file and assert that the inner process has not even been spawned.
//
// The outbound case locks the other half of the same contract: a flat edge or
// binding that names a loop-inner port must read the loop wrapper's promoted
// final-iteration output, and downstream rows must record the wrapper run as
// consumed provenance.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

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

async function buildHarness(slug: string): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), `aw-wrapper-scope-${slug}-`))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'worktree')
  const stateDir = join(appHome, 'scenario-state')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 'test@example.com'])
  await runGit(worktreePath, ['config', 'user.name', 'Wrapper Scope Test'])
  writeFileSync(join(worktreePath, 'base.txt'), 'base\n')
  await runGit(worktreePath, ['add', 'base.txt'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'base'])
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    repoPath,
    worktreePath,
    stateDir,
    planFile: join(appHome, 'scenario.json'),
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  options: {
    role?: 'normal' | 'aggregator'
    outputKinds?: Record<string, string>
    outputWrapperPortNames?: Record<string, string>
  } = {},
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'wrapper scope regression agent',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify(options),
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: `wrapper-scope-${taskId}`,
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: `wrapper-scope-${taskId}`,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.repoPath,
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
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  return body().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await Bun.sleep(20)
  }
  return existsSync(path)
}

async function waitForNodeRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = (
      await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
        .limit(1)
    )[0]
    if (row !== undefined) return true
    await Bun.sleep(20)
  }
  return false
}

function orderingDefinition(kind: 'wrapper-loop' | 'wrapper-git'): WorkflowDefinition {
  const wrapper =
    kind === 'wrapper-loop'
      ? {
          id: 'wrapper',
          kind,
          nodeIds: ['inner'],
          maxIterations: 1,
          exitCondition: { kind: 'port-empty', nodeId: 'inner', portName: 'done' },
          outputBindings: [],
        }
      : { id: 'wrapper', kind, nodeIds: ['inner'] }
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'upstream', kind: 'agent-single', agentName: 'upstream' },
      { id: 'inner', kind: 'agent-single', agentName: 'inner', promptTemplate: '{{doc}}' },
      wrapper,
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [
      {
        id: 'external-to-inner',
        source: { nodeId: 'upstream', portName: 'doc' },
        target: { nodeId: 'inner', portName: 'doc' },
      },
    ],
  }
}

describe('scheduler wrapper scope dependencies', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  for (const kind of ['wrapper-loop', 'wrapper-git'] as const) {
    test(`${kind}: external upstream completes before the inner agent is spawned`, async () => {
      h = await buildHarness(kind)
      await seedAgent(h.db, 'upstream', ['doc'])
      await seedAgent(h.db, 'inner', ['result', 'done'])
      writeFileSync(
        h.planFile,
        JSON.stringify({
          upstream: [{ waitFile: 'release-upstream', output: { doc: 'UPSTREAM-DOC' } }],
          inner: [{ waitFile: 'release-inner', output: { result: 'INNER', done: '' } }],
        }),
      )
      const taskId = await seedTask(h, orderingDefinition(kind))
      const run = withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
        }),
      )

      const upstreamStarted = await waitForFile(join(h.stateDir, 'count-upstream'), 5_000)
      let innerStartedBeforeUpstreamCompleted = false
      try {
        expect(upstreamStarted).toBe(true)
        innerStartedBeforeUpstreamCompleted = await waitForFile(
          join(h.stateDir, 'count-inner'),
          2_000,
        )
      } finally {
        writeFileSync(join(h.stateDir, 'release-upstream'), '')
        writeFileSync(join(h.stateDir, 'release-inner'), '')
        await run
      }

      expect(innerStartedBeforeUpstreamCompleted).toBe(false)
      const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
      expect(task?.status).toBe('done')
      const innerRun = (
        await h.db
          .select()
          .from(nodeRuns)
          .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'inner')))
      )[0]
      expect(innerRun?.promptText).toContain('UPSTREAM-DOC')
      const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      expect(rows.filter((row) => row.nodeId === 'upstream')).toHaveLength(1)
      expect(rows.filter((row) => row.nodeId === 'wrapper')).toHaveLength(1)
      expect(rows.filter((row) => row.nodeId === 'inner')).toHaveLength(1)
    }, 30_000)
  }

  test('invalid multi-parent wrapper containment fails before any inner agent can spawn', async () => {
    h = await buildHarness('invalid-containment')
    await seedAgent(h.db, 'inner', ['result'])
    writeFileSync(
      h.planFile,
      JSON.stringify({
        inner: [{ output: { result: 'MUST-NOT-RUN' } }],
      }),
    )
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'inner', kind: 'agent-single', agentName: 'inner' },
        { id: 'git-a', kind: 'wrapper-git', nodeIds: ['inner'] },
        { id: 'git-b', kind: 'wrapper-git', nodeIds: ['inner'] },
      ],
      edges: [],
    } as unknown as WorkflowDefinition
    const taskId = await seedTask(h, definition)

    await withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
      }),
    )

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('failed')
    expect(task?.errorSummary).toBe('wrapper-containment-invalid')
    expect(existsSync(join(h.stateDir, 'count-inner'))).toBe(false)
    expect(await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).toHaveLength(0)
  }, 30_000)

  test('wrapper-fanout: wrapper input boundary waits, then dispatches exactly one child per shard', async () => {
    h = await buildHarness('fanout-input')
    await seedAgent(h.db, 'upstream', ['items'])
    await seedAgent(h.db, 'inner', ['result'])
    writeFileSync(
      h.planFile,
      JSON.stringify({
        upstream: [{ waitFile: 'release-upstream', output: { items: 'ALPHA\nBETA' } }],
        inner: [{ output: { result: 'SHARD-DONE' } }],
      }),
    )
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'upstream', kind: 'agent-single', agentName: 'upstream' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
        },
        {
          id: 'inner',
          kind: 'agent-single',
          agentName: 'inner',
          promptTemplate: 'SHARD={{item}}',
        },
      ],
      edges: [
        {
          id: 'upstream-to-fan',
          source: { nodeId: 'upstream', portName: 'items' },
          target: { nodeId: 'fan', portName: 'items' },
        },
        {
          id: 'fan-to-inner',
          boundary: 'wrapper-input',
          source: { nodeId: 'fan', portName: 'items' },
          target: { nodeId: 'inner', portName: 'item' },
        },
      ],
    } as unknown as WorkflowDefinition
    const taskId = await seedTask(h, definition)
    const run = withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
        maxConcurrentNodes: 1,
      }),
    )

    const upstreamStarted = await waitForFile(join(h.stateDir, 'count-upstream'), 5_000)
    let innerStartedBeforeUpstreamCompleted = false
    try {
      expect(upstreamStarted).toBe(true)
      innerStartedBeforeUpstreamCompleted = await waitForFile(
        join(h.stateDir, 'count-inner'),
        1_000,
      )
    } finally {
      writeFileSync(join(h.stateDir, 'release-upstream'), '')
      await run
    }

    expect(innerStartedBeforeUpstreamCompleted).toBe(false)
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const wrapperRun = rows.find((row) => row.nodeId === 'fan')
    const children = rows.filter(
      (row) => row.nodeId === 'inner' && row.parentNodeRunId === wrapperRun?.id,
    )
    expect(wrapperRun?.status).toBe('done')
    expect(children).toHaveLength(2)
    expect(children.map((row) => row.shardKey).sort()).toEqual(['0', '1'])
    expect(children.every((row) => row.promptText?.includes('SHARD='))).toBe(true)
    expect(children.some((row) => row.promptText?.includes('ALPHA'))).toBe(true)
    expect(children.some((row) => row.promptText?.includes('BETA'))).toBe(true)
  }, 30_000)

  test('implicit output binding inside a loop also holds the wrapper at the parent scope', async () => {
    h = await buildHarness('implicit-output')
    await seedAgent(h.db, 'upstream', ['doc'])
    writeFileSync(
      h.planFile,
      JSON.stringify({
        upstream: [{ waitFile: 'release-upstream', output: { doc: 'LATE-DOC' } }],
      }),
    )
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'upstream', kind: 'agent-single', agentName: 'upstream' },
        {
          id: 'capture',
          kind: 'output',
          ports: [{ name: 'snapshot', bind: { nodeId: 'upstream', portName: 'doc' } }],
        },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['capture'],
          maxIterations: 1,
          exitCondition: { kind: 'port-not-empty', nodeId: 'capture', portName: 'snapshot' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'capture', portName: 'snapshot' } }],
        },
      ],
      edges: [],
    } as unknown as WorkflowDefinition
    const taskId = await seedTask(h, definition)
    const run = withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
      }),
    )

    const upstreamStarted = await waitForFile(join(h.stateDir, 'count-upstream'), 5_000)
    let loopStartedBeforeUpstreamCompleted = false
    try {
      expect(upstreamStarted).toBe(true)
      loopStartedBeforeUpstreamCompleted = await waitForNodeRun(h.db, taskId, 'loop', 1_000)
    } finally {
      writeFileSync(join(h.stateDir, 'release-upstream'), '')
      await run
    }

    expect(loopStartedBeforeUpstreamCompleted).toBe(false)
    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task?.status).toBe('done')
    const loopRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    )[0]
    const final = (
      await h.db
        .select()
        .from(nodeRunOutputs)
        .where(and(eq(nodeRunOutputs.nodeRunId, loopRun!.id), eq(nodeRunOutputs.portName, 'final')))
    )[0]
    expect(final?.content).toBe('LATE-DOC')
  }, 30_000)

  test('loop inner → downstream agent/output reads the promoted final iteration and wrapper provenance', async () => {
    h = await buildHarness('loop-output')
    await seedAgent(h.db, 'worker', ['doc', 'findings'])
    await seedAgent(h.db, 'sink', ['result'])
    writeFileSync(
      h.planFile,
      JSON.stringify({
        worker: [
          { output: { doc: 'ITERATION-0', findings: 'continue' } },
          { output: { doc: 'ITERATION-1', findings: '' } },
        ],
        sink: [{ output: { result: 'SINK-DONE' } }],
      }),
    )
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'worker', kind: 'agent-single', agentName: 'worker' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['worker'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'worker', portName: 'findings' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'worker', portName: 'doc' } }],
        },
        {
          id: 'sink',
          kind: 'agent-single',
          agentName: 'sink',
          promptTemplate: '{{input}}',
        },
        {
          id: 'out',
          kind: 'output',
          ports: [{ name: 'direct', bind: { nodeId: 'worker', portName: 'doc' } }],
        },
      ],
      edges: [
        {
          id: 'inner-to-sink',
          source: { nodeId: 'worker', portName: 'doc' },
          target: { nodeId: 'sink', portName: 'input' },
        },
        {
          id: 'inner-to-output',
          source: { nodeId: 'worker', portName: 'doc' },
          target: { nodeId: 'out', portName: 'direct' },
        },
      ],
    } as unknown as WorkflowDefinition
    const taskId = await seedTask(h, definition)

    await withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
      }),
    )

    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const loopRun = rows.find((row) => row.nodeId === 'loop' && row.status === 'done')
    const sinkRun = rows.find((row) => row.nodeId === 'sink' && row.status === 'done')
    const outputRun = rows.find((row) => row.nodeId === 'out' && row.status === 'done')
    expect(loopRun).toBeDefined()
    expect(sinkRun).toBeDefined()
    expect(outputRun).toBeDefined()
    expect(sinkRun?.promptText).toContain('ITERATION-1')
    expect(JSON.parse(sinkRun?.consumedUpstreamRunsJson ?? '{}')).toEqual({
      loop: loopRun!.id,
    })
    const output = (
      await h.db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(eq(nodeRunOutputs.nodeRunId, outputRun!.id), eq(nodeRunOutputs.portName, 'direct')),
        )
    )[0]
    expect(output?.content).toBe('ITERATION-1')
    expect(JSON.parse(outputRun?.consumedUpstreamRunsJson ?? '{}')).toEqual({
      loop: loopRun!.id,
    })
    expect(rows.filter((row) => row.nodeId === 'worker' && row.status === 'done')).toHaveLength(2)
    expect(
      rows
        .filter((row) => row.nodeId === 'worker' && row.status === 'done')
        .map((row) => row.iteration)
        .sort(),
    ).toEqual([0, 1])
    expect(rows.filter((row) => row.nodeId === 'sink' && row.status === 'done')).toHaveLength(1)
    expect(rows.filter((row) => row.nodeId === 'out' && row.status === 'done')).toHaveLength(1)
  }, 30_000)

  test('wrapper-git → downstream reads git_diff only after the inner write and records wrapper provenance', async () => {
    h = await buildHarness('git-output')
    await seedAgent(h.db, 'editor', ['result'])
    await seedAgent(h.db, 'sink', ['result'])
    writeFileSync(
      h.planFile,
      JSON.stringify({
        editor: [
          { writeFiles: { 'git-wrapper-change.txt': 'changed\n' }, output: { result: 'OK' } },
        ],
        sink: [{ output: { result: 'SINK-DONE' } }],
      }),
    )
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'editor', kind: 'agent-single', agentName: 'editor' },
        { id: 'git', kind: 'wrapper-git', nodeIds: ['editor'] },
        { id: 'sink', kind: 'agent-single', agentName: 'sink', promptTemplate: '{{diff}}' },
      ],
      edges: [
        {
          id: 'git-to-sink',
          source: { nodeId: 'git', portName: 'git_diff' },
          target: { nodeId: 'sink', portName: 'diff' },
        },
      ],
    } as unknown as WorkflowDefinition
    const taskId = await seedTask(h, definition)

    await withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
      }),
    )

    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const gitRun = rows.find((row) => row.nodeId === 'git' && row.status === 'done')
    const sinkRun = rows.find((row) => row.nodeId === 'sink' && row.status === 'done')
    expect(gitRun).toBeDefined()
    expect(sinkRun?.promptText).toContain('git-wrapper-change.txt')
    expect(JSON.parse(sinkRun?.consumedUpstreamRunsJson ?? '{}')).toEqual({ git: gitRun!.id })
    expect(rows.filter((row) => row.nodeId === 'editor' && row.status === 'done')).toHaveLength(1)
    expect(rows.filter((row) => row.nodeId === 'git' && row.status === 'done')).toHaveLength(1)
    expect(rows.filter((row) => row.nodeId === 'sink' && row.status === 'done')).toHaveLength(1)
  }, 30_000)

  test('wrapper-fanout aggregator outlet gates one downstream run and owns its provenance', async () => {
    h = await buildHarness('fanout-output')
    await seedAgent(h.db, 'source', ['items'])
    await seedAgent(h.db, 'worker', ['result'])
    await seedAgent(h.db, 'aggregator', ['summary'], {
      role: 'aggregator',
      outputWrapperPortNames: { summary: 'final' },
    })
    await seedAgent(h.db, 'sink', ['result'])
    writeFileSync(
      h.planFile,
      JSON.stringify({
        source: [{ output: { items: 'ONE\nTWO' } }],
        worker: [{ output: { result: 'SHARD-RESULT' } }],
        aggregator: [{ output: { summary: 'AGGREGATED' } }],
        sink: [{ output: { result: 'SINK-DONE' } }],
      }),
    )
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'source', kind: 'agent-single', agentName: 'source' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['worker', 'aggregator'],
          inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
        },
        {
          id: 'worker',
          kind: 'agent-single',
          agentName: 'worker',
          promptTemplate: '{{item}}',
        },
        {
          id: 'aggregator',
          kind: 'agent-single',
          agentName: 'aggregator',
          promptTemplate: '{{parts}}',
        },
        { id: 'sink', kind: 'agent-single', agentName: 'sink', promptTemplate: '{{input}}' },
      ],
      edges: [
        {
          id: 'source-to-fan',
          source: { nodeId: 'source', portName: 'items' },
          target: { nodeId: 'fan', portName: 'items' },
        },
        {
          id: 'fan-to-worker',
          boundary: 'wrapper-input',
          source: { nodeId: 'fan', portName: 'items' },
          target: { nodeId: 'worker', portName: 'item' },
        },
        {
          id: 'worker-to-aggregator',
          source: { nodeId: 'worker', portName: 'result' },
          target: { nodeId: 'aggregator', portName: 'parts' },
        },
        {
          id: 'aggregator-to-fan',
          boundary: 'wrapper-output',
          source: { nodeId: 'aggregator', portName: 'summary' },
          target: { nodeId: 'fan', portName: 'final' },
        },
        {
          id: 'aggregator-to-sink',
          source: { nodeId: 'aggregator', portName: 'summary' },
          target: { nodeId: 'sink', portName: 'input' },
        },
      ],
    } as unknown as WorkflowDefinition
    const taskId = await seedTask(h, definition)

    await withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
        maxConcurrentNodes: 1,
      }),
    )

    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const fanRun = rows.find((row) => row.nodeId === 'fan' && row.status === 'done')
    const sinkRun = rows.find((row) => row.nodeId === 'sink' && row.status === 'done')
    expect(fanRun).toBeDefined()
    expect(sinkRun?.promptText).toContain('AGGREGATED')
    expect(JSON.parse(sinkRun?.consumedUpstreamRunsJson ?? '{}')).toEqual({ fan: fanRun!.id })
    expect(
      rows.filter((row) => row.nodeId === 'worker' && row.parentNodeRunId === fanRun!.id),
    ).toHaveLength(2)
    expect(
      rows.filter((row) => row.nodeId === 'aggregator' && row.parentNodeRunId === fanRun!.id),
    ).toHaveLength(1)
    expect(rows.filter((row) => row.nodeId === 'sink' && row.status === 'done')).toHaveLength(1)
  }, 30_000)

  test('nested loop → git → agent keeps the deepest child behind the external source and promotes the outer outlet', async () => {
    h = await buildHarness('nested-loop-git')
    await seedAgent(h.db, 'upstream', ['doc'])
    await seedAgent(h.db, 'editor', ['result'])
    await seedAgent(h.db, 'sink', ['result'])
    writeFileSync(
      h.planFile,
      JSON.stringify({
        upstream: [{ waitFile: 'release-upstream', output: { doc: 'NESTED-INPUT' } }],
        editor: [
          {
            writeFiles: { 'nested-wrapper-change.txt': 'nested\n' },
            output: { result: 'EDITED' },
          },
        ],
        sink: [{ output: { result: 'SINK-DONE' } }],
      }),
    )
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'upstream', kind: 'agent-single', agentName: 'upstream' },
        { id: 'editor', kind: 'agent-single', agentName: 'editor', promptTemplate: '{{doc}}' },
        { id: 'git', kind: 'wrapper-git', nodeIds: ['editor'] },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['git'],
          maxIterations: 1,
          exitCondition: { kind: 'port-not-empty', nodeId: 'git', portName: 'git_diff' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'git', portName: 'git_diff' } }],
        },
        { id: 'sink', kind: 'agent-single', agentName: 'sink', promptTemplate: '{{diff}}' },
      ],
      edges: [
        {
          id: 'external-to-deepest',
          source: { nodeId: 'upstream', portName: 'doc' },
          target: { nodeId: 'editor', portName: 'doc' },
        },
        {
          id: 'nested-output-to-sink',
          source: { nodeId: 'git', portName: 'git_diff' },
          target: { nodeId: 'sink', portName: 'diff' },
        },
      ],
    } as unknown as WorkflowDefinition
    const taskId = await seedTask(h, definition)
    const run = withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
      }),
    )

    const upstreamStarted = await waitForFile(join(h.stateDir, 'count-upstream'), 5_000)
    let editorStartedBeforeUpstreamCompleted = false
    try {
      expect(upstreamStarted).toBe(true)
      editorStartedBeforeUpstreamCompleted = await waitForFile(
        join(h.stateDir, 'count-editor'),
        1_000,
      )
    } finally {
      writeFileSync(join(h.stateDir, 'release-upstream'), '')
      await run
    }

    expect(editorStartedBeforeUpstreamCompleted).toBe(false)
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const loopRun = rows.find((row) => row.nodeId === 'loop' && row.status === 'done')
    const editorRun = rows.find((row) => row.nodeId === 'editor' && row.status === 'done')
    const sinkRun = rows.find((row) => row.nodeId === 'sink' && row.status === 'done')
    expect(loopRun).toBeDefined()
    expect(editorRun?.promptText).toContain('NESTED-INPUT')
    expect(sinkRun?.promptText).toContain('nested-wrapper-change.txt')
    expect(JSON.parse(sinkRun?.consumedUpstreamRunsJson ?? '{}')).toEqual({ loop: loopRun!.id })
    expect(rows.filter((row) => row.nodeId === 'upstream')).toHaveLength(1)
    expect(rows.filter((row) => row.nodeId === 'loop')).toHaveLength(1)
    expect(rows.filter((row) => row.nodeId === 'git')).toHaveLength(1)
    expect(rows.filter((row) => row.nodeId === 'editor')).toHaveLength(1)
    expect(rows.filter((row) => row.nodeId === 'sink')).toHaveLength(1)
  }, 30_000)
})
