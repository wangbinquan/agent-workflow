// RFC-056 patch 2026-05-25 — questioner cascade must not skip a clarify-only row.
//
// Live failure shape: production task 01KS86DPCSERV7S41GQA5Y81RN ended with
// `review-source-port-missing` on `rev_cbkatx` because its upstream questioner
// `agent_b48d63` had a `done` row at clarifyIteration=1 whose stdout was
// ONLY a `<workflow-clarify>` envelope (asking the designer questions) — no
// `<workflow-output>` and therefore no rows in `node_run_outputs`. After the
// second cross-clarify session continued, two independent layers failed to
// re-dispatch the questioner:
//
//   §2.1  cascadeDownstreamFromDesigner (crossClarify.ts:795-801) skipped the
//         questioner because its existing row's clarifyIteration matched
//         the cascade's `newCrossClarifyIteration` — but that row was the
//         clarify-only one that CAUSED the session, not a row that consumed
//         the answers.
//
//   §2.2  the legacy designer-rerun mint (crossClarify.ts:672) computed `newCci =
//         lastDesigner.cci + 1`. With designer rows at cci=0 and questioner at
//         cci=1 (the cascade-minted row from the FIRST session), the new
//         iteration came out =1 — equal to the questioner's existing cci,
//         triggering §2.1's skip.
//
//   §2.3  Five `db.insert(nodeRuns)` callsites (task.ts:690, clarify.ts:169 /
//         :406, review.ts:451 / :1335) silently default clarifyIteration
//         to 0. Any of them firing AFTER the questioner advances to cci ≥ 1
//         creates a zero-cci row that then gets picked as `latestExisting` by
//         scheduleAgentNode's freshest-row inheritance (keyed on
//         (clarifyIteration, retryIndex, id), NOT cci) — the cross-clarify
//         iteration regresses and Layer B's freshness invariant can't detect
//         the inversion (its guard only fires on `upstreamCci > myCci`).
//
// This file locks the three fixes (RFC-132: driven via the unified quick
// channel, autoDispatchClarifyRound):
//
//   - Behavioural Fix A + B (single shared scenario): the production graph,
//     seeded to the exact stuck state. After answering the round with
//     directive=continue, the designer gets a fresh pending row (Fix B) AND
//     the questioner gets its continuation rerun (Fix A — under RFC-132 the
//     questioner rerun is minted unconditionally by the unified dispatch, so
//     the original "cascade must not skip the clarify-only row" hazard is
//     structurally gone). Without either the test fails with the same
//     review-source-port-missing precondition the production task tripped on.
//
//   - Behavioural Fix C: answer a self-clarify round for an agent already at
//     cci=1 → exactly one fresh pending rerun is minted.
//
//   - Source-text guards Fix C (task.ts:690, review.ts:451 / :1335,
//     clarify.ts:169 — and the two crossClarify cascade idempotency lines).
//     These insert sites are easy to silently regress on a refactor; the
//     guards keep the inheritance lines visible to grep.
//
// If any of these go red, do NOT relax — re-read
// design/RFC-056-clarify-cross-agent/patch-2026-05-25-questioner-cascade-no-skip.md.

import { createClarifyRound } from '../src/services/clarify/service'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { insertLegacyCrossClarify } from './clarify-fixtures'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { listTaskQuestions, reassignTaskQuestion } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

// RFC-162: designer-by-default is DELETED — answering a cross round no longer auto-creates a
// designer entry. Fix B (the designer's own rerun after a continue) is now an explicit reassign of
// the answered round's questioner card to the graph designer node + a dispatch of that designer
// entry; the retry_index / freshness bump this file locks is minted by the SAME buildFrontierMintPlan.
async function reassignThenDispatchDesigner(
  db: DbClient,
  taskId: string,
  intermediaryNodeRunId: string,
) {
  const questioner = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'questioner' && e.originNodeRunId === intermediaryNodeRunId,
  )
  if (!questioner) throw new Error(`no questioner entry for round ${intermediaryNodeRunId}`)
  await reassignTaskQuestion(db, questioner.id, 'designer', actor)
  const designer = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'designer' && e.originNodeRunId === intermediaryNodeRunId,
  )
  if (!designer) throw new Error(`no designer entry after reassign for ${intermediaryNodeRunId}`)
  return dispatchTaskQuestions(db, taskId, [designer.id], actor)
}

function makeQ(id: string): ClarifyQuestion {
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

function makeAns(qid: string): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

// Mirrors the production graph from task 01KS86DPCSERV7S41GQA5Y81RN.
// in → designer → rev1 → questioner → rev2 → out + cross-clarify cycle.
function liveDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'rev1', kind: 'review', sourceNodeId: 'designer', sourcePortName: 'docpath' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'rev2', kind: 'review', sourceNodeId: 'questioner', sourcePortName: 'docpath' },
      { id: 'out', kind: 'output', ports: [] },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'designer', portName: 'requirement' },
      },
      {
        id: 'e_d_r1',
        source: { nodeId: 'designer', portName: 'docpath' },
        target: { nodeId: 'rev1', portName: 'src' },
      },
      {
        id: 'e_r1_q',
        source: { nodeId: 'rev1', portName: 'approved_doc' },
        target: { nodeId: 'questioner', portName: 'requirement' },
      },
      {
        id: 'e_q_r2',
        source: { nodeId: 'questioner', portName: 'docpath' },
        target: { nodeId: 'rev2', portName: 'src' },
      },
      {
        id: 'e_r2_out',
        source: { nodeId: 'rev2', portName: 'approved_doc' },
        target: { nodeId: 'out', portName: 'final' },
      },
      // cross-clarify channel — questioner asks designer
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
      {
        id: 'e_cross_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

// Same-shape but trimmed — used by the clarify-rerun Fix C test, which doesn't
// need the full review chain.
function selfClarifyDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'agent_x', kind: 'agent-single', agentName: 'agent_x' },
      { id: 'clarify_x', kind: 'clarify' },
    ],
    edges: [
      {
        id: 'e_in_x',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'agent_x', portName: 'requirement' },
      },
      {
        id: 'e_x_clarify',
        source: { nodeId: 'agent_x', portName: '__clarify__' },
        target: { nodeId: 'clarify_x', portName: 'questions' },
      },
      {
        id: 'e_clarify_x',
        source: { nodeId: 'clarify_x', portName: 'answers' },
        target: { nodeId: 'agent_x', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient, def: WorkflowDefinition): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'fixture',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-cascade-noskip',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<string> {
  const id = fields.id ?? `nr_${nodeId}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: now,
    finishedAt: now,
    ...fields,
  })
  return id
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 patch 2026-05-25 — questioner cascade no-skip + cci inheritance', () => {
  // -----------------------------------------------------------------------
  // §2.1 + §2.2 combined: production-shape behavioural lock.
  // -----------------------------------------------------------------------

  test('§2.1+§2.2 — questioner stuck at clarify-only cci=1 gets re-cascaded; designer rerun jumps to cci=2', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = liveDef()
    const taskId = await seedTask(db, def)

    // Production-shape DB state (mirrors 01KS86DPCSERV7S41GQA5Y81RN at the
    // moment HWDACF's continue arrives):
    //   designer  done @ cci=0, retryIndex=9 (with docpath in node_run_outputs)
    //   rev1      done @ cci=0
    //   questioner done @ cci=1 retryIndex=3, CLARIFY-ONLY (no outputs row)
    //   prior cross-clarify session at iteration=0 already answered + consumed
    //   new cross-clarify session at iteration=1 awaiting_human
    await seedRun(db, taskId, 'in', { id: 'in_v0' })
    const designerV0 = await seedRun(db, taskId, 'designer', {
      id: 'designer_v0',
      retryIndex: 9,
      preSnapshot: 'snap-designer-v0',
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: designerV0,
      portName: 'docpath',
      content: 'docs/tank-battle-design.md',
    })
    await seedRun(db, taskId, 'rev1', { id: 'rev1_v0' })
    const questionerV1 = await seedRun(db, taskId, 'questioner', {
      id: 'questioner_v1',
      retryIndex: 3,
      // RFC-064: under the unified counter, the questioner's prior round
      // sits at clarifyIteration=1 (was crossClarifyIteration=1 pre-unify).
      preSnapshot: 'snap-questioner-v1',
      // Intentionally no node_run_outputs row — this is the "emitted only
      // <workflow-clarify>" state the patch addresses.
    })

    // Prior session FH7895-equivalent (iteration=0 answered + consumed).
    // node_run for the cross-clarify node MUST exist before the session
    // row references it (FK).
    await db.insert(nodeRuns).values({
      id: 'cross1_iter0',
      taskId,
      nodeId: 'cross1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 120_000,
      finishedAt: Date.now() - 90_000,
    })
    await insertLegacyCrossClarify(db, {
      id: 'sess_iter0',
      taskId,
      crossClarifyNodeId: 'cross1',
      crossClarifyNodeRunId: 'cross1_iter0',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: questionerV1,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: JSON.stringify([makeQ('prior')]),
      answersJson: JSON.stringify([makeAns('prior')]),
      directive: 'continue',
      status: 'answered',
      designerRunTriggeredAt: Date.now() - 60_000,
      createdAt: Date.now() - 120_000,
      answeredAt: Date.now() - 90_000,
      abandonedAt: null,
    })

    // New session HWDACF-equivalent (iteration=1, awaiting_human, from
    // questioner_v1 emitting clarify).
    const sess = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: questionerV1,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('hwdacf')],
    })
    expect(sess.round.iteration).toBe(1)

    // User continues.
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.intermediaryNodeRunId,
      answers: [makeAns('hwdacf')],
      actor,
    })
    // RFC-162: the designer revision is an explicit reassign+dispatch of the answered round.
    const disp = await reassignThenDispatchDesigner(db, taskId, sess.intermediaryNodeRunId)
    expect(disp.reruns.some((r) => r.targetNodeId === 'designer')).toBe(true)

    // Fix B — designer rerun must jump to cci=2, NOT 1. With the pre-patch
    // `(lastDesigner.cci ?? 0) + 1` formula, lastDesigner picks designerV0
    // at cci=0 → newCci=1 → equals questioner.cci → §2.1 skip fires.
    const designerRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    const designerFresh = designerRows.find((r) => r.status === 'pending')
    expect(designerFresh, 'designer must have a fresh pending row after rerun').toBeDefined()
    // RFC-074 PR-C: the designer rerun is identified by being a fresh pending
    // insert (latest id), not by a clarifyIteration bump (counter retired).

    // RFC-132 (§6 delta 1): the questioner gets exactly ONE continuation rerun,
    // minted unconditionally by the unified dispatch (cause
    // 'cross-clarify-questioner-rerun') — the patch-25 "questioner must not be
    // stranded" intent, now guaranteed structurally instead of via cascade
    // no-skip logic. Rev-style downstream stays lazy (see
    // cross-clarify-downstream-cascade.test.ts); the underlying
    // review-source-port-missing risk is prevented at read time by
    // resolveUpstreamInputs' done-only freshest-row picker (B17).
    const qRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'questioner')))
    const qFresh = qRows.filter((r) => r.status === 'pending')
    expect(qFresh.length, 'exactly one questioner continuation rerun').toBe(1)
    expect(qFresh[0]?.rerunCause).toBe('cross-clarify-questioner-rerun')

    // Prior questioner_v1 row is left untouched.
    const qPriorRow = qRows.find((r) => r.id === questionerV1)
    expect(qPriorRow?.status).toBe('done')
  })

  // -----------------------------------------------------------------------
  // §2.3 — Fix C, clarify.ts:406 path (self-clarify rerun mint).
  // -----------------------------------------------------------------------

  test('§2.3 — answering a self-clarify round mints exactly one fresh rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = selfClarifyDef()
    const taskId = await seedTask(db, def)

    // Agent already advanced to cci=1 (e.g. from a prior cross-clarify
    // round), then emitted a self-clarify session. Seed:
    //   agent_x done @ cci=1
    //   self-clarify session awaiting_human pointing at that run
    const agentRunId = await seedRun(db, taskId, 'agent_x', {
      id: 'agent_x_v1',
      retryIndex: 0,
      preSnapshot: 'snap-x-v1',
    })

    const sess = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'agent_x',
      askingNodeRunId: agentRunId,
      askingShardKey: null,
      intermediaryNodeId: 'clarify_x',
      iteration: 0,
      questions: [makeQ('cx1')],
      truncationWarnings: [],
    })

    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.intermediaryNodeRunId,
      answers: [makeAns('cx1')],
      actor,
    })

    const rerunRows = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, 'agent_x'),
          eq(nodeRuns.status, 'pending'),
        ),
      )
    // RFC-074 PR-C: exactly one fresh pending rerun row is minted. Freshness is
    // pure id-order, so the rerun (latest insert) wins without a cci bump.
    expect(rerunRows.length).toBe(1)
  })

  // -----------------------------------------------------------------------
  // §2.1 — direct cascade lock: prior-iteration row must NOT count as
  // "already cascaded" when it's clarify-only.
  // -----------------------------------------------------------------------

  test('§2.1 (RFC-074/132) — a clarify-only questioner gets its continuation rerun; downstream stays lazy', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def = liveDef()
    const taskId = await seedTask(db, def)

    // Equivalent state to the §2.1+§2.2 test, but designer already advanced
    // to cci=1 too — so Fix B's max-aware bump gives newCci=2 naturally,
    // isolating Fix A's contribution: cascade walks questioner at cci=1
    // (clarify-only) and §2.1's output-aware idempotency must NOT skip it.
    await seedRun(db, taskId, 'in')
    const designerV1 = await seedRun(db, taskId, 'designer', {
      retryIndex: 5,
      preSnapshot: 'snap-d-v1',
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: designerV1,
      portName: 'docpath',
      content: 'docs/v1.md',
    })
    const questionerV1 = await seedRun(db, taskId, 'questioner', {
      retryIndex: 2,
      // Clarify-only — empty outputs.
    })

    const sess = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: questionerV1,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })

    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.intermediaryNodeRunId,
      answers: [makeAns('q1')],
      actor,
    })

    const qRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'questioner')))
    // RFC-074: no cascade row is minted; RFC-132 (§6 delta 1): the ONE pending row is
    // the questioner's unconditional continuation rerun (clarify channel), never an
    // eager downstream cascade. The clarify-only done row stays; downstream re-run is
    // lazy (scheduler freshness), and the empty-output row can never be mistaken for
    // the upstream content because resolveUpstreamInputs only reads DONE rows that
    // actually emit the port.
    const qFresh = qRows.filter((r) => r.status === 'pending')
    expect(qFresh.length, 'exactly one questioner continuation rerun').toBe(1)
    expect(qFresh[0]?.rerunCause).toBe('cross-clarify-questioner-rerun')
    expect(qRows.length, 'clarify-only done row + the continuation rerun').toBe(2)
  })

  // -----------------------------------------------------------------------
  // §2.3 source-text guards removed (RFC-074 PR-C): they asserted every
  // node_runs insert SET clarifyIteration and that the cascade computed a
  // max-aware cci bump — exactly the mechanics this RFC retires. Freshness is
  // pure id-order; there is no cci to preserve or bump.
})
