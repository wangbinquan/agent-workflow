// LOCKS: RFC-096 (audit S-13 / 附录 C #7) — designer-rerun anchor row selection,
// re-homed onto the LIVE mint path by RFC-132 PR-E2.
//
// HISTORY: this file originally locked the legacy designer-rerun trigger (the
// cross-clarify immediate mint), whose RFC-096 fix replaced a SQL
// `desc(startedAt)` pick with the shared `pickFreshestRun(rows,
// { topLevelOnly: false })` (pure ULID id order). RFC-132 unified every
// clarify answer onto `autoDispatchClarifyRound` → `dispatchTaskQuestions`,
// whose `buildFrontierMintPlan` uses the SAME picker + the SAME
// `buildMintNodeRunValues` inheritance — so the lock migrates here, exercised
// through the live driver. The two pathologies it guards (red before the
// RFC-096 fix, and red again if the dispatch anchor ever regresses to a
// startedAt ordering):
//
//   1. NULL-startedAt sinks — freshly minted rerun rows carry startedAt NULL,
//      which sorts LAST under `desc(startedAt)`, so a stale old row would be
//      re-picked and anchor inheritance on the wrong generation.
//   2. mark-running startedAt rewrite — a resumed old row jumps to the front
//      of a startedAt order (simulated below by a HUGE startedAt on the stale
//      row), again hijacking the anchor.
//
// `topLevelOnly: false` is deliberate (NOT the picker default): a designer
// inside a wrapper-fanout lives on shard CHILD rows and its rerun must inherit
// shardKey + parentNodeRunId — the fixture's id-freshest row IS a child row,
// so this also locks the shard/parent passthrough the legacy
// cross-clarify-service test ('preserves shard_key + parent_node_run_id
// passthrough') used to cover.
//
// The picker's own predicate matrix stays behaviorally locked by
// rfc096-pick-freshest.test.ts; this file locks the dispatch-layer WIRING.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { listTaskQuestions, reassignTaskQuestion } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const Q = 'questioner'
const D = 'designer'
const CC = 'cc'

function fixtureDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: Q, kind: 'agent-single', agentName: 'agent-q' } as WorkflowNode,
    { id: D, kind: 'agent-single', agentName: 'agent-d' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: Q, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: D, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: Q, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

function mkQuestion(id: string): ClarifyQuestion {
  return {
    id,
    title: `Question ${id}`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `t_${ulid()}`
  const def = fixtureDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc096-designer-rerun-pick',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc096-designer-rerun-pick',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

// Monotonic seeded ids: seeding order = causal order = id order (the invariant
// production ULIDs provide). The dispatch anchor must follow THIS order, never
// startedAt.
async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: Partial<typeof nodeRuns.$inferInsert>,
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    ...fields,
  })
  return id
}

/** An ANSWERED cross round on CC (dual-written round + legacy session, the
 *  createClarifyRound shape). RFC-162: reconcile emits ONE questioner entry; a designer
 *  handler is added by an explicit reassign (see the test), then dispatched. Seeding the round
 *  `answered` lets the reassign-added designer pass the dispatch seal gate
 *  (assertRequestedEntriesSealed treats an answered round as sealed). */
async function seedAnsweredCrossRound(
  db: DbClient,
  taskId: string,
  questionerRunId: string,
): Promise<string> {
  const crossNodeRunId = await seedRun(db, taskId, CC, { status: 'awaiting_human' })
  const roundId = ulid()
  const common = {
    id: roundId,
    taskId,
    loopIter: 0,
    iteration: 0,
    questionsJson: JSON.stringify([mkQuestion('q1')]),
    answersJson: JSON.stringify([
      { questionId: 'q1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
    ]),
    directive: 'continue' as const,
    status: 'answered' as const,
  }
  await db.insert(clarifyRounds).values({
    ...common,
    kind: 'cross',
    askingNodeId: Q,
    askingNodeRunId: questionerRunId,
    intermediaryNodeId: CC,
    intermediaryNodeRunId: crossNodeRunId,
    targetConsumerNodeId: D,
  })
  return crossNodeRunId
}

async function loadRun(db: DbClient, id: string) {
  return (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]
}

describe('RFC-096 designer-rerun anchor — freshest-row pick via the unified dispatch (pure id order)', () => {
  test('core lock: the id-freshest NULL-startedAt CHILD row beats a stale top-level row with a huge startedAt; the minted designer rerun inherits shardKey + parentNodeRunId from it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)

    // Designer history, seeded oldest → newest (id order):
    //   1. fanout parent row (top-level container the child hangs off).
    //   2. STALE top-level row with a HUGE startedAt (pathology 2: a
    //      mark-running rewrite / any startedAt ordering would pick THIS).
    //   3. id-freshest CHILD row: startedAt NULL (pathology 1), carrying the
    //      shardKey + parentNodeRunId the rerun must inherit
    //      (topLevelOnly:false keeps it in the candidate set).
    const dParentId = await seedRun(db, taskId, D, {
      status: 'done',
      startedAt: 1_000,
      finishedAt: 2_000,
    })
    const staleId = await seedRun(db, taskId, D, {
      status: 'done',
      startedAt: 9_000_000_000_000_000,
      finishedAt: 9_000_000_000_000_001,
    })
    const freshChildId = await seedRun(db, taskId, D, {
      status: 'done',
      startedAt: null,
      parentNodeRunId: dParentId,
      shardKey: 'shard-a',
    })

    const questionerRunId = await seedRun(db, taskId, Q, { status: 'awaiting_human' })
    await seedAnsweredCrossRound(db, taskId, questionerRunId)

    // RFC-162 live driver: a cross round reconciles to ONE questioner entry (designer-by-default
    // deleted). Reassign it UPSTREAM to D to ADD a `designer` handler (default target D), then
    // dispatch that handler through the SAME dispatchTaskQuestions the board's 批量下发 uses —
    // buildFrontierMintPlan anchors the designer mint on pickFreshestRun(designer rows).
    const actor = { userId: 'u1', role: 'owner' as const }
    const questioner = (await listTaskQuestions(db, taskId)).find(
      (e) => e.roleKind === 'questioner',
    )!
    await reassignTaskQuestion(db, questioner.id, D, actor)
    const designer = (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!

    const res = await dispatchTaskQuestions(db, taskId, [designer.id], actor)

    const designerRerunId = res.reruns.find((r) => r.targetNodeId === D)?.nodeRunId
    expect(designerRerunId).toBeDefined()
    const rerun = await loadRun(db, designerRerunId!)
    expect(rerun?.nodeId).toBe(D)
    expect(rerun?.status).toBe('pending')
    expect(rerun?.rerunCause).toBe('cross-clarify-answer')
    // Anchored on the id-freshest CHILD row — NOT the huge-startedAt stale row
    // (which carries no shardKey/parent): inheritance proves the pick.
    expect(rerun?.shardKey).toBe('shard-a')
    expect(rerun?.parentNodeRunId).toBe(dParentId)
    expect(rerun?.iteration).toBe(0)
    // retry allocation is max(TOP-LEVEL rows at the anchor iteration)+1 — the
    // parent + stale top-level rows are both retryIndex 0 → the rerun gets 1.
    expect(rerun?.retryIndex).toBe(1)
    // Fresh mints never write startedAt (that is exactly why a startedAt
    // ordering mis-anchors) — the minted row itself keeps the invariant.
    expect(rerun?.startedAt).toBeNull()
    // The anchor row is untouched history.
    expect((await loadRun(db, freshChildId))?.status).toBe('done')
    expect((await loadRun(db, staleId))?.status).toBe('done')
  })
})
