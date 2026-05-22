// RFC-056 patch 2026-05-23 — update-mode injection survives retry_index bump.
//
// Pairs with patch-2026-05-23-designer-retry-index.md. That patch fixed
// "designer never re-executes after cross-clarify submit" by making
// `triggerDesignerRerun` mint the new pending row at
// `retry_index = max(existing top-level rows at this iteration) + 1` (so
// `isFresherNodeRun` always picks the new pending over a prior done row
// whose retry_index was already inflated by self-clarify rounds /
// RFC-042 same-session retries).
//
// SIDE EFFECT THIS FILE LOCKS DOWN: the scheduler used to gate
// "update-mode prompt injection" (the §6 `## Prior Output (to be updated)`
// + `## Update Directive` sections) on `currentRunRow.retryIndex === 0`.
// Pre-patch every cross-clarify designer rerun was at retry_index=0 so
// the gate was effectively a no-op. Post-patch retry_index ≥ 1 for ANY
// designer rerun with at least one prior row — i.e. always — and the
// gate silently dropped update-mode injection on every cross-clarify
// resolve. The user's symptom: the rendered designer prompt carried
// `## requirement` + `## External Feedback` but had NO `## Prior Output
// (to be updated)` and NO `## Update Directive`, so the designer went
// back to regenerate-from-scratch mode and discarded the prior draft —
// defeating RFC-056 §6 update mode entirely.
//
// The fix drops the `retryIndex === 0` sub-condition from both gates
// (designer update-mode AND questioner cross-clarify Q&A injection)
// because retry_index can no longer distinguish "fresh cross-clarify
// rerun" from "in-attempt RFC-042 retry" — only the
// crossClarifyIteration signal can. This file locks the three lines of
// defence:
//   1. Live-shaped DB state (designer prior done at retry_index=9) →
//      scheduler-style priorDoneDesigner lookup resolves it correctly.
//   2. Render via `renderUserPrompt` with the assembled context
//      produces the three §6 sections in the canonical order:
//      `## Prior Output (to be updated)` → `## External Feedback` →
//      `## Update Directive`.
//   3. Source-code-text guard: neither gate condition in scheduler.ts
//      contains `retryIndex === 0` anymore. If a future refactor re-
//      introduces it, this regression returns silently — the grep guard
//      catches it before runtime.
//
// If any of these go red the §6 update-mode prompt contract has drifted
// — investigate before relaxing. The live failure shape that motivated
// the original retry_index patch was task `01KS86DPCSERV7S41GQA5Y81RN`
// (workflow `01KS7C0K5ZRJ29AZD7J13C42C2` "跨节点反问"); the side-effect
// regression this file guards against was discovered against the same
// workflow shape one round later in the same loop iter.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import {
  buildPriorOutputBlock,
  renderUserPrompt,
  CROSS_CLARIFY_PRIOR_OUTPUT_BLOCK_TITLE,
  CROSS_CLARIFY_UPDATE_DIRECTIVE_BLOCK_TITLE,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import { isFresherNodeRun } from '../src/services/scheduler'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCHEDULER_SOURCE_PATH = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')

function makeQ(id: string, title: string): ClarifyQuestion {
  return {
    id,
    title,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: 'first', recommended: false, recommendationReason: '' },
      { label: 'B', description: 'second', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid: string, idx: number, label: string): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: [idx],
    selectedOptionLabels: [label],
    customText: '',
  }
}

function fixtureDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'designer', portName: 'requirement' },
      },
      {
        id: 'e_d_q',
        source: { nodeId: 'designer', portName: 'docpath' },
        target: { nodeId: 'questioner', portName: 'requirement' },
      },
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

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = fixtureDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'update-mode-injection',
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
    repoPath: '/tmp/aw-update-mode-injection',
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
  fields: Partial<typeof nodeRuns.$inferInsert>,
): Promise<string> {
  const id = `nr_${nodeId}_${Math.random().toString(36).slice(2, 10)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: 0,
    crossClarifyIteration: 0,
    startedAt: Date.now(),
    ...fields,
  })
  return id
}

/**
 * Mirror the scheduler.ts:1283-1457 block that builds the designer's
 * cross-clarify prompt context. Kept here so the test can drive the same
 * data flow without booting the scheduler. If the scheduler refactors
 * the inline lookup into a helper (welcome), update this stub to call it
 * directly — the section-emission assertions stay the contract.
 */
async function assembleDesignerCrossClarifyContext(args: {
  db: DbClient
  taskId: string
  designerNodeId: string
  designerNodeRunId: string
  definition: WorkflowDefinition
  loopIter: number
  agentOutputs: string[]
}): Promise<{ priorOutputBlock?: string; externalFeedbackBlock?: string }> {
  const { db, taskId, designerNodeId, designerNodeRunId, definition, loopIter, agentOutputs } = args
  const currentRunRow = (
    await db.select().from(nodeRuns).where(eq(nodeRuns.id, designerNodeRunId)).limit(1)
  )[0]
  if (currentRunRow === undefined) return {}
  const currentCrossClarifyIteration = currentRunRow.crossClarifyIteration ?? 0
  // Gate mirrors scheduler.ts:1287-1291 (post-patch — NO retry_index gate).
  const isCrossClarifyTriggeredRerun = currentCrossClarifyIteration > 0
  let priorDoneDesigner: typeof nodeRuns.$inferSelect | undefined
  if (isCrossClarifyTriggeredRerun) {
    const priorRows = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, designerNodeId),
          eq(nodeRuns.status, 'done'),
        ),
      )
    for (const r of priorRows) {
      if (r.crossClarifyIteration >= currentCrossClarifyIteration) continue
      if (r.parentNodeRunId !== null) continue
      if (isFresherNodeRun(r, priorDoneDesigner)) priorDoneDesigner = r
    }
  }
  const ctx = await buildExternalFeedbackContext({
    db,
    taskId,
    designerNodeId,
    loopIter,
    designerCrossClarifyIteration: currentCrossClarifyIteration,
    definition,
  })
  if (ctx === undefined) return {}
  if (priorDoneDesigner !== undefined) {
    const captured = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, priorDoneDesigner.id))
    const byPort = new Map(captured.map((r) => [r.portName, r.content]))
    const ordered = agentOutputs
      .map((p) => ({ portName: p, content: byPort.get(p) ?? '' }))
      .filter((o) => o.content.length > 0)
    const block = buildPriorOutputBlock(ordered)
    if (block.length > 0) ctx.priorOutputBlock = block
  }
  return { priorOutputBlock: ctx.priorOutputBlock, externalFeedbackBlock: ctx.block }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 §6 update mode — injection survives retry_index bump (patch 2026-05-23)', () => {
  test('designer prior done at retry_index=9 — update-mode context populates priorOutputBlock', async () => {
    // Live shape: designer ran self-clarify storm + RFC-042 retries, leaving
    // its latest done at retry_index=9 with a captured `<workflow-output>`
    // for port `docpath`. Cross-clarify submit mints a NEW pending designer
    // row at retry_index=10 (max+1, per patch-2026-05-23-designer-retry-
    // index). The post-patch scheduler gate (`crossClarifyIteration > 0`
    // only — no retry_index === 0 sub-gate) must still let update-mode
    // injection through. Pre-patch this returned no priorOutputBlock and
    // the rendered prompt dropped the `## Prior Output (to be updated)` +
    // `## Update Directive` sections.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'in', { status: 'done' })
    // Prior designer done — the working draft we expect to see in the prompt.
    const priorDesignerId = await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 9,
      clarifyIteration: 6,
      crossClarifyIteration: 0,
      preSnapshot: 'snap-d-pre',
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: priorDesignerId,
      portName: 'docpath',
      content: '# 设计文档 v1\n\n## ECS 架构\n- 16 个 System\n- 道具 / 升级 / 续关子系统',
    })
    const qRun = await seedRun(db, taskId, 'questioner', {
      status: 'done',
      retryIndex: 2,
      clarifyIteration: 0,
      crossClarifyIteration: 0,
    })

    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', '测试设计文档应覆盖哪些测试类型？')],
    })
    const submit = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1', 0, 'A')],
      directive: 'continue',
    })
    expect(submit.outcome.kind).toBe('designer-rerun-triggered')
    const newDesignerNodeRunId =
      submit.outcome.kind === 'designer-rerun-triggered'
        ? submit.outcome.designerNodeRunId
        : undefined
    expect(newDesignerNodeRunId, 'designer rerun must mint a pending row').toBeDefined()
    // Sanity-check the freshness-shield contract that motivated this patch
    // family: the new pending row's retry_index is strictly greater than
    // the prior done at retry_index=9. Without the bump the post-patch
    // gate would still see retry_index=0 and the old test would mask the
    // injection-bug — so we explicitly require ≥1.
    const newRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, newDesignerNodeRunId!)).limit(1)
    )[0]
    expect(newRow?.retryIndex).toBeGreaterThan(0)
    expect(newRow?.crossClarifyIteration).toBe(1)

    const ctx = await assembleDesignerCrossClarifyContext({
      db,
      taskId,
      designerNodeId: 'designer',
      designerNodeRunId: newDesignerNodeRunId!,
      definition: fixtureDef(),
      loopIter: 0,
      agentOutputs: ['docpath'],
    })
    expect(ctx.priorOutputBlock, 'priorOutputBlock must populate').toBeDefined()
    expect(ctx.priorOutputBlock).toContain('### docpath')
    expect(ctx.priorOutputBlock).toContain('# 设计文档 v1')
    expect(ctx.priorOutputBlock).toContain('ECS 架构')
    expect(ctx.externalFeedbackBlock).toContain('测试设计文档应覆盖哪些测试类型？')
  })

  test('rendered prompt carries all three §6 sections in canonical order', async () => {
    // End-to-end render lock: the full `renderUserPrompt` output contains
    // every section the user expects in update mode, in the order
    // Prior Output → External Feedback → Update Directive. This is the
    // exact symptom shape the user reported (prompt had requirement +
    // External Feedback but no Prior Output / Update Directive).
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'in', { status: 'done' })
    const priorDesignerId = await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 9,
      clarifyIteration: 6,
      crossClarifyIteration: 0,
      preSnapshot: 'snap-d-pre',
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: priorDesignerId,
      portName: 'docpath',
      content: '# Prior draft body\nLine A\nLine B',
    })
    const qRun = await seedRun(db, taskId, 'questioner', {
      status: 'done',
      retryIndex: 2,
    })
    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', '测试范围应覆盖哪些系统模块？')],
    })
    const submit = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1', 0, 'A')],
      directive: 'continue',
    })
    const newDesignerNodeRunId =
      submit.outcome.kind === 'designer-rerun-triggered'
        ? submit.outcome.designerNodeRunId
        : undefined
    const ctx = await assembleDesignerCrossClarifyContext({
      db,
      taskId,
      designerNodeId: 'designer',
      designerNodeRunId: newDesignerNodeRunId!,
      definition: fixtureDef(),
      loopIter: 0,
      agentOutputs: ['docpath'],
    })
    const rendered = renderUserPrompt({
      promptTemplate: '生成软件设计文档',
      inputs: { requirement: '生成坦克大战游戏设计' },
      meta: { repoPath: '', baseBranch: '', taskId },
      agentOutputs: ['docpath'],
      agentOutputKinds: { docpath: 'markdown_file' },
      crossClarifyContext: {
        block: ctx.externalFeedbackBlock,
        iteration: '1',
        sourcesCsv: 'questioner',
        ...(ctx.priorOutputBlock !== undefined ? { priorOutputBlock: ctx.priorOutputBlock } : {}),
      },
      hasClarifyChannel: true,
    })

    // Each section is present.
    expect(rendered).toContain(CROSS_CLARIFY_PRIOR_OUTPUT_BLOCK_TITLE)
    expect(rendered).toContain(CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE)
    expect(rendered).toContain(CROSS_CLARIFY_UPDATE_DIRECTIVE_BLOCK_TITLE)
    // Prior output body landed.
    expect(rendered).toContain('# Prior draft body')
    // External feedback body landed (the question title is the cleanest
    // anchor — guaranteed to appear in `renderClarifyQuestionsBlock`).
    expect(rendered).toContain('测试范围应覆盖哪些系统模块？')
    // Section ordering: Prior Output → External Feedback → Update Directive.
    const priorIdx = rendered.indexOf(CROSS_CLARIFY_PRIOR_OUTPUT_BLOCK_TITLE)
    const extIdx = rendered.indexOf(CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE)
    const dirIdx = rendered.indexOf(CROSS_CLARIFY_UPDATE_DIRECTIVE_BLOCK_TITLE)
    expect(priorIdx).toBeGreaterThan(-1)
    expect(extIdx).toBeGreaterThan(priorIdx)
    expect(dirIdx).toBeGreaterThan(extIdx)
    // The Update Directive's English instruction body must accompany the
    // heading — without the directive text the agent has no contract to
    // anchor "update, do not regenerate" on. Cheapest anchor: the literal
    // 'not regenerate' bigram from CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT.
    expect(rendered.toLowerCase()).toContain('not regenerate')
  })

  test('first-ever rerun (no prior retries) — retry_index=1 still gets update-mode injection', async () => {
    // Same gate logic, less inflated state. retry_index=1 is the minimum
    // post-patch value; making sure the gate fires here keeps the test
    // honest against a refactor that re-introduces `retryIndex === 0` as
    // a guard "only for the inflated case".
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'in', { status: 'done' })
    const priorDesignerId = await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 0,
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      preSnapshot: 'snap-d-pre',
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: priorDesignerId,
      portName: 'docpath',
      content: 'minimal draft body',
    })
    const qRun = await seedRun(db, taskId, 'questioner', { status: 'done' })
    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', '一')],
    })
    const submit = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1', 0, 'A')],
      directive: 'continue',
    })
    const newDesignerNodeRunId =
      submit.outcome.kind === 'designer-rerun-triggered'
        ? submit.outcome.designerNodeRunId
        : undefined
    expect(newDesignerNodeRunId).toBeDefined()
    const newRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, newDesignerNodeRunId!)).limit(1)
    )[0]
    expect(newRow?.retryIndex).toBe(1)
    const ctx = await assembleDesignerCrossClarifyContext({
      db,
      taskId,
      designerNodeId: 'designer',
      designerNodeRunId: newDesignerNodeRunId!,
      definition: fixtureDef(),
      loopIter: 0,
      agentOutputs: ['docpath'],
    })
    expect(ctx.priorOutputBlock).toContain('minimal draft body')
  })

  test('regenerate-from-scratch sanity: no prior outputs → no Prior Output section (Update Directive suppressed too)', async () => {
    // Paired contract from `cross-clarify-update-mode.test.ts` shared layer:
    // a designer with NO captured `<workflow-output>` rows (e.g. prior done
    // only emitted `<workflow-clarify>`) renders WITHOUT the Prior Output +
    // Update Directive sections. The gate must still pull priorDoneDesigner
    // but `buildPriorOutputBlock` returns '' so the renderer suppresses
    // both sections paired. Locks down "update-mode injection skipped
    // gracefully when there's nothing to update."
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'in', { status: 'done' })
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 3,
      clarifyIteration: 2,
      crossClarifyIteration: 0,
      preSnapshot: 'snap-d-pre',
    })
    // Intentionally no node_run_outputs row for the prior designer run.
    const qRun = await seedRun(db, taskId, 'questioner', { status: 'done' })
    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', '一')],
    })
    const submit = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1', 0, 'A')],
      directive: 'continue',
    })
    const newDesignerNodeRunId =
      submit.outcome.kind === 'designer-rerun-triggered'
        ? submit.outcome.designerNodeRunId
        : undefined
    const ctx = await assembleDesignerCrossClarifyContext({
      db,
      taskId,
      designerNodeId: 'designer',
      designerNodeRunId: newDesignerNodeRunId!,
      definition: fixtureDef(),
      loopIter: 0,
      agentOutputs: ['docpath'],
    })
    expect(ctx.priorOutputBlock).toBeUndefined()
    // External Feedback still appears — the cross-clarify Q&A is still
    // the change driver; only the Prior Output anchor is missing.
    expect(ctx.externalFeedbackBlock).toBeDefined()
    const rendered = renderUserPrompt({
      promptTemplate: 'do',
      inputs: { requirement: 'x' },
      meta: { repoPath: '', baseBranch: '', taskId },
      agentOutputs: ['docpath'],
      crossClarifyContext: {
        block: ctx.externalFeedbackBlock,
        iteration: '1',
        sourcesCsv: 'questioner',
      },
    })
    expect(rendered).not.toContain(CROSS_CLARIFY_PRIOR_OUTPUT_BLOCK_TITLE)
    expect(rendered).not.toContain(CROSS_CLARIFY_UPDATE_DIRECTIVE_BLOCK_TITLE)
    expect(rendered).toContain(CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE)
  })
})

describe('RFC-056 patch 2026-05-23 — scheduler source guard against `retryIndex === 0` resurrection', () => {
  // Source-code-text regression guard. The fix removed
  // `currentRunRow.retryIndex === 0` from BOTH gate conditions in
  // scheduler.ts (designer update-mode at the `isCrossClarifyTriggeredRerun`
  // assignment + questioner cross-clarify Q&A at the
  // `isQuestionerCrossClarifyRerun` assignment). If a future refactor adds
  // it back the runtime symptom is silent — the rendered prompt simply
  // drops the §6 sections. We grep the source so silent re-introduction
  // becomes a hard CI fail.
  test('isCrossClarifyTriggeredRerun gate has no retry_index check', () => {
    const src = readFileSync(SCHEDULER_SOURCE_PATH, 'utf8')
    // Capture the assignment expression spanning the gate condition.
    const m = src.match(/const isCrossClarifyTriggeredRerun =[^;]+;?\s*\n\s*let priorDoneDesigner/)
    expect(m, 'must find the isCrossClarifyTriggeredRerun assignment').not.toBeNull()
    const gateText = m![0]
    expect(gateText).not.toMatch(/retryIndex\s*===\s*0/)
    expect(gateText).not.toMatch(/retry_index\s*===\s*0/)
    // Positive lock: the surviving signals are still the two we expect.
    expect(gateText).toContain('hasExternalFeedbackChannel')
    expect(gateText).toContain('currentCrossClarifyIteration')
  })

  test('isQuestionerCrossClarifyRerun gate has no retry_index check', () => {
    const src = readFileSync(SCHEDULER_SOURCE_PATH, 'utf8')
    const m = src.match(/const isQuestionerCrossClarifyRerun =[^;]+;?\s*\n\s*const clarifyContext/)
    expect(m, 'must find the isQuestionerCrossClarifyRerun assignment').not.toBeNull()
    const gateText = m![0]
    expect(gateText).not.toMatch(/retryIndex\s*===\s*0/)
    expect(gateText).not.toMatch(/retry_index\s*===\s*0/)
    expect(gateText).toContain("clarifyMode === 'cross'")
    expect(gateText).toContain('currentCrossClarifyIteration')
  })
})
