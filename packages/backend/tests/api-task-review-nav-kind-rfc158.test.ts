// RFC-395 II-pre：改接生产启动 / 读取路径，保留原断言意图。
// RFC-158 — locks taskNodeRunsProjection' per-review-run `reviewNavKind` stamping, the
// backend oracle the task-detail canvas uses to decide whether a review node is
// clickable (and to what). End-to-end against the DB.
//
// reviewNavKind = null unless the run has a RENDERABLE current round
// (selectCurrentReviewRound !== null ⟺ has a doc_version ⟺ getReviewDetail won't
// 404); then 'awaiting' if status=awaiting_review, else 'decided' iff the current
// round's representative is a HUMAN conclusion. The reversed findings from six
// design-gate rounds are pinned here as reachable-state regressions:
//   - empty `list<md>` review: awaiting_review + zero doc_version → null (R5)
//   - re-park-then-supersede: canceled + a newer pending version → null (R3)
//   - sibling cascade: current round decided by SYSTEM_DECIDER → null (R2a)
//   - reject/iterate reuse (pre re-park): pending run, current = human iterate → 'decided' (R1)

import { nodeRunFixture, taskFixture, workflowFixture } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskNodeRunsProjection } from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { SYSTEM_DECIDER } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

async function seedTaskAndWorkflow(db: PersistenceDb): Promise<{ taskId: string }> {
  const wfId = ulid()
  await workflowFixture(db, {
    id: wfId,
    name: 'wf',
    definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const taskId = ulid()
  await taskFixture(db, {
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
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId }
}

type RunStatus =
  | 'done'
  | 'awaiting_review'
  | 'running'
  | 'failed'
  | 'canceled'
  | 'pending'
  | 'interrupted'

async function seedRun(
  db: PersistenceDb,
  taskId: string,
  opts: {
    id?: string
    nodeId: string
    status?: RunStatus
    startedAt: number
    reviewIteration?: number
  },
): Promise<string> {
  const id = opts.id ?? ulid()
  await nodeRunFixture(db, {
    id,
    taskId,
    nodeId: opts.nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: opts.reviewIteration ?? 0,
    status: opts.status ?? 'done',
    startedAt: opts.startedAt,
    finishedAt: null,
  })
  return id
}

async function seedDocVersion(
  db: PersistenceDb,
  taskId: string,
  reviewNodeRunId: string,
  opts: {
    versionIndex: number
    decision: 'pending' | 'approved' | 'rejected' | 'iterated' | 'superseded'
    decidedBy?: string | null
    itemIndex?: number | null
    roundGeneration?: number | null
    reviewIteration?: number
    createdAt?: number
  },
): Promise<void> {
  const { docVersions } = tablesOf(db)
  await insertOne(db, docVersions, {
    id: ulid(),
    taskId,
    reviewNodeId: 'rev',
    reviewNodeRunId,
    sourceNodeId: 'agent',
    sourcePortName: 'docpath',
    versionIndex: opts.versionIndex,
    reviewIteration: opts.reviewIteration ?? 0,
    bodyPath: `reviews/rev/docpath/v${opts.versionIndex}.md`,
    decision: opts.decision,
    decidedBy: opts.decidedBy ?? null,
    itemIndex: opts.itemIndex ?? null,
    roundGeneration: opts.roundGeneration ?? null,
    createdAt: opts.createdAt ?? 1000 + opts.versionIndex,
    decidedAt: null,
  })
}

async function navKind(db: PersistenceDb, taskId: string, runId: string): Promise<unknown> {
  const res = await taskNodeRunsProjection({ db }, taskId)
  return res.runs.find((r) => r.id === runId)!.reviewNavKind ?? null
}

describeEachProvider('RFC-158 — taskNodeRunsProjection stamps reviewNavKind', (harness) => {
  let db: PersistenceDb
  beforeEach(() => {
    resetBroadcastersForTests()
    db = harness.db
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test("awaiting_review with a pending version → 'awaiting'", async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const rev = await seedRun(db, taskId, {
      nodeId: 'rev',
      status: 'awaiting_review',
      startedAt: 100,
    })
    await seedDocVersion(db, taskId, rev, { versionIndex: 1, decision: 'pending' })
    expect(await navKind(db, taskId, rev)).toBe('awaiting')
  })

  test('R5: empty list<md> review — awaiting_review but ZERO doc_version → null (never route to 404)', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const rev = await seedRun(db, taskId, {
      nodeId: 'rev',
      status: 'awaiting_review',
      startedAt: 100,
    })
    // no doc_versions at all
    expect(await navKind(db, taskId, rev)).toBeNull()
  })

  test('impl-gate: REOPENED empty list review — awaiting_review whose current representative is an OLD decided round (no new pending) → decided (production historical-round projection)', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    // A multi-doc review decided round 0 (human approved), then reopened; the new
    // upstream round is an empty list, so dispatch parks awaiting_review WITHOUT
    // minting a new pending doc_version. The current representative is the old
    // RFC-395 II-pre：生产投影按已有版本的当前代表轮读取，保留旧人工结论的 decided 导航。
    const rev = await seedRun(db, taskId, {
      nodeId: 'rev',
      status: 'awaiting_review',
      startedAt: 100,
      reviewIteration: 1,
    })
    await seedDocVersion(db, taskId, rev, {
      versionIndex: 1,
      itemIndex: 0,
      decision: 'approved',
      decidedBy: 'u1',
      reviewIteration: 0,
    })
    expect(await navKind(db, taskId, rev)).toBe('decided')
  })

  test("approved review (done) → 'decided'", async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const rev = await seedRun(db, taskId, { nodeId: 'rev', status: 'done', startedAt: 100 })
    await seedDocVersion(db, taskId, rev, {
      versionIndex: 1,
      decision: 'approved',
      decidedBy: 'u1',
    })
    expect(await navKind(db, taskId, rev)).toBe('decided')
  })

  test("R1: reject/iterate reuse pre re-park — pending run, current version = human iterate → 'decided'", async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    // Same row reused: awaiting_review → pending, reviewIteration bumped; the v1
    // is the human iterate decision and is still the latest version (no v2 yet).
    const rev = await seedRun(db, taskId, {
      nodeId: 'rev',
      status: 'pending',
      startedAt: 100,
      reviewIteration: 1,
    })
    await seedDocVersion(db, taskId, rev, {
      versionIndex: 1,
      decision: 'iterated',
      decidedBy: 'u1',
    })
    expect(await navKind(db, taskId, rev)).toBe('decided')
  })

  test('R3: re-park-then-supersede — canceled run whose current version is a NEW pending → null', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    // v1 human iterate, then re-parked v2 pending, then the run got canceled by
    // supersede. "Ever human" is true but the current (max versionIndex) version
    // is pending → not a decided view; must be null (not empty decided view).
    const rev = await seedRun(db, taskId, {
      nodeId: 'rev',
      status: 'canceled',
      startedAt: 100,
      reviewIteration: 1,
    })
    await seedDocVersion(db, taskId, rev, {
      versionIndex: 1,
      decision: 'iterated',
      decidedBy: 'u1',
    })
    await seedDocVersion(db, taskId, rev, { versionIndex: 2, decision: 'pending' })
    expect(await navKind(db, taskId, rev)).toBeNull()
  })

  test('R2a: sibling cascade — current round decided by SYSTEM_DECIDER → null', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    // A sibling reject stamped this never-human-reviewed run's version rejected
    // by the system and bumped reviewIteration.
    const rev = await seedRun(db, taskId, {
      nodeId: 'rev',
      status: 'pending',
      startedAt: 100,
      reviewIteration: 1,
    })
    await seedDocVersion(db, taskId, rev, {
      versionIndex: 1,
      decision: 'rejected',
      decidedBy: SYSTEM_DECIDER,
    })
    expect(await navKind(db, taskId, rev)).toBeNull()
  })

  test('non-review run (no doc_versions) → null', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const agent = await seedRun(db, taskId, { nodeId: 'agent', status: 'done', startedAt: 100 })
    expect(await navKind(db, taskId, agent)).toBeNull()
  })

  test('pending run with no human conclusion and no awaiting → null', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const rev = await seedRun(db, taskId, { nodeId: 'rev', status: 'pending', startedAt: 100 })
    await seedDocVersion(db, taskId, rev, { versionIndex: 1, decision: 'pending' })
    expect(await navKind(db, taskId, rev)).toBeNull()
  })

  test("multi-doc approved round decided by a human → 'decided'", async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const rev = await seedRun(db, taskId, { nodeId: 'rev', status: 'done', startedAt: 100 })
    await seedDocVersion(db, taskId, rev, {
      versionIndex: 1,
      itemIndex: 0,
      decision: 'approved',
      decidedBy: 'u1',
    })
    await seedDocVersion(db, taskId, rev, {
      versionIndex: 1,
      itemIndex: 1,
      decision: 'approved',
      decidedBy: 'u1',
    })
    expect(await navKind(db, taskId, rev)).toBe('decided')
  })
})
