// RFC-056 patch 2026-05-25 — questioner cascade must not skip a clarify-only row.
//
// Live failure shape: production task 01KS86DPCSERV7S41GQA5Y81RN ended with
// `review-source-port-missing` on `rev_cbkatx` because its upstream questioner
// `agent_b48d63` had a `done` row at crossClarifyIteration=1 whose stdout was
// ONLY a `<workflow-clarify>` envelope (asking the designer questions) — no
// `<workflow-output>` and therefore no rows in `node_run_outputs`. After the
// second cross-clarify session continued, two independent layers failed to
// re-dispatch the questioner:
//
//   §2.1  cascadeDownstreamFromDesigner (crossClarify.ts:795-801) skipped the
//         questioner because its existing row's crossClarifyIteration matched
//         the cascade's `newCrossClarifyIteration` — but that row was the
//         clarify-only one that CAUSED the session, not a row that consumed
//         the answers.
//
//   §2.2  triggerDesignerRerun (crossClarify.ts:672) computed `newCci =
//         lastDesigner.cci + 1`. With designer rows at cci=0 and questioner at
//         cci=1 (the cascade-minted row from the FIRST session), the new
//         iteration came out =1 — equal to the questioner's existing cci,
//         triggering §2.1's skip.
//
//   §2.3  Five `db.insert(nodeRuns)` callsites (task.ts:690, clarify.ts:169 /
//         :406, review.ts:451 / :1335) silently default crossClarifyIteration
//         to 0. Any of them firing AFTER the questioner advances to cci ≥ 1
//         creates a zero-cci row that then gets picked as `latestExisting` by
//         scheduleAgentNode's freshest-row inheritance (keyed on
//         (clarifyIteration, retryIndex, id), NOT cci) — the cross-clarify
//         iteration regresses and Layer B's freshness invariant can't detect
//         the inversion (its guard only fires on `upstreamCci > myCci`).
//
// This file locks the three fixes:
//
//   - Behavioural Fix A + B (single shared scenario): the production graph,
//     seeded to the exact stuck state. After `submitCrossClarifyAnswers`
//     directive=continue, the designer's new pending row has cci=2 (Fix B)
//     AND the questioner has a fresh pending row at retryIndex=max+1 (Fix A).
//     Without either fix the test fails with the same review-source-port-
//     missing precondition the production task tripped on.
//
//   - Behavioural Fix C (clarify.ts:406): submit a self-clarify answer for
//     an agent already at cci=1 → the rerun mint must carry cci=1, not 0.
//
//   - Source-text guards Fix C (task.ts:690, review.ts:451 / :1335,
//     clarify.ts:169 — and the two crossClarify cascade idempotency lines).
//     These insert sites are easy to silently regress on a refactor; the
//     guards keep the inheritance lines visible to grep.
//
// If any of these go red, do NOT relax — re-read
// design/RFC-056-clarify-cross-agent/patch-2026-05-25-questioner-cascade-no-skip.md.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifySessions,
  crossClarifySessions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const CROSS_CLARIFY_SOURCE = resolve(import.meta.dir, '..', 'src', 'services', 'crossClarify.ts')
const TASK_SOURCE = resolve(import.meta.dir, '..', 'src', 'services', 'task.ts')
const CLARIFY_SOURCE = resolve(import.meta.dir, '..', 'src', 'services', 'clarify.ts')
const REVIEW_SOURCE = resolve(import.meta.dir, '..', 'src', 'services', 'review.ts')

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
    clarifyIteration: 0,
    crossClarifyIteration: 0,
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
      crossClarifyIteration: 1,
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
      crossClarifyIteration: 0,
      startedAt: Date.now() - 120_000,
      finishedAt: Date.now() - 90_000,
    })
    await db.insert(crossClarifySessions).values({
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
    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: questionerV1,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('hwdacf')],
    })
    expect(sess.session.iteration).toBe(1)

    // User continues.
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('hwdacf')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')

    // Fix B — designer rerun must jump to cci=2, NOT 1. With the pre-patch
    // `(lastDesigner.cci ?? 0) + 1` formula, lastDesigner picks designerV0
    // at cci=0 → newCci=1 → equals questioner.cci → §2.1 skip fires.
    const designerRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    const designerFresh = designerRows.find((r) => r.status === 'pending')
    expect(designerFresh, 'designer must have a fresh pending row after rerun').toBeDefined()
    expect(
      designerFresh?.crossClarifyIteration,
      'Fix B — designer rerun cci must be max(designer.cci, questioner.cci) + 1 = 2',
    ).toBe(2)

    // Fix A — questioner must have a fresh pending row at retryIndex >
    // existing max (i.e. > 3). Without the patch, cascade idempotency at
    // crossClarify.ts:799 sees questioner_v1.cci=1 satisfying `>= newCci`
    // (even if newCci is correctly bumped to 2 it would still pass with the
    // new logic; but with Fix B's max-aware bump and Fix A's output-aware
    // idempotency, both conditions cooperate to mint).
    const qRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'questioner')))
    const qFresh = qRows.find((r) => r.status === 'pending')
    expect(
      qFresh,
      'Fix A — questioner must get a fresh pending row even though its prior cci=1 row exists (it was clarify-only)',
    ).toBeDefined()
    expect(
      (qFresh?.retryIndex ?? -1) > 3,
      'questioner retryIndex must beat existing max so isFresherNodeRun picks it',
    ).toBe(true)
    expect(qFresh?.crossClarifyIteration, 'questioner cascade row carries the bumped cci=2').toBe(2)

    // Sanity: prior questioner_v1 row is preserved (append-only).
    const qPriorRow = qRows.find((r) => r.id === questionerV1)
    expect(qPriorRow?.status).toBe('done')
    expect(qPriorRow?.crossClarifyIteration).toBe(1)
  })

  // -----------------------------------------------------------------------
  // §2.3 — Fix C, clarify.ts:406 path (self-clarify rerun mint).
  // -----------------------------------------------------------------------

  test('§2.3 — submitClarifyAnswers rerun mint preserves crossClarifyIteration', async () => {
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
      clarifyIteration: 0,
      crossClarifyIteration: 1,
      preSnapshot: 'snap-x-v1',
    })

    const sess = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'agent_x',
      sourceAgentNodeRunId: agentRunId,
      sourceShardKey: null,
      clarifyNodeId: 'clarify_x',
      iterationIndex: 0,
      questions: [makeQ('cx1')],
      truncationWarnings: [],
    })

    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: sess.clarifyNodeRunId,
      answers: [makeAns('cx1')],
      directive: 'continue',
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
    expect(rerunRows.length).toBe(1)
    expect(
      rerunRows[0]?.crossClarifyIteration,
      'Fix C — clarify.ts:406 rerun mint must inherit crossClarifyIteration from source row',
    ).toBe(1)
    // Sanity: clarifyIteration bumps as before.
    expect(rerunRows[0]?.clarifyIteration).toBe(1)
  })

  // -----------------------------------------------------------------------
  // §2.1 — direct cascade lock: prior-iteration row must NOT count as
  // "already cascaded" when it's clarify-only.
  // -----------------------------------------------------------------------

  test('§2.1 — cascade does not skip a questioner whose prior row at target cci has empty node_run_outputs', async () => {
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
      crossClarifyIteration: 1,
      preSnapshot: 'snap-d-v1',
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: designerV1,
      portName: 'docpath',
      content: 'docs/v1.md',
    })
    await seedRun(db, taskId, 'rev1', { crossClarifyIteration: 1 })
    const questionerV1 = await seedRun(db, taskId, 'questioner', {
      retryIndex: 2,
      crossClarifyIteration: 1,
      // Clarify-only — empty outputs.
    })

    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: questionerV1,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })

    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })

    const qRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'questioner')))
    const qFresh = qRows.find((r) => r.status === 'pending')
    expect(
      qFresh,
      'cascade must mint a fresh questioner pending row even though prior row carries target cci (it had no outputs)',
    ).toBeDefined()
  })

  // -----------------------------------------------------------------------
  // §2.3 — source-text guards for every insert site enumerated in the patch.
  // -----------------------------------------------------------------------

  describe('§2.3 source-text guards — every node_runs insert preserves crossClarifyIteration', () => {
    test('crossClarify.ts:799 idempotency uses output existence, not bare cci comparison', () => {
      const src = readFileSync(CROSS_CLARIFY_SOURCE, 'utf8')
      // The new guard either consults `nodeRunOutputs` directly, or uses a
      // helper named with `hasDataOutput` / `dataOutputs` / similar. We
      // match either shape to keep the lock semantic (the patch document
      // says "at least one row at the target iteration has produced a
      // non-clarify output port") rather than syntactic.
      const cascadeWindow = src.match(/async function cascadeDownstreamFromDesigner[\s\S]*?\n\}\n/)
      expect(cascadeWindow, 'cascadeDownstreamFromDesigner must exist').not.toBeNull()
      const body = cascadeWindow?.[0] ?? ''
      expect(
        /nodeRunOutputs|node_run_outputs|hasDataOutput|dataOutputs/.test(body),
        'cascade idempotency must consult node_run_outputs (not just compare cci numbers)',
      ).toBe(true)
    })

    test('task.ts:690 retry-from-interrupt placeholder inserts crossClarifyIteration', () => {
      const src = readFileSync(TASK_SOURCE, 'utf8')
      // The retry-from-interrupt mint is the only insert(nodeRuns) in
      // task.ts; the post-patch values block must contain
      // `crossClarifyIteration:`.
      const insertWindow = src.match(/\.insert\(nodeRuns\)\s*\.values\(\{[\s\S]*?\}\)/)
      expect(insertWindow, 'task.ts must contain an insert(nodeRuns) block').not.toBeNull()
      expect(insertWindow?.[0].includes('crossClarifyIteration'), insertWindow?.[0]).toBe(true)
    })

    test('clarify.ts:169 + :406 clarify-related inserts include crossClarifyIteration', () => {
      const src = readFileSync(CLARIFY_SOURCE, 'utf8')
      const insertMatches = src.match(/\.insert\(nodeRuns\)\s*\.values\(\{[\s\S]*?\}\)/g)
      expect(insertMatches, 'clarify.ts must contain insert(nodeRuns) blocks').not.toBeNull()
      for (const block of insertMatches ?? []) {
        expect(block.includes('crossClarifyIteration'), block).toBe(true)
      }
    })

    test('review.ts:451 + :1335 review-related inserts include crossClarifyIteration', () => {
      const src = readFileSync(REVIEW_SOURCE, 'utf8')
      const insertMatches = src.match(/\.insert\(nodeRuns\)\s*\.values\(\{[\s\S]*?\}\)/g)
      expect(insertMatches, 'review.ts must contain insert(nodeRuns) blocks').not.toBeNull()
      for (const block of insertMatches ?? []) {
        expect(block.includes('crossClarifyIteration'), block).toBe(true)
      }
    })

    test('crossClarify.ts newCci computation is max-aware (designer + questioner + session)', () => {
      const src = readFileSync(CROSS_CLARIFY_SOURCE, 'utf8')
      const triggerWindow = src.match(/export async function triggerDesignerRerun[\s\S]*?\nexport /)
      expect(triggerWindow, 'triggerDesignerRerun must exist').not.toBeNull()
      const body = triggerWindow?.[0] ?? ''
      // The new computation either uses `Math.max(...)` with multiple
      // sources, or a named helper like `computeNextCrossClarifyIteration`.
      // A bare `(lastDesigner.crossClarifyIteration ?? 0) + 1` is the
      // pre-patch shape and must NOT be the sole driver of the cascade
      // newCci value.
      expect(
        /Math\.max|computeNext|maxCrossClarify/i.test(body),
        'triggerDesignerRerun newCci must max across designer + questioner (not just lastDesigner.cci + 1)',
      ).toBe(true)
    })
  })
})

// Avoid unused-import warning for clarifySessions when the test layout is
// rearranged in a follow-up.
void clarifySessions
