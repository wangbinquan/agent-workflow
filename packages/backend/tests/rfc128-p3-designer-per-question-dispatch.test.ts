// RFC-128 P3 — designer 域逐题下发 (AC-8)。先红后绿，service 级端到端。
//
// P3 放开 P1 的 P2-4a 临时「整轮 gate」：每 seal 一个 designer-scope 题即逐题出它的 designer
// 条目，可单独 stage → 走既有 dispatchTaskQuestions（§18）+ RFC-127 借壳下发，注入时只取该题
// 的 Q&A。三处必须同步 per-question（否则又成半可用 row）：
//
//   1. reconcile per-question (reconcileRoundEntriesTx) — 按该题 task_questions.sealed_at
//      != null（而非整轮 round.status）出 designer 条目（验证见 rfc128-p1 AC-2 + shared
//      task-questions-reconcile）。
//   2. dispatch readiness per-question (assertDesignerReady → evaluateDesignerRerunReadiness)
//      — 被下发的来源轮（partial、仍 awaiting_human）被豁免「pending」门，故该题 sealed 即可
//      dispatch，不必等兄弟题/兄弟源；UNRESOLVED 的兄弟源仍 gate（golden lock H3/H2，见
//      rfc120-deferred-dispatch）。
//   3. feedback injection per-question (buildNodeQueueExternalFeedback) — partial 轮也注入，
//      但只渲染被下发（已 sealed）题的 Q&A；未 seal 的兄弟题不进 answers_json、不注入。
//
// 锁的 AC-8 路径：
//   • partial Q1=designer seal → 出 Q1 designer 条目（Q2 未 seal 不出）→ stage（gate 放行）→
//     dispatch（partial 轮仍 awaiting_human）→ 注入仅 Q1 Q&A；
//   • 借壳：partial Q1 改派 OTHER → dispatch mint HOME=designer + agent_override_name=OTHER；
//   • 黄金锁：整轮一次 seal 全题 = 全题 designer 条目 + 注入全题 Q&A（= 旧整轮逐字）；
//   • CAS 防重（dispatched_at IS NULL）：重复 dispatch 同条目 → 不二次 mint。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
} from '../src/services/crossClarify'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import {
  listTaskQuestions,
  reassignTaskQuestion,
  stageTaskQuestion,
} from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const DESIGNER = 'designer'
const QUESTIONER = 'questioner'
const CC = 'cross1'
// A plain agent node (no __external_feedback__ edge) — a valid reassign/borrow target whose
// agentName a clarify-designer override BORROWS (rides on the home designer's rerun).
const OTHER = 'other'
const OTHER_AGENT = 'other-agent'

const Q1_TITLE = 'QUESTION-ONE-distinctive-title'
const Q2_TITLE = 'QUESTION-TWO-distinctive-title'
const Q1_NOTE = 'CUSTOM-ANSWER-Q1-distinctive'

const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: OTHER_AGENT } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: QUESTIONER, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: QUESTIONER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

function mkQ(id: string, title: string): ClarifyQuestion {
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

/** A sealable answer (selectedOptionIndices → labels server-side); customText preserved so
 *  the injection block can be asserted distinctively. */
function ans(qid: string, note = ''): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: note }
}

/** Seed a DEFERRED cross task on liveDef + the designer's prior `done` draft + the questioner's
 *  `done` asking run (+ optionally OTHER's prior run), then open ONE cross-clarify session with
 *  [Q1, Q2]. Returns the task + the cross node-run id (= origin/intermediary). */
async function seedDeferredCrossTask(
  db: DbClient,
  opts: { otherHasRun?: boolean } = {},
): Promise<{ taskId: string; originNodeRunId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc128-p3',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc128-p3',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc128-p3/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    deferredQuestionDispatch: true,
  })
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: DESIGNER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  if (opts.otherHasRun) {
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
  }
  const questionerRunId = ulid()
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: QUESTIONER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: CC,
    sourceQuestionerNodeId: QUESTIONER,
    sourceQuestionerNodeRunId: questionerRunId,
    targetDesignerNodeId: DESIGNER,
    loopIter: 0,
    questions: [mkQ('q1', Q1_TITLE), mkQ('q2', Q2_TITLE)],
  })
  return { taskId, originNodeRunId: crossClarifyNodeRunId }
}

function designerEntries(db: DbClient, taskId: string) {
  return db
    .select()
    .from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
}

function roundStatus(db: DbClient, originNodeRunId: string) {
  return db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, originNodeRunId))
}

async function pendingDesignerRunCount(db: DbClient, taskId: string): Promise<number> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
  return rows.filter((r) => r.status === 'pending').length
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// AC-8 主路径 — partial Q1=designer seal → 出 Q1 designer 条目 → stage → dispatch → 注入仅 Q1
// ---------------------------------------------------------------------------

describe('RFC-128 P3 — designer 逐题下发 (AC-8)', () => {
  test('partial Q1(designer) seal → Q1 designer 条目可 stage → dispatch（partial 轮仍 awaiting_human）→ 注入仅 Q1 Q&A', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)

    // (1) reconcile per-question: partial seal Q1 (designer scope) → Q1 designer 条目出现，Q2 不出。
    const sealRes = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    expect(sealRes.roundFullySealed).toBe(false)
    // 中介 cross node_run 仍 awaiting_human（partial 不关），任务由它把持、未提前完成。
    expect((await roundStatus(db, originNodeRunId))[0]?.status).toBe('awaiting_human')

    const before = await listTaskQuestions(db, taskId)
    const sig = before.map((d) => `${d.questionId}:${d.roleKind}`).sort()
    expect(sig).toEqual(['q1:designer', 'q1:questioner', 'q2:questioner'])
    const q1Designer = before.find((d) => d.questionId === 'q1' && d.roleKind === 'designer')!
    expect(q1Designer.sealed).toBe(true)
    expect(q1Designer.phase).toBe('pending')
    // Q2 未 seal → 无 designer 条目。
    expect(before.some((d) => d.questionId === 'q2' && d.roleKind === 'designer')).toBe(false)

    // 待下发 gate (D5): Q1 已 seal → stage 放行。
    await stageTaskQuestion(db, q1Designer.id, true, actor)
    expect((await listTaskQuestions(db, taskId)).find((d) => d.id === q1Designer.id)?.phase).toBe(
      'staged',
    )

    // (2) dispatch readiness per-question: 该题 sealed 即可下发，partial 轮（其来源被豁免）不阻塞。
    const result = await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    const runId = result.reruns[0]!.nodeRunId
    // dispatch 不关 partial 轮（仍 awaiting_human——只 full seal 才关中介 node_run）。
    expect((await roundStatus(db, originNodeRunId))[0]?.status).toBe('awaiting_human')

    // (3) feedback injection per-question: per-node queue 在 partial 轮上注入，但只渲染 Q1 的 Q&A。
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: runId,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.block).toContain(Q1_TITLE)
    expect(ctx!.block).toContain(Q1_NOTE) // Q1 的答案被注入
    expect(ctx!.block).not.toContain(Q2_TITLE) // 未 seal 的 Q2 绝不注入
    // 条目绑定到本次 rerun（处理中）。
    expect(
      (await designerEntries(db, taskId)).find((e) => e.id === q1Designer.id)?.triggerRunId,
    ).toBe(runId)
  })

  test('借壳: partial Q1(designer) 改派 OTHER → dispatch mint HOME=designer + agent_override_name=OTHER；注入仍仅 Q1', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db, { otherHasRun: true })

    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    const q1Designer = (await designerEntries(db, taskId))[0]!
    expect(q1Designer.questionId).toBe('q1')
    expect(q1Designer.defaultTargetNodeId).toBe(DESIGNER)

    // RFC-127 借壳: 改派 → OTHER（借它的 agent，run 仍 mint 在 home=designer）。
    await reassignTaskQuestion(db, q1Designer.id, OTHER, actor)
    const result = await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER) // home, NOT the borrowed node
    const minted = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, result.reruns[0]!.nodeRunId))
    )[0]
    expect(minted?.nodeId).toBe(DESIGNER)
    expect(minted?.rerunCause).toBe('cross-clarify-answer')
    expect(minted?.agentOverrideName).toBe(OTHER_AGENT) // 借壳：跑 OTHER 的 brain on designer 的 artifact

    // 借壳节点 OTHER 自身不被 mint（仍只有 seeded done）。
    const otherPending = (
      await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    ).filter((r) => r.status === 'pending')
    expect(otherPending.length).toBe(0)

    // HOME designer 的 per-node queue（按 home=default 选）注入仅 Q1。
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: result.reruns[0]!.nodeRunId,
    })
    expect(ctx!.block).toContain(Q1_TITLE)
    expect(ctx!.block).not.toContain(Q2_TITLE)
  })

  test('CAS 防重: 重复 dispatch 同一 Q1 designer 条目 → 不二次 mint（dispatched_at IS NULL 落空）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    const q1Designer = (await designerEntries(db, taskId))[0]!

    const first = await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(first.reruns.length).toBe(1)
    expect(await pendingDesignerRunCount(db, taskId)).toBe(1)

    // 二次 dispatch 同条目：已 dispatched_at → 选不中 → EMPTY_RESULT，不再 mint。
    const second = await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(second.reruns.length).toBe(0)
    expect(second.dispatchedEntryIds.length).toBe(0)
    expect(await pendingDesignerRunCount(db, taskId)).toBe(1) // 仍只有第一条
  })

  // -------------------------------------------------------------------------
  // 黄金锁 — 整轮一次 seal 全题 = 全题 designer 条目 + dispatch + 注入全题 Q&A（= 旧整轮逐字）
  // -------------------------------------------------------------------------

  test('黄金锁: 整轮一次 seal 全题(designer) → 两题 designer 条目 → 一次 dispatch → 注入 Q1+Q2', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)

    // 一次性 seal 全题（= 旧整轮提交）：轮 answered。
    const res = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE), ans('q2', 'CUSTOM-ANSWER-Q2')],
      scopes: { q1: 'designer', q2: 'designer' },
    })
    expect(res.roundFullySealed).toBe(true)
    expect((await roundStatus(db, originNodeRunId))[0]?.status).toBe('done') // full seal 关中介 node_run

    const list = await listTaskQuestions(db, taskId)
    const sig = list.map((d) => `${d.questionId}:${d.roleKind}`).sort()
    expect(sig).toEqual(['q1:designer', 'q1:questioner', 'q2:designer', 'q2:questioner'])

    const designers = (await designerEntries(db, taskId)).sort((a, b) =>
      a.questionId.localeCompare(b.questionId),
    )
    expect(designers.map((e) => e.questionId)).toEqual(['q1', 'q2'])

    // 整轮一次下发两题（同轮同 home=designer）→ 一条 rerun（= 旧整轮单 designer 续跑）。
    const result = await dispatchTaskQuestions(
      db,
      taskId,
      designers.map((e) => e.id),
      actor,
    )
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)

    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: result.reruns[0]!.nodeRunId,
    })
    // 全题注入：Q1 + Q2 都在 block 里（= 旧整轮逐字行为）。
    expect(ctx!.block).toContain(Q1_TITLE)
    expect(ctx!.block).toContain(Q2_TITLE)
    expect(ctx!.block).toContain(Q1_NOTE)
    expect(ctx!.block).toContain('CUSTOM-ANSWER-Q2')
  })

  test('Q2 未 seal 不可 stage（待下发 gate）：partial 只 seal Q1 时 Q2 designer 条目不存在 / questioner 条目未 seal', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    const list = await listTaskQuestions(db, taskId)
    // Q2 没有 designer 条目；Q2 questioner 条目未 seal → stage 该 questioner 条目被 gate 拒。
    const q2Questioner = list.find((d) => d.questionId === 'q2' && d.roleKind === 'questioner')!
    expect(q2Questioner.sealed).toBe(false)
    let threw: unknown = null
    try {
      await stageTaskQuestion(db, q2Questioner.id, true, actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-not-sealed')
  })
})
