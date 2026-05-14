// End-to-end scheduler tests for one task (P-1-14).
// Bypasses startTask's worktree creation by inserting the task row directly —
// real worktree creation is exercised in tasks.test.ts.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-sched-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
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
    readonly: true,
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
  beforeEach(() => {
    h = buildHarness()
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
          source: { nodeId: 'in', portName: 'out' },
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
    expect(inOutputs[0]?.portName).toBe('out')
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

  test('wrapper kinds rejected as M3 unsupported', async () => {
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

  test('output nodes are skipped at run time (used by detail page)', async () => {
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

    // The output node did NOT create a node_run.
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.find((r) => r.nodeId === 'o')).toBeUndefined()
    expect(runs.find((r) => r.nodeId === 'a')?.status).toBe('done')
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
          source: { nodeId: 'in1', portName: 'out' },
          target: { nodeId: 'a', portName: 'requirement' },
        },
        {
          id: 'e2',
          source: { nodeId: 'in2', portName: 'out' },
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
    await seedReadonlyAgent(h.db, 'r1', ['summary'], true)
    await seedReadonlyAgent(h.db, 'r2', ['summary'], true)
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
    const t0 = Date.now()
    await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '300',
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
    const elapsed = Date.now() - t0
    // Two 300ms read-only nodes running in parallel should finish closer to
    // 300ms than 600ms. Give the runtime + Bun.spawn some slack.
    expect(elapsed).toBeLessThan(550)
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
  })

  test('node with retries=2 fails twice then succeeds', async () => {
    await seedReadonlyAgent(h.db, 'flaky', ['summary'], true)
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        {
          id: 'a1',
          kind: 'agent-single',
          agentName: 'flaky',
          retries: 2,
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
    await seedReadonlyAgent(h.db, 'persistent', ['summary'], true)
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        {
          id: 'a1',
          kind: 'agent-single',
          agentName: 'persistent',
          retries: 1,
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

  test('agent-multi fans out per-file and aggregates outputs sorted by shard_key', async () => {
    await seedReadonlyAgent(h.db, 'src', ['git_diff'], true)
    await seedReadonlyAgent(h.db, 'auditor', ['findings'], true)
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        { id: 'src', kind: 'agent-single', agentName: 'src' },
        {
          id: 'audit',
          kind: 'agent-multi',
          agentName: 'auditor',
          sourcePort: { nodeId: 'src', portName: 'git_diff' },
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'out' },
          target: { nodeId: 'src', portName: 'requirement' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { requirement: 'audit two files' })

    // src outputs a 2-file diff; auditor returns "findings" per shard.
    const TWO_FILE_DIFF = [
      'diff --git a/src/a.ts b/src/a.ts',
      '@@ -1 +1 @@',
      '-1',
      '+1',
      'diff --git a/src/b.ts b/src/b.ts',
      '@@ -1 +1 @@',
      '-2',
      '+2',
    ].join('\n')

    // For src node we want it to emit the diff; for auditor we want
    // distinct findings per shard. The mock returns the same body each
    // invocation, so per-shard divergence is harder — what we can verify
    // is the aggregation joins by shard_key dictionary order.
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({
          git_diff: TWO_FILE_DIFF,
          findings: 'audited',
        }),
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

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // parent (audit) + 2 children + src + in = 5 rows.
    const auditRuns = runs.filter((r) => r.nodeId === 'audit')
    expect(auditRuns.length).toBe(3) // parent + 2 children
    const parent = auditRuns.find((r) => r.parentNodeRunId === null)
    const children = auditRuns.filter((r) => r.parentNodeRunId !== null)
    expect(parent).toBeDefined()
    expect(children.length).toBe(2)
    expect(new Set(children.map((c) => c.shardKey))).toEqual(new Set(['src/a.ts', 'src/b.ts']))

    // Aggregated findings = "audited\naudited" (2 children, sorted).
    const findings = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(and(eq(nodeRunOutputs.nodeRunId, parent!.id), eq(nodeRunOutputs.portName, 'findings')))
    expect(findings[0]?.content).toBe('audited\naudited')

    // No failures → errors port is empty.
    const errors = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(and(eq(nodeRunOutputs.nodeRunId, parent!.id), eq(nodeRunOutputs.portName, 'errors')))
    expect(errors[0]?.content).toBe('')
  })

  test('agent-multi with empty sourcePort completes immediately', async () => {
    await seedReadonlyAgent(h.db, 'src', ['git_diff'], true)
    await seedReadonlyAgent(h.db, 'auditor', ['findings'], true)
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'src', kind: 'agent-single', agentName: 'src' },
        {
          id: 'audit',
          kind: 'agent-multi',
          agentName: 'auditor',
          sourcePort: { nodeId: 'src', portName: 'git_diff' },
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv(
      {
        // Empty diff → fan-out short-circuit to done with empty outputs.
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ git_diff: '', findings: '' }),
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
    const auditRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'audit')))
    // No children for an empty diff.
    expect(auditRuns.length).toBe(1)
    expect(auditRuns[0]?.parentNodeRunId).toBeNull()
  })

  test('two write agents at the same level serialize through the write semaphore', async () => {
    await seedReadonlyAgent(h.db, 'w1', ['summary'], false)
    await seedReadonlyAgent(h.db, 'w2', ['summary'], false)
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
    const t0 = Date.now()
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
    const elapsed = Date.now() - t0
    // Two 250ms writers must serialize → at least ~500ms wall clock.
    expect(elapsed).toBeGreaterThan(450)
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
  })
})

async function seedReadonlyAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  readonly: boolean,
): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}
