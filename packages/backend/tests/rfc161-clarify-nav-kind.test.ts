// RFC-161 — locks getTaskNodeRuns' per-clarify-run `clarifyNavKind` stamping, the
// backend oracle the task-detail canvas uses to decide whether a clarify /
// cross-clarify node is clickable (and to what). End-to-end against the DB.
//
// clarifyNavKind = clarifyNavKindForRoundStatus(latest round by createdAt), then
// the 'awaiting' result is suppressed to null on a DEAD task (canceled/failed) —
// cancelTaskRow/failTask leave orphaned awaiting_human rounds behind. Null for
// non-clarify runs (no round) and canceled/abandoned rounds. The design-gate
// findings are pinned as regressions:
//   - orphaned awaiting on a canceled/failed task → null (Codex ②a)
//   - a clarify run with no round → null (would 404)
//   - the safety property: clarifyNavKind != null ⟹ getClarifyRoundDetail resolves.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import {
  clarifyNavKindForRoundStatus,
  type ClarifyRoundStatus,
  type NodeRunStatus,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { getTaskNodeRuns } from '../src/services/task'
import { getClarifyRoundDetail } from '../src/services/clarifyRounds'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

type TaskStatus = 'running' | 'awaiting_human' | 'canceled' | 'failed' | 'interrupted' | 'done'

async function seedTask(
  db: ProviderNeutralDatabase,
  status: TaskStatus = 'running',
): Promise<string> {
  const wfId = ulid()
  await db
    .insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ $schema_version: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  await db
    .insert(tasks)
    .values({
      // Preserve the exact task lineage formerly supplied by SQLite's retained INSERT trigger.
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
      ]),
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status,
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return taskId
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  opts: { id?: string; nodeId: string; status: NodeRunStatus; startedAt?: number },
): Promise<string> {
  const id = opts.id ?? ulid()
  await db
    .insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId: opts.nodeId,
      iteration: 0,
      retryIndex: 0,
      status: opts.status,
      startedAt: opts.startedAt ?? Date.now(),
      finishedAt: null,
    })
    .run()
  return id
}

const Q = [{ id: 'q1', title: 'Q?', kind: 'single', recommended: false, options: [] }]

async function seedRound(
  db: ProviderNeutralDatabase,
  taskId: string,
  opts: {
    id?: string
    intermediaryNodeRunId: string
    askingNodeRunId: string
    kind?: 'self' | 'cross'
    status: ClarifyRoundStatus
    createdAt: number
  },
): Promise<string> {
  const id = opts.id ?? ulid()
  await db
    .insert(clarifyRounds)
    .values({
      id,
      taskId,
      kind: opts.kind ?? 'self',
      askingNodeId: 'designer',
      askingNodeRunId: opts.askingNodeRunId,
      askingShardKey: null,
      intermediaryNodeId: 'clr',
      intermediaryNodeRunId: opts.intermediaryNodeRunId,
      targetConsumerNodeId: null,
      loopIter: 0,
      iteration: 0,
      questionsJson: JSON.stringify(Q),
      answersJson: opts.status === 'awaiting_human' ? null : JSON.stringify([]),
      directive: null,
      status: opts.status,
      createdAt: opts.createdAt,
    })
    .run()
  return id
}

/** stamp a single clarify node_run + its round, return the run's clarifyNavKind. */
async function navKindOf(
  db: ProviderNeutralDatabase,
  taskId: string,
  runOpts: { nodeId?: string; runStatus: NodeRunStatus },
  roundOpts?: { status: ClarifyRoundStatus; kind?: 'self' | 'cross' } | 'no-round',
): Promise<'awaiting' | 'answered' | null | undefined> {
  const asking = await seedRun(db, taskId, { nodeId: 'designer', status: 'done' })
  const runId = await seedRun(db, taskId, {
    nodeId: runOpts.nodeId ?? 'clr',
    status: runOpts.runStatus,
  })
  if (roundOpts !== undefined && roundOpts !== 'no-round') {
    await seedRound(db, taskId, {
      intermediaryNodeRunId: runId,
      askingNodeRunId: asking,
      status: roundOpts.status,
      kind: roundOpts.kind,
      createdAt: Date.now(),
    })
  }
  const { runs } = await getTaskNodeRuns(db, taskId)
  return runs.find((r) => r.id === runId)?.clarifyNavKind
}

describeEachProvider('RFC-161 getTaskNodeRuns clarifyNavKind stamping', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    resetBroadcastersForTests()
    db = harness.db
  })
  afterEach(() => resetBroadcastersForTests())

  test('awaiting self-clarify → awaiting', async () => {
    const taskId = await seedTask(db, 'awaiting_human')
    expect(
      await navKindOf(db, taskId, { runStatus: 'awaiting_human' }, { status: 'awaiting_human' }),
    ).toBe('awaiting')
  })

  test('answered self-clarify (run done) → answered', async () => {
    const taskId = await seedTask(db, 'running')
    expect(await navKindOf(db, taskId, { runStatus: 'done' }, { status: 'answered' })).toBe(
      'answered',
    )
  })

  test('canceled round → null', async () => {
    const taskId = await seedTask(db, 'running')
    expect(await navKindOf(db, taskId, { runStatus: 'canceled' }, { status: 'canceled' })).toBe(
      null,
    )
  })

  test('abandoned cross round → null', async () => {
    const taskId = await seedTask(db, 'running')
    expect(
      await navKindOf(db, taskId, { runStatus: 'failed' }, { status: 'abandoned', kind: 'cross' }),
    ).toBe(null)
  })

  test('clarify run with NO round → null (would 404, not clickable)', async () => {
    const taskId = await seedTask(db, 'running')
    expect(await navKindOf(db, taskId, { runStatus: 'done' }, 'no-round')).toBe(null)
  })

  test('non-clarify run (agent, no round) → null', async () => {
    const taskId = await seedTask(db, 'running')
    await seedRun(db, taskId, { nodeId: 'agent', status: 'done' })
    const { runs } = await getTaskNodeRuns(db, taskId)
    expect(runs[0]?.clarifyNavKind).toBe(null)
  })

  test('replay: two rounds on one run (older answered < newer awaiting) → createdAt-max = awaiting', async () => {
    const taskId = await seedTask(db, 'awaiting_human')
    const asking = await seedRun(db, taskId, { nodeId: 'designer', status: 'done' })
    const runId = await seedRun(db, taskId, { nodeId: 'clr', status: 'awaiting_human' })
    const t0 = Date.now()
    await seedRound(db, taskId, {
      intermediaryNodeRunId: runId,
      askingNodeRunId: asking,
      status: 'answered',
      createdAt: t0,
    })
    await seedRound(db, taskId, {
      intermediaryNodeRunId: runId,
      askingNodeRunId: asking,
      status: 'awaiting_human',
      createdAt: t0 + 5000,
    })
    const { runs } = await getTaskNodeRuns(db, taskId)
    expect(runs.find((r) => r.id === runId)?.clarifyNavKind).toBe('awaiting')
  })

  describe('orphaned awaiting gate (Codex ②a)', () => {
    test('canceled task + awaiting round → null (orphan suppressed)', async () => {
      const taskId = await seedTask(db, 'canceled')
      expect(
        await navKindOf(db, taskId, { runStatus: 'awaiting_human' }, { status: 'awaiting_human' }),
      ).toBe(null)
    })
    test('failed task + awaiting round → null (orphan suppressed)', async () => {
      const taskId = await seedTask(db, 'failed')
      expect(
        await navKindOf(db, taskId, { runStatus: 'awaiting_human' }, { status: 'awaiting_human' }),
      ).toBe(null)
    })
    test('interrupted task + awaiting round → awaiting (NOT gated; resumable)', async () => {
      const taskId = await seedTask(db, 'interrupted')
      expect(
        await navKindOf(db, taskId, { runStatus: 'awaiting_human' }, { status: 'awaiting_human' }),
      ).toBe('awaiting')
    })
    test('canceled task + answered round → answered (NOT gated; history viewable)', async () => {
      const taskId = await seedTask(db, 'canceled')
      expect(await navKindOf(db, taskId, { runStatus: 'done' }, { status: 'answered' })).toBe(
        'answered',
      )
    })
  })
})

// --- group 4: same-source pairing + the no-404 safety property -------------

describeEachProvider('RFC-161 stamp ↔ getClarifyRoundDetail (safety property)', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    resetBroadcastersForTests()
    db = harness.db
  })
  afterEach(() => resetBroadcastersForTests())

  test('clarifyNavKind != null ⟹ getClarifyRoundDetail resolves (no 404) + label matches', async () => {
    const taskId = await seedTask(db, 'running')
    const asking = await seedRun(db, taskId, { nodeId: 'designer', status: 'done' })
    const runId = await seedRun(db, taskId, { nodeId: 'clr', status: 'done' })
    await seedRound(db, taskId, {
      intermediaryNodeRunId: runId,
      askingNodeRunId: asking,
      status: 'answered',
      createdAt: Date.now(),
    })
    const { runs } = await getTaskNodeRuns(db, taskId)
    const stamp = runs.find((r) => r.id === runId)?.clarifyNavKind
    expect(stamp).not.toBe(null)
    // The safety property: a non-null stamp implies the bare /clarify/{run} route resolves.
    const detail = await getClarifyRoundDetail(db, runId)
    expect(detail).toBeDefined()
    // best-effort label alignment: stamp == clarifyNavKindForRoundStatus(detail.status).
    expect(stamp).toBe(clarifyNavKindForRoundStatus(detail.status))
  })
})
