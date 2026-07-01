// RFC-060 PR-D end-to-end — wrapper-fanout scheduler dispatch.
//
// Covers the three dispatch paths exposed in PR-D:
//
//   1. Empty shardSource → wrapper row immediately 'done', __done__ signal
//      port content is empty, no shard children are minted.
//   2. v1-unsupported inner-kind (agent-multi inside wrapper-fanout) →
//      wrapper row 'failed' with message wrapper-fanout-v1-unsupported-inner-kind
//      so the user gets a clear PR-D2 escalation path.
//   3. Non-empty shardSource + agent-single inner + aggregator → wrapper
//      row 'done', N shard children minted with shardKey set, aggregator
//      runs once and its renamed outputs land on the wrapper row.
//
// Tests 1 and 2 do NOT spawn opencode (the dispatch refuses before any
// runNode call). Test 3 uses MOCK_OPENCODE_OUTPUTS to fake one envelope per
// subprocess.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-fanout-'))
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
  outputs: string[],
  options: {
    role?: 'normal' | 'aggregator'
    outputWrapperPortNames?: Record<string, string>
    outputKinds?: Record<string, string>
  } = {},
): Promise<void> {
  const extra: Record<string, unknown> = {}
  if (options.role !== undefined) extra.role = options.role
  if (options.outputWrapperPortNames !== undefined) {
    extra.outputWrapperPortNames = options.outputWrapperPortNames
  }
  if (options.outputKinds !== undefined) {
    extra.outputKinds = options.outputKinds
  }
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

describe('wrapper-fanout end-to-end (D.T2 / D.T3 / D.T8 happy path)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('1. empty shardSource short-circuits to done with empty __done__ signal', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'inner', kind: 'agent-single', agentName: 'worker' },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'inp', portName: 'docs' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { docs: '' })
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })
    const t = await h.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(t[0]?.status).toBe('done')
    // wrapper-fanout row done + __done__ signal port empty
    const wrapperRow = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRow.length).toBe(1)
    expect(wrapperRow[0]?.status).toBe('done')
    const wrapperOuts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, wrapperRow[0]!.id))
    expect(wrapperOuts.find((o) => o.portName === '__done__')?.content).toBe('')
    // No shard children minted
    const allRuns = await h.db.select().from(nodeRuns)
    const innerRows = allRuns.filter((r) => r.nodeId === 'inner')
    expect(innerRows.length).toBe(0)
  })

  test('2. v1-unsupported inner-kind (wrapper-git inside) → wrapper failed with v1-unsupported-inner-kind', async () => {
    // RFC-060 PR-E: agent-multi was removed, so we exercise the v1-inner-kind
    // restriction using a nested wrapper-git instead — same rejection path
    // (wrapper-fanout-v1-unsupported-inner-kind) since v1 wrapper-fanout
    // inner subgraphs only accept agent-single.
    await seedAgent(h.db, 'worker', ['result'])
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        {
          id: 'inner',
          kind: 'wrapper-git',
          nodeIds: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'inp', portName: 'docs' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md' })
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })
    const t = await h.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(t[0]?.status).toBe('failed')
    const wrapperRow = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRow[0]?.status).toBe('failed')
    expect(wrapperRow[0]?.errorMessage ?? '').toContain('v1-unsupported-inner-kind')
  })

  test('3. agent-single inner + 2 shards → wrapper done with __done__ signal, 2 shard children minted with shardKey', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        {
          id: 'inner',
          kind: 'agent-single',
          agentName: 'worker',
          promptTemplate: 'Process {{doc}}',
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
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md' })
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'processed' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const t = await h.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(t[0]?.status).toBe('done')
    const wrapperRow = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRow[0]?.status).toBe('done')
    // 2 shard children with shardKey set to the path itself (path<md> family)
    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId === wrapperRow[0]!.id)
    expect(innerRows.length).toBe(2)
    expect(innerRows.map((r) => r.shardKey).sort()).toEqual(['a.md', 'b.md'])
    // Each shard child done
    for (const r of innerRows) {
      expect(r.status).toBe('done')
    }
    // wrapper outlet is __done__ (no aggregator)
    const wrapperOuts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, wrapperRow[0]!.id))
    expect(wrapperOuts.some((o) => o.portName === '__done__')).toBe(true)
  })

  test('4. aggregator inner agent runs once and its renamed outputs land on the wrapper row', async () => {
    // worker + agg share the same outputs[] schema ['result'] so a single
    // MOCK_OPENCODE_OUTPUTS envelope satisfies both. The aggregator's
    // outputWrapperPortNames renames its 'result' port to 'final' on the
    // wrapper outlet.
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
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'final-result' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const t = await h.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(t[0]?.status).toBe('done')
    const wrapperRow = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRow[0]?.status).toBe('done')
    const wrapperOuts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, wrapperRow[0]!.id))
    // Wrapper outlet renamed via outputWrapperPortNames: result → final
    expect(wrapperOuts.find((o) => o.portName === 'final')?.content).toBe('final-result')
    // Aggregator row minted as child of wrapper (parentNodeRunId set), shardKey=null
    const aggRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'aggNode'))
    ).filter((r) => r.parentNodeRunId === wrapperRow[0]!.id)
    expect(aggRows.length).toBe(1)
    expect(aggRows[0]?.shardKey).toBeNull()
    expect(aggRows[0]?.status).toBe('done')
  })

  test('5. cartesian guard fires when items × nested expectedShardCount > limit', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'inner', kind: 'agent-single', agentName: 'worker' },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'inp', portName: 'docs' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
      ],
    }
    // 6 items, cap at 3 → should fail.
    const taskId = await seedWorkflowAndTask(h, def, {
      docs: ['1.md', '2.md', '3.md', '4.md', '5.md', '6.md'].join('\n'),
    })
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      fanoutMaxShardTotal: 3,
    })
    const t = await h.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(t[0]?.status).toBe('failed')
    const wrapperRow = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'fan'))
    expect(wrapperRow[0]?.errorMessage ?? '').toContain('cartesian-exceeds-max')
    // No shard children minted (guard fired before dispatch).
    const innerRows = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'inner'))
    ).filter((r) => r.parentNodeRunId !== null)
    expect(innerRows.length).toBe(0)
  })
})
