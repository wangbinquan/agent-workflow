// RFC-046 — locks the snapshot capture path added to memoryInject.ts:
//   - injectMemoryForRun returns { block, snapshot } (parity wired in
//     runner.ts at T4).
//   - the snapshot reflects the *post-budget-clip* set, byte-for-byte
//     aligned with what the block contains.
//   - tags JSON in memories.tags is parsed; malformed payload degrades
//     to [] without throwing.
//   - loadInjectedSnapshotFromFirstAttempt copies the attempt-0 row for
//     envelope-followup retries (RFC-042); NULL stays NULL.
//   - parseInjectedSnapshotJson defends against corrupt rows.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memories, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
  loadInjectableMemories,
  parseInjectedSnapshotJson,
} from '../src/services/memoryInject'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { Agent } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function mkAgent(id: string, name = id): Agent {
  return {
    id,
    name,
    description: '',
    model: 'sonnet',
    prompt: '',
    permission: {},
    tools: {},
    options: {},
    enabled: true,
    sourceKind: 'managed',
    bodyMd: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Agent
}

function seedTask(db: DbClient): { taskId: string; workflowId: string } {
  const workflowId = ulid()
  db.insert(workflows)
    .values({
      id: workflowId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 'fixture-task',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { taskId, workflowId }
}

function seedApproved(
  db: DbClient,
  opts: {
    scopeType: 'agent' | 'workflow' | 'repo' | 'global'
    scopeId: string | null
    title: string
    body?: string
    tags?: string
    version?: number
    sourceKind?: 'clarify' | 'review' | 'feedback' | 'manual'
    approvedAt?: number | null
    createdAt?: number
  },
): string {
  const id = ulid()
  db.insert(memories)
    .values({
      id,
      scopeType: opts.scopeType,
      scopeId: opts.scopeId,
      title: opts.title,
      bodyMd: opts.body ?? 'body',
      tags: opts.tags ?? '["t1","t2"]',
      status: 'approved',
      sourceKind: opts.sourceKind ?? 'review',
      version: opts.version ?? 1,
      approvedAt: opts.approvedAt ?? 1_700_000_000_000,
      createdAt: opts.createdAt ?? Date.now(),
    })
    .run()
  return id
}

describe('RFC-046 — injectMemoryForRun snapshot capture', () => {
  let db: DbClient
  beforeEach(() => {
    resetBroadcastersForTests()
    db = createInMemoryDb(MIGRATIONS)
  })

  test('B1: returns { block, snapshot } with all fields aligned to the source rows', async () => {
    const { taskId, workflowId } = seedTask(db)
    const memId = seedApproved(db, {
      scopeType: 'workflow',
      scopeId: workflowId,
      title: 'WF-A',
      body: 'hello-world',
      tags: '["foo","bar"]',
      version: 2,
      sourceKind: 'review',
      approvedAt: 1_700_000_000_000,
    })
    const out = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
    })
    expect(out.block).not.toBeNull()
    expect(out.block).toContain('- [workflow] WF-A — hello-world')
    expect(out.snapshot).not.toBeNull()
    expect(out.snapshot?.length).toBe(1)
    const s = out.snapshot![0]!
    expect(s.id).toBe(memId)
    expect(s.version).toBe(2)
    expect(s.scopeType).toBe('workflow')
    expect(s.scopeId).toBe(workflowId)
    expect(s.title).toBe('WF-A')
    expect(s.bodyMd).toBe('hello-world')
    expect(s.tags).toEqual(['foo', 'bar'])
    expect(s.sourceKind).toBe('review')
    expect(s.approvedAt).toBe(1_700_000_000_000)
  })

  test('B2: snapshot mirrors post-budget-clip set (rows dropped from block also missing from snapshot)', async () => {
    const { taskId } = seedTask(db)
    // Two global rows; budget is too tight to fit both. createdAt-DESC
    // order means the newer one survives, the older one is clipped.
    seedApproved(db, {
      scopeType: 'global',
      scopeId: null,
      title: 'KEEP',
      body: 'short',
      createdAt: 2_000_000_000_000,
    })
    seedApproved(db, {
      scopeType: 'global',
      scopeId: null,
      title: 'DROP',
      body: 'much longer body that pushes us beyond the budget for sure padding padding padding',
      createdAt: 1_000_000_000_000,
    })
    const out = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
      budget: { agent: 0, workflow: 0, repo: 0, global: 12 },
    })
    expect(out.block).toContain('KEEP')
    expect(out.block).not.toContain('DROP')
    expect(out.snapshot?.map((s) => s.title)).toEqual(['KEEP'])
  })

  test('B3: four-scope empty → block null AND snapshot null (in lock-step)', async () => {
    const { taskId } = seedTask(db)
    const out = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
    })
    expect(out.block).toBeNull()
    expect(out.snapshot).toBeNull()
  })

  test('B4: malformed tags JSON parsed to [] without throwing', async () => {
    const { taskId } = seedTask(db)
    seedApproved(db, {
      scopeType: 'global',
      scopeId: null,
      title: 'G',
      tags: '{not-an-array',
    })
    const out = await injectMemoryForRun({
      db,
      taskId,
      primaryAgent: mkAgent('agent-1'),
      dependents: [],
    })
    expect(out.snapshot).not.toBeNull()
    expect(out.snapshot?.[0]?.tags).toEqual([])
  })

  test('B5: loadInjectableMemories tolerates malformed tags JSON', async () => {
    const { workflowId } = seedTask(db)
    seedApproved(db, {
      scopeType: 'workflow',
      scopeId: workflowId,
      title: 'WF',
      tags: 'not-json-at-all',
    })
    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId,
      repoId: null,
    })
    expect(set.byScope.workflow.length).toBe(1)
    expect(set.byScope.workflow[0]!.tags).toEqual([])
  })
})

describe('RFC-046 — loadInjectedSnapshotFromFirstAttempt', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  function seedNodeRun(opts: {
    taskId: string
    nodeId: string
    retryIndex: number
    json: string | null
    iteration?: number
    shardKey?: string | null
    reviewIteration?: number
    // RFC-074 PR-C: explicit id lets multi-generation tests pin id-order
    // deterministically (the anchor walk is id-ordered); status lets a test
    // model a failed attempt (a followup retry's predecessor).
    id?: string
    status?: 'done' | 'failed' | 'pending' | 'running' | 'interrupted'
  }): string {
    const id = opts.id ?? ulid()
    db.insert(nodeRuns)
      .values({
        id,
        taskId: opts.taskId,
        nodeId: opts.nodeId,
        iteration: opts.iteration ?? 0,
        shardKey: opts.shardKey ?? null,
        retryIndex: opts.retryIndex,
        reviewIteration: opts.reviewIteration ?? 0,
        status: opts.status ?? 'done',
        injectedMemoriesJson: opts.json,
      })
      .run()
    return id
  }

  // Minimal valid InjectedMemorySnapshot[] JSON carrying a single id marker.
  function snapJson(marker: string): string {
    return JSON.stringify([
      {
        id: marker,
        version: 1,
        scopeType: 'agent',
        scopeId: 'a',
        title: marker,
        bodyMd: 'b',
        tags: [],
        sourceKind: 'manual',
        approvedAt: null,
      },
    ])
  }

  test('B6: returns parsed snapshot from retry_index=0 sibling', async () => {
    const { taskId } = seedTask(db)
    const payload = JSON.stringify([
      {
        id: 'm1',
        version: 1,
        scopeType: 'agent',
        scopeId: 'a',
        title: 't',
        bodyMd: 'b',
        tags: ['x'],
        sourceKind: 'review',
        approvedAt: 1,
      },
    ])
    const runId = seedNodeRun({ taskId, nodeId: 'agent-1', retryIndex: 0, json: payload })
    const snap = await loadInjectedSnapshotFromFirstAttempt(db, {
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      shardKey: null,
      reviewIteration: 0,
      runId,
    })
    expect(snap?.length).toBe(1)
    expect(snap?.[0]?.id).toBe('m1')
  })

  test('B7: attempt-0 column NULL → returns null (not throw)', async () => {
    const { taskId } = seedTask(db)
    const runId = seedNodeRun({ taskId, nodeId: 'agent-1', retryIndex: 0, json: null })
    const snap = await loadInjectedSnapshotFromFirstAttempt(db, {
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      shardKey: null,
      reviewIteration: 0,
      runId,
    })
    expect(snap).toBeNull()
  })

  test('B8: shardKey discriminates fan-out sibling rows', async () => {
    const { taskId } = seedTask(db)
    const payloadA = JSON.stringify([
      {
        id: 'mA',
        version: 1,
        scopeType: 'agent',
        scopeId: 'a',
        title: 'A',
        bodyMd: 'b',
        tags: [],
        sourceKind: 'manual',
        approvedAt: null,
      },
    ])
    const payloadB = JSON.stringify([
      {
        id: 'mB',
        version: 1,
        scopeType: 'agent',
        scopeId: 'a',
        title: 'B',
        bodyMd: 'b',
        tags: [],
        sourceKind: 'manual',
        approvedAt: null,
      },
    ])
    const runIdA = seedNodeRun({
      taskId,
      nodeId: 'agent-1',
      retryIndex: 0,
      shardKey: 'shard-a',
      json: payloadA,
    })
    const runIdB = seedNodeRun({
      taskId,
      nodeId: 'agent-1',
      retryIndex: 0,
      shardKey: 'shard-b',
      json: payloadB,
    })
    const snapA = await loadInjectedSnapshotFromFirstAttempt(db, {
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      shardKey: 'shard-a',
      reviewIteration: 0,
      runId: runIdA,
    })
    expect(snapA?.[0]?.id).toBe('mA')
    const snapB = await loadInjectedSnapshotFromFirstAttempt(db, {
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      shardKey: 'shard-b',
      reviewIteration: 0,
      runId: runIdB,
    })
    expect(snapB?.[0]?.id).toBe('mB')
  })

  // RFC-074 PR-C regression (T-C4a / design §6.4.1): the anchor must select the
  // generation START, not "the latest retry=0 row". A cross-clarify DESIGNER
  // rerun is minted at retryIndex = max+1 (triggerDesignerRerun) — NOT 0 — so
  // the retired retry=0 anchor resolved a designer rerun's followup to the PRIOR
  // generation's snapshot. The boundary walk (generation starts after a `done`
  // row) fixes it. This case is RED under the old anchor, GREEN under the new.
  test('B-RFC074a: designer rerun (retry=max+1) followup anchors to its own generation, not the prior', async () => {
    const { taskId } = seedTask(db)
    // gen 0: first design, done at retry=0.
    seedNodeRun({
      taskId,
      nodeId: 'designer',
      id: '01g0',
      retryIndex: 0,
      status: 'done',
      json: snapJson('g0'),
    })
    // gen 1: cross-clarify designer rerun minted at retry=max+1; its first
    // attempt ran inject (snapshot g1) then FAILED an envelope check.
    seedNodeRun({
      taskId,
      nodeId: 'designer',
      id: '02g1',
      retryIndex: 6,
      status: 'failed',
      json: snapJson('g1'),
    })
    // gen 1 envelope-followup retry — the row whose snapshot we resolve; it
    // copies from its generation's first attempt.
    const followupId = seedNodeRun({
      taskId,
      nodeId: 'designer',
      id: '03g1f',
      retryIndex: 7,
      status: 'pending',
      json: null,
    })
    const snap = await loadInjectedSnapshotFromFirstAttempt(db, {
      taskId,
      nodeId: 'designer',
      iteration: 0,
      shardKey: null,
      reviewIteration: 0,
      runId: followupId,
    })
    expect(snap?.[0]?.id).toBe('g1') // NOT 'g0' (the pre-fix regression)
  })

  // Self-clarify two-generation guard: generations must not bleed. (This shape
  // already worked under the old retry=0 anchor since self-clarify reruns mint
  // at retry=0 — kept as a non-regression lock alongside the designer case.)
  test('B-RFC074b: self-clarify generations do not bleed across the id boundary', async () => {
    const { taskId } = seedTask(db)
    seedNodeRun({
      taskId,
      nodeId: 'agent-1',
      id: '01a',
      retryIndex: 0,
      status: 'done',
      json: snapJson('gA'),
    })
    seedNodeRun({
      taskId,
      nodeId: 'agent-1',
      id: '02b',
      retryIndex: 0,
      status: 'failed',
      json: snapJson('gB'),
    })
    const followupId = seedNodeRun({
      taskId,
      nodeId: 'agent-1',
      id: '03bf',
      retryIndex: 1,
      status: 'pending',
      json: null,
    })
    const snap = await loadInjectedSnapshotFromFirstAttempt(db, {
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      shardKey: null,
      reviewIteration: 0,
      runId: followupId,
    })
    expect(snap?.[0]?.id).toBe('gB')
  })
})

describe('RFC-046 — parseInjectedSnapshotJson defensive parsing', () => {
  test('B9: malformed JSON → null (no throw)', () => {
    expect(parseInjectedSnapshotJson('{not-json')).toBeNull()
  })

  test('B10: non-array payload → null', () => {
    expect(parseInjectedSnapshotJson('{"a":1}')).toBeNull()
  })

  test('B11: array containing invalid items drops them silently', () => {
    const raw = JSON.stringify([
      {
        id: 'm1',
        version: 1,
        scopeType: 'agent',
        scopeId: 'a',
        title: 't',
        bodyMd: 'b',
        tags: [],
        sourceKind: 'manual',
        approvedAt: null,
      },
      { wrong: 'shape' },
      null,
    ])
    const parsed = parseInjectedSnapshotJson(raw)
    expect(parsed?.length).toBe(1)
    expect(parsed?.[0]?.id).toBe('m1')
  })

  test('B12: null input → null', () => {
    expect(parseInjectedSnapshotJson(null)).toBeNull()
  })
})
