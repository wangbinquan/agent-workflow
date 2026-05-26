// Regression — self-clarify rerun on a designer node that ALSO has a
// `__external_feedback__` (cross-clarify) edge wired must not age out its
// own earlier self-clarify rounds.
//
// Live failure shape (task 01KSHB1YHMZWFX85SHQ4KM2HKX, workflow "贪吃蛇"):
//   * `agent_m7p3n1` (designer) has BOTH a self-clarify channel
//     (`__clarify__` → `clarify_400qzp:questions`) AND a cross-clarify
//     designer input (`cross_clarify_6c910f:to_designer` →
//     `__external_feedback__`).
//   * The user asked Round 0 / Round 1 via self-clarify and answered each
//     time. No `node_run_outputs` row was ever written (the agent only ever
//     emitted `<workflow-clarify>`, never `<workflow-output>`). No
//     `cross_clarify_sessions` row exists either — the cross-clarify
//     branch was never activated because the questioner upstream hadn't
//     finished yet.
//   * On the Round 2 rerun (`clarifyIteration=2`), the scheduler's
//     `historyCutoffClarifyIteration` resolution at scheduler.ts:1524 fell
//     back to `priorDoneDesigner?.clarifyIteration` (= 1) purely because
//     `hasExternalFeedbackChannel === true` on the topology, even though no
//     actual cross-clarify activity took place. `applyAgingCutoff` then
//     dropped Round 0 from the rendered prompt → the agent's next reply
//     was crafted blind to the very first round of Q&A, repeating /
//     contradicting decisions the user had already pinned down.
//
// The root cause: `priorDoneDesigner.clarifyIteration` was being used as a
// fallback for the GENERAL aging cutoff. The GENERAL rule is correctly
// computed by `computeHistoryCutoff` and is grounded on a single signal —
// presence of `node_run_outputs` rows. When a prior done run has no
// outputs (because it only asked questions), no rounds were folded into
// any output, so there is NOTHING to age out. Falling back to
// `priorDoneDesigner.clarifyIteration` ignores this — it ages out rounds
// against a "draft" that never existed.
//
// This file locks the fix on three lines of defence:
//   1. Direct `computeHistoryCutoff` call on the live-shape DB state
//      returns undefined — proves the GENERAL rule is correct.
//   2. Behavioural: `buildPromptContext` for the Round 2 rerun yields
//      BOTH `### Round 1` AND `### Round 2` headers (i.e. iter=0 + iter=1
//      rounds both survive, rendered as Round 1 / Round 2 per
//      `iteration + 1` labelling).
//   3. Source-text grep on scheduler.ts: the `historyCutoffClarifyIteration`
//      assignment must NOT contain the legacy `?? priorDoneDesigner?.clarifyIteration`
//      fallback. If a future refactor reintroduces it, this catches it
//      before runtime.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
import { buildPromptContext, computeHistoryCutoff } from '../src/services/clarifyRounds'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCHEDULER_SOURCE_PATH = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')

/**
 * Workflow with the exact topology that triggered the bug — a designer
 * agent wired to BOTH a self-clarify node AND a cross-clarify designer
 * input port. `agentHasExternalFeedbackChannel` returns true based on the
 * `__external_feedback__` edge alone, regardless of whether cross-clarify
 * ever fires at runtime.
 */
function bugTopologyDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'requirement' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'clarify1', kind: 'clarify', title: 'Self clarify' },
      { id: 'cross1', kind: 'clarify-cross-agent', title: 'Cross clarify' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'designer', portName: 'requirement' },
      },
      // Designer's self-clarify channel (the one that ACTUALLY fires here).
      {
        id: 'e_d_clarify',
        source: { nodeId: 'designer', portName: '__clarify__' },
        target: { nodeId: 'clarify1', portName: 'questions' },
      },
      {
        id: 'e_clarify_d',
        source: { nodeId: 'clarify1', portName: 'answers' },
        target: { nodeId: 'designer', portName: '__clarify_response__' },
      },
      // Designer's cross-clarify designer input — wired topologically but
      // never activated in this fixture (questioner hasn't run yet, no
      // cross_clarify_sessions row exists).
      {
        id: 'e_cross_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
      // Questioner's cross-clarify wiring (kept consistent with the live
      // workflow shape; irrelevant to the bug under test).
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

async function seedTaskWithBugTopology(
  db: DbClient,
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const definition = bugTopologyDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'cutoff-no-cross-fallback',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'cutoff-no-cross-fallback',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-cutoff-no-cross-fallback',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({ requirement: '生成贪吃蛇游戏设计' }),
    startedAt: Date.now(),
  })
  return { taskId, definition }
}

function makeQ(id: string, title: string): ClarifyQuestion {
  return {
    id,
    title,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid: string): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

/**
 * Reproduce the exact node_runs + clarify_rounds state from the live task.
 * Returns the about-to-run row id (status=pending, clarifyIteration=2).
 */
async function seedTwoAnsweredSelfClarifyRoundsNoOutputs(
  db: DbClient,
  taskId: string,
): Promise<{ pendingRerunNodeRunId: string }> {
  // Round 0: designer asks self-clarify, user answers. Mints a new designer
  // row at clarifyIteration=1.
  const designerRound0NodeRunId = 'nr_designer_iter0'
  await db.insert(nodeRuns).values({
    id: designerRound0NodeRunId,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: 0,
    startedAt: Date.now() - 5000,
    finishedAt: Date.now() - 4500,
  })
  const { clarifyNodeRunId: clarifyNrIter0 } = await createClarifySession({
    db,
    taskId,
    sourceAgentNodeId: 'designer',
    sourceAgentNodeRunId: designerRound0NodeRunId,
    sourceShardKey: null,
    clarifyNodeId: 'clarify1',
    iterationIndex: 0,
    questions: [makeQ('platform', '游戏运行平台是什么？')],
  })
  await submitClarifyAnswers({
    db,
    clarifyNodeRunId: clarifyNrIter0,
    answers: [makeAns('platform')],
    directive: 'continue',
    ifMatchIteration: 0,
  })

  // The submit just minted a fresh designer pending row at
  // clarifyIteration=1. Promote it to done (no outputs — it asked another
  // round) to set up Round 1.
  const promoteDesignerToDone = async (clarifyIteration: number, lookbackMs: number) => {
    const recentPending = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const target = recentPending.find(
      (r) =>
        r.nodeId === 'designer' &&
        r.clarifyIteration === clarifyIteration &&
        r.status === 'pending',
    )
    if (target === undefined) {
      throw new Error(`expected pending designer row at clarifyIteration=${clarifyIteration}`)
    }
    await db
      .update(nodeRuns)
      .set({
        status: 'done',
        startedAt: Date.now() - lookbackMs,
        finishedAt: Date.now() - lookbackMs + 100,
      })
      .where(eq(nodeRuns.id, target.id))
    return target.id
  }
  const designerRound1NodeRunId = await promoteDesignerToDone(1, 3000)

  // Round 1: designer at clarifyIteration=1 asks AGAIN, user answers.
  const { clarifyNodeRunId: clarifyNrIter1 } = await createClarifySession({
    db,
    taskId,
    sourceAgentNodeId: 'designer',
    sourceAgentNodeRunId: designerRound1NodeRunId,
    sourceShardKey: null,
    clarifyNodeId: 'clarify1',
    iterationIndex: 1,
    questions: [makeQ('q5_diagrams', '设计文档是否需要包含可视化图表？')],
  })
  await submitClarifyAnswers({
    db,
    clarifyNodeRunId: clarifyNrIter1,
    answers: [makeAns('q5_diagrams')],
    directive: 'continue',
    ifMatchIteration: 1,
  })

  // The Round 1 submit just minted the designer's pending row at
  // clarifyIteration=2. This is the "about to rerun" row whose prompt
  // assembly is where the bug fires.
  const recent = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const pending = recent.find(
    (r) => r.nodeId === 'designer' && r.clarifyIteration === 2 && r.status === 'pending',
  )
  if (pending === undefined) {
    throw new Error('expected pending designer row at clarifyIteration=2')
  }
  return { pendingRerunNodeRunId: pending.id }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('regression — self-clarify rerun history cutoff must not fall back to priorDoneDesigner', () => {
  test('computeHistoryCutoff returns undefined when no prior run produced outputs (even though external_feedback edge is wired)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTaskWithBugTopology(db)
    const { pendingRerunNodeRunId } = await seedTwoAnsweredSelfClarifyRoundsNoOutputs(db, taskId)

    const currentRunRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, pendingRerunNodeRunId)).limit(1)
    )[0]!
    expect(currentRunRow.clarifyIteration).toBe(2)

    const cutoff = await computeHistoryCutoff({
      db,
      taskId,
      nodeId: 'designer',
      shardKey: null,
      currentRunRow,
    })
    // No node_run_outputs row exists for any prior designer run → no draft
    // was ever produced → there is NOTHING to age out → cutoff must be
    // undefined. The bug was the scheduler ignoring this and substituting
    // priorDoneDesigner.clarifyIteration (=1) instead.
    expect(cutoff).toBeUndefined()
  })

  test('buildPromptContext for the Round 2 rerun surfaces BOTH prior answered rounds', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTaskWithBugTopology(db)
    await seedTwoAnsweredSelfClarifyRoundsNoOutputs(db, taskId)

    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
      // historyCutoff intentionally omitted — under the GENERAL rule
      // computeHistoryCutoff returns undefined for this scenario, and the
      // scheduler must forward that undefined into buildPromptContext. The
      // bug was caused by the scheduler OR-ing in `priorDoneDesigner?.clarifyIteration`
      // which would drop Round 1 (the iter=0 row). With the fix in place,
      // historyCutoff is undefined here and both rounds survive.
    })
    expect(ctx).toBeDefined()
    // iter=0 → "Round 1", iter=1 → "Round 2" (per `${row.iteration + 1}`
    // labelling in clarifyRounds.ts:339). Both must appear in the
    // questions block AND the answers block.
    expect(ctx!.questionsBlock).toContain('### Round 1')
    expect(ctx!.questionsBlock).toContain('### Round 2')
    expect(ctx!.questionsBlock).toContain('游戏运行平台是什么？')
    expect(ctx!.questionsBlock).toContain('设计文档是否需要包含可视化图表？')
    expect(ctx!.answersBlock).toContain('### Round 1')
    expect(ctx!.answersBlock).toContain('### Round 2')
  })

  test('source guard: scheduler.ts must not OR-fallback historyCutoffClarifyIteration onto priorDoneDesigner', () => {
    const src = readFileSync(SCHEDULER_SOURCE_PATH, 'utf8')
    // The buggy fallback was the literal string
    //   `priorCompletedCutoff ?? priorDoneDesigner?.clarifyIteration`
    // — case-insensitive whitespace normalization to survive future
    // formatting drift while still catching a re-introduction.
    const normalized = src.replace(/\s+/g, ' ')
    expect(normalized).not.toContain('priorCompletedCutoff ?? priorDoneDesigner?.clarifyIteration')
    // The GENERAL rule must still be wired — `priorCompletedCutoff` is the
    // sole signal, so the assignment must still reference it.
    expect(src).toContain('const historyCutoffClarifyIteration')
    expect(src).toContain('priorCompletedCutoff')
  })
})
