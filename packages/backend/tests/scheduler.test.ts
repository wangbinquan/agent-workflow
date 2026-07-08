// End-to-end scheduler tests for one task (P-1-14).
// Bypasses startTask's worktree creation by inserting the task row directly —
// real worktree creation is exercised in tasks.test.ts.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { runGit } from '../src/util/git'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-sched-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  // RFC-130: the task worktree must be a real git repo — the scheduler now runs
  // each node in an isolated worktree branched from a snapshot of the canonical
  // one (createNodeIso needs `git worktree add` + a HEAD to snapshot from).
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, '.seed'), 'seed\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
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
  outputs: string[] = ['summary'],
): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<{ workflowId: string; taskId: string }> {
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
  return { workflowId, taskId }
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

describe('runTask: linear DAG (M1)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('input -> agent-single happy path', async () => {
    await seedAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'Req' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        { id: 'a1', kind: 'agent-single', agentName: 'auditor' },
      ],
      edges: [
        {
          id: 'e1',
          // RFC-004: input node port name is its inputKey, not 'out'.
          source: { nodeId: 'in', portName: 'requirement' },
          target: { nodeId: 'a1', portName: 'requirement' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { requirement: 'do the thing' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: 'nothing wrong' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const finalTask = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(finalTask?.status).toBe('done')
    expect(finalTask?.errorMessage).toBeNull()

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.length).toBe(2)
    expect(runs.find((r) => r.nodeId === 'in')?.status).toBe('done')
    expect(runs.find((r) => r.nodeId === 'a1')?.status).toBe('done')

    const a1 = runs.find((r) => r.nodeId === 'a1')
    const outputRows = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, a1?.id ?? ''))
    expect(outputRows.find((r) => r.portName === 'findings')?.content).toBe('nothing wrong')

    // Input node also persisted as a virtual run with its outputs.
    const inRun = runs.find((r) => r.nodeId === 'in')
    const inOutputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, inRun?.id ?? ''))
    // RFC-004: input node's output port name === inputKey, not 'out'.
    expect(inOutputs[0]?.portName).toBe('requirement')
    expect(inOutputs[0]?.content).toBe('do the thing')
  })

  test('agent name unknown -> task fails with agent-not-found', async () => {
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'a1', kind: 'agent-single', agentName: 'no-such-agent' }],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)

    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorSummary).toContain('no-such-agent')
    expect(t?.failedNodeId).toBe('a1')
  })

  test('empty wrapper fails the task with a node-anchored error', async () => {
    // Historically this locked the M3-era kind whitelist ("wrapper kinds
    // rejected as unsupported"). Wrappers are long supported and RFC-146
    // made the whitelist positive table membership, so the surviving
    // contract is downstream: a wrapper-git with no inner nodes fails the
    // task with an errorSummary naming the node ("has no inner nodes").
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'wg', kind: 'wrapper-git', nodeIds: [] }],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorSummary).toContain('wrapper-git')
  })

  test('cycle in workflow -> task fails with cycle error', async () => {
    await seedAgent(h.db, 'a', ['out'])
    await seedAgent(h.db, 'b', ['out'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'a' },
        { id: 'b', kind: 'agent-single', agentName: 'b' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'x' },
        },
        {
          id: 'e2',
          source: { nodeId: 'b', portName: 'out' },
          target: { nodeId: 'a', portName: 'x' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorSummary).toContain('cycle')
  })

  test('node runner failure halts task at that node', async () => {
    await seedAgent(h.db, 'broken', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'a1', kind: 'agent-single', agentName: 'broken' }],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv({ MOCK_OPENCODE_EXIT_CODE: '5', MOCK_OPENCODE_SKIP_ENVELOPE: '1' }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.failedNodeId).toBe('a1')
    expect(t?.errorMessage).toContain('exited with code 5')
  })

  test('output nodes mint a virtual done node_run + snapshot bound port content', async () => {
    // RFC-053 T3 alignment (see lifecycleInvariants.ts §T3). Previously the
    // scheduler filtered output nodes out of every scope and short-circuited
    // runOneNode for kind='output', so done tasks containing an output node
    // permanently violated the T3 invariant (`task.status=done but not every
    // output node has a done node_run`). The fix gives output nodes a virtual
    // `done` row + node_run_outputs derived from their `ports[].bind`
    // bindings; the detail page now reads outputs uniformly via node_runs.
    await seedAgent(h.db, 'a', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'a' },
        {
          id: 'o',
          kind: 'output',
          ports: [{ name: 'final', bind: { nodeId: 'a', portName: 'summary' } }],
        },
      ],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.find((r) => r.nodeId === 'a')?.status).toBe('done')
    const outRun = runs.find((r) => r.nodeId === 'o')
    expect(outRun).toBeDefined()
    expect(outRun?.status).toBe('done')

    const outPorts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, outRun!.id))
    expect(outPorts).toHaveLength(1)
    expect(outPorts[0]?.portName).toBe('final')
    expect(outPorts[0]?.content).toBe('ok')

    // End-to-end T3 invariant guard: a done task with this workflow must
    // produce zero T3 findings. Locks in the fix at the integration level.
    const inv = await runLifecycleInvariants({ db: h.db, scope: { taskId } })
    expect(inv.openAlerts.filter((a) => a.rule === 'T3')).toHaveLength(0)
  })

  test('signal aborted before scheduling -> task status=canceled', async () => {
    await seedAgent(h.db, 'a', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'a', kind: 'agent-single', agentName: 'a' }],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    const controller = new AbortController()
    controller.abort()
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      signal: controller.signal,
    })
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('canceled')
    expect(t?.errorSummary).toContain('canceled')
  })

  test('signal aborted mid-run -> runner result=canceled propagates', async () => {
    await seedAgent(h.db, 'slow', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'a', kind: 'agent-single', agentName: 'slow' }],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '2000',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'never' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          signal: controller.signal,
        }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('canceled')
  })

  test('multiple edges to same target port are concatenated', async () => {
    // Two input nodes both feed agent.requirement port. Scheduler should
    // concatenate them with the standard separator.
    await seedAgent(h.db, 'a', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [
        { kind: 'text', key: 'k1', label: 'k1' },
        { kind: 'text', key: 'k2', label: 'k2' },
      ],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'k1' },
        { id: 'in2', kind: 'input', inputKey: 'k2' },
        { id: 'a', kind: 'agent-single', agentName: 'a' },
      ],
      edges: [
        {
          id: 'e1',
          // RFC-004: input.portName === inputKey.
          source: { nodeId: 'in1', portName: 'k1' },
          target: { nodeId: 'a', portName: 'requirement' },
        },
        {
          id: 'e2',
          source: { nodeId: 'in2', portName: 'k2' },
          target: { nodeId: 'a', portName: 'requirement' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { k1: 'AAA', k2: 'BBB' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // The agent node's prompt should contain both inputs separated by ---.
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const aRun = runs.find((r) => r.nodeId === 'a')
    expect(aRun?.promptText).toContain('AAA')
    expect(aRun?.promptText).toContain('BBB')
    expect(aRun?.promptText).toContain('---')
  })

  test('two read-only agents at the same level run in parallel under the global semaphore', async () => {
    // No edges between r1 and r2 → same level → eligible for parallel.
    await seedReadonlyAgent(h.db, 'r1', ['summary'])
    await seedReadonlyAgent(h.db, 'r2', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'r1', kind: 'agent-single', agentName: 'r1' },
        { id: 'r2', kind: 'agent-single', agentName: 'r2' },
      ],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '1500',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          maxConcurrentNodes: 2,
        }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    // Parallelism is asserted STRUCTURALLY via execution-window OVERLAP, NOT a
    // total-elapsed bound. The old `elapsed < 2700ms` check was a timing flake: two
    // 1500ms nodes each run in their OWN iso worktree, and RFC-130 per-node iso
    // overhead (snapshot + `git worktree add` + merge-back) varies under CI load —
    // macOS CI hit 2950ms (still far below the ~3600ms serial floor, i.e. they DID
    // run in parallel) yet tripped the tight bound. Overlap is variance-proof: if the
    // two same-level writer nodes ran serially (one writeSem for the whole run),
    // r2.startedAt would be ≥ r1.finishedAt and the windows would not overlap.
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const r1 = runs.find((r) => r.nodeId === 'r1')
    const r2 = runs.find((r) => r.nodeId === 'r2')
    expect(r1?.startedAt ?? 0).toBeGreaterThan(0)
    expect(r2?.startedAt ?? 0).toBeGreaterThan(0)
    expect(r1?.finishedAt ?? 0).toBeGreaterThan(0)
    expect(r2?.finishedAt ?? 0).toBeGreaterThan(0)
    const overlapStart = Math.max(r1!.startedAt!, r2!.startedAt!)
    const overlapEnd = Math.min(r1!.finishedAt!, r2!.finishedAt!)
    expect(overlapEnd).toBeGreaterThan(overlapStart) // windows overlap → ran in parallel
  })

  test('node with retries=2 fails twice then succeeds', async () => {
    await seedReadonlyAgent(h.db, 'flaky', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        {
          id: 'a1',
          kind: 'agent-single',
          agentName: 'flaky',
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    const counter = join(h.appHome, 'retry-counter')
    await withEnv(
      {
        MOCK_OPENCODE_FAIL_COUNTER: counter,
        MOCK_OPENCODE_FAIL_UNTIL: '2',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'done' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          // RFC-115: retry budget via runTask opts (was node.retries: 2).
          defaultNodeRetries: 2,
        }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    // We should have 3 node_runs: retry_index 0,1 failed; 2 done.
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const a1runs = runs.filter((r) => r.nodeId === 'a1').sort((a, b) => a.retryIndex - b.retryIndex)
    expect(a1runs.length).toBe(3)
    expect(a1runs[0]?.status).toBe('failed')
    expect(a1runs[1]?.status).toBe('failed')
    expect(a1runs[2]?.status).toBe('done')
  })

  test('node with retries=1 exhausts retries → task fails', async () => {
    await seedReadonlyAgent(h.db, 'persistent', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        {
          id: 'a1',
          kind: 'agent-single',
          agentName: 'persistent',
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    const counter = join(h.appHome, 'persistent-counter')
    await withEnv(
      {
        MOCK_OPENCODE_FAIL_COUNTER: counter,
        MOCK_OPENCODE_FAIL_UNTIL: '99', // never succeeds
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          // RFC-115: retry budget via runTask opts (was node.retries: 1).
          defaultNodeRetries: 1,
        }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.failedNodeId).toBe('a1')
    const runs = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === 'a1',
    )
    // retries=1 → 2 attempts total.
    expect(runs.length).toBe(2)
    expect(runs.every((r) => r.status === 'failed')).toBe(true)
  })

  // RFC-060 PR-E: agent-multi removed; the per-file fan-out + shard-key
  // ordering invariant is now exercised end-to-end via
  // scheduler-wrapper-fanout-e2e.test.ts (PR-D, wrapper-fanout). The
  // agent-multi-specific harness above is no longer applicable.

  test('wrapper-git emits changed-file path list as git_diff (RFC-060 PR-E list<path>)', async () => {
    // Build a real git repo to give the wrapper a meaningful baseline.
    const repoDir = h.worktreePath
    await runGit(repoDir, ['init', '-q', '-b', 'main'])
    await runGit(repoDir, ['config', 'user.email', 'test@example.com'])
    await runGit(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'src.txt'), 'baseline\n')
    await runGit(repoDir, ['add', '.'])
    await runGit(repoDir, ['commit', '-q', '-m', 'init'])

    await seedReadonlyAgent(h.db, 'writer', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'wA', kind: 'agent-single', agentName: 'writer' },
        { id: 'wrap', kind: 'wrapper-git', nodeIds: ['wA'] },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    // The writer must change the worktree DURING its own invocation: RFC-098
    // B3 (audit S-4) subtracts pre-existing dirt from git_diff, so the old
    // "pre-edit the worktree before runTask" simulation would now (correctly)
    // be excluded as pre-dirty. A runtime-generated shim opencode (the
    // scheduler-audit-s04 pattern) writes src.txt from inside the spawned
    // agent process — cwd is the task worktree.
    const shimPath = join(h.appHome, 'shim-opencode.ts')
    writeFileSync(
      shimPath,
      `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
writeFileSync(join(process.cwd(), 'src.txt'), 'after writer\\n')
const envl = '<workflow-output>\\n  <port name="summary">done</port>\\n</workflow-output>'
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: envl } }) +
    '\\n',
)
process.exit(0)
`,
    )

    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', shimPath],
    })
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    const wrapRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'wrap')))
    )[0]
    expect(wrapRun?.status).toBe('done')
    const diffPort = (
      await h.db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(eq(nodeRunOutputs.nodeRunId, wrapRun!.id), eq(nodeRunOutputs.portName, 'git_diff')),
        )
    )[0]
    // RFC-060 PR-E: git_diff is now a newline-separated path list, not a
    // unified diff. Assert the modified file appears in the list.
    const paths = (diffPort?.content ?? '').split('\n').filter((p) => p.length > 0)
    expect(paths).toContain('src.txt')
  })

  // RFC-060 PR-E: agent-multi removed; the empty-sourcePort short-circuit is
  // now exercised in scheduler-wrapper-fanout-e2e.test.ts case 1 ("empty
  // shardSource short-circuits to done with empty __done__ signal").

  // RFC-130 SUPERSEDES the pre-isolation "writers serialize through writeSem"
  // model. Two write agents at the same level now each run in their OWN isolated
  // worktree — their AGENT RUNS proceed in parallel (globalSem); only the brief
  // §段① snapshot + §段③ merge-back touch the canonical worktree under writeSem.
  // Wall-clock is therefore NOT a serialization signal here: with a mock agent that
  // only sleeps, the per-node iso git overhead (worktree add + snapshot + merge-back,
  // itself serialized) is the same order as the 250ms run, so elapsed is machine-
  // speed-dependent (it was RED on fast CI, green on slower local — a flake). We lock
  // the deterministic RFC-130 invariant instead: both writers complete AND each
  // cleanly merged its iso delta back into the canonical worktree (merge_state=
  // 'merged'), no shared-worktree corruption. The parallelism itself is wall-clock-
  // locked by the large-delay read-only test above.
  test('two write agents at the same level each run isolated and merge back cleanly', async () => {
    await seedReadonlyAgent(h.db, 'w1', ['summary'])
    await seedReadonlyAgent(h.db, 'w2', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'w1', kind: 'agent-single', agentName: 'w1' },
        { id: 'w2', kind: 'agent-single', agentName: 'w2' },
      ],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '250',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          maxConcurrentNodes: 4,
        }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    // Both writers reached done AND merged their iso delta back into canonical.
    // merge_state='merged' proves the isolate→merge-back path ran per node (a
    // shared-worktree run would leave it null / 'conflict-*' / 'merge-failed').
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    for (const name of ['w1', 'w2']) {
      const r = runs.find((x) => x.nodeId === name)
      expect(r?.status).toBe('done')
      expect(r?.mergeState).toBe('merged')
    }
  })
})

describe('runTask: loop wrapper (M4 P-4-01 / P-4-03)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('loop exits on iteration 0 when port-empty satisfied', async () => {
    await seedReadonlyAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 3,
          exitCondition: { kind: 'port-empty', nodeId: 'audit', portName: 'findings' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'audit', portName: 'findings' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv(
      // empty findings → exit condition met on iteration 0
      { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: '' }) },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    const loopRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    )[0]
    expect(loopRun?.status).toBe('done')
    const finalOut = (
      await h.db
        .select()
        .from(nodeRunOutputs)
        .where(and(eq(nodeRunOutputs.nodeRunId, loopRun!.id), eq(nodeRunOutputs.portName, 'final')))
    )[0]
    expect(finalOut?.content).toBe('')
    // Inner ran exactly once (iteration=0).
    const auditRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'audit')))
    expect(auditRuns.length).toBe(1)
    expect(auditRuns[0]?.iteration).toBe(0)
  })

  test('loop exhausted when exit condition never satisfied', async () => {
    await seedReadonlyAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'audit', portName: 'findings' },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: 'still failing' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorMessage).toContain('wrapper-loop-exhausted')
    const loopRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    )[0]
    expect(loopRun?.status).toBe('exhausted')
    // Inner ran twice — once per iteration.
    const auditRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'audit')))
    expect(auditRuns.length).toBe(2)
    expect(new Set(auditRuns.map((r) => r.iteration))).toEqual(new Set([0, 1]))
  })

  test('port-count-lt exit condition triggers when token count is below n', async () => {
    await seedReadonlyAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 3,
          exitCondition: {
            kind: 'port-count-lt',
            nodeId: 'audit',
            portName: 'findings',
            n: 5,
          },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv(
      // 3 newline-separated tokens, less than n=5 → exit on iter 0
      { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: 'a\nb\nc' }) },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    const auditRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'audit')))
    // Single iteration since exit condition met immediately.
    expect(auditRuns.length).toBe(1)
  })

  test('port-equals exit condition matches exact value', async () => {
    await seedReadonlyAgent(h.db, 'auditor', ['decision'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 3,
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'audit',
            portName: 'decision',
            value: 'OK',
          },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ decision: 'OK' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
  })

  test('nested wrapper-git inside wrapper-loop runs per iteration', async () => {
    // git-in-loop: inner wrapper-git is the only inner of the loop. Each
    // iteration runs the wrapper-git which runs its inner agent. We verify
    // both wrappers complete and the loop exits via the agent's output.
    const repoDir = h.worktreePath
    await runGit(repoDir, ['init', '-q', '-b', 'main'])
    await runGit(repoDir, ['config', 'user.email', 'test@example.com'])
    await runGit(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'src.txt'), 'baseline\n')
    await runGit(repoDir, ['add', '.'])
    await runGit(repoDir, ['commit', '-q', '-m', 'init'])

    await seedReadonlyAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        { id: 'wg', kind: 'wrapper-git', nodeIds: ['audit'] },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['wg'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'audit', portName: 'findings' },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: '' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    // Loop done after iter 0; wrapper-git ran once.
    const wgRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'wg')))
    expect(wgRuns.length).toBe(1)
    expect(wgRuns[0]?.status).toBe('done')
    expect(wgRuns[0]?.iteration).toBe(0)
  })
})

async function seedReadonlyAgent(db: DbClient, name: string, outputs: string[]): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}
