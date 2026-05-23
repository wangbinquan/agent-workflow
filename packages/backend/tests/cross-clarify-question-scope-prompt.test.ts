// RFC-059 T4 — designer-side prompt filter + reaffirms questioner-side
// no-filter contract.
//
// Why these tests exist:
//   - Lock the designer External Feedback filter: when a session contains
//     a mix of designer + questioner scoped questions, the designer block
//     must surface ONLY the designer-scoped subset. Both questions and
//     answers must come from the subset.
//   - Lock the "source skipped when all-questioner" rule: a source whose
//     latest session has zero designer-scoped questions must NOT appear
//     in the External Feedback sources list at all (no `### From '...'`
//     heading with empty body).
//   - Lock the questioner-side NO filter contract (C3, proposal §A3b):
//     no matter what scope distribution the session has — all designer,
//     all questioner, mixed, or NULL (legacy RFC-056 rows) — the
//     questioner cascade rerun receives the FULL Q&A. Asserts via
//     `clarifyRounds.ts/buildPromptContext`'s cross-questioner branch,
//     which is the production read path after RFC-058 T13.
//   - Source-code grep guards: a future regression that introduces a
//     scope filter inside `buildQuestionerCrossClarifyContext` (legacy
//     fallback) or `buildPromptContext` (unified) fails the grep here.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import { buildPromptContext } from '../src/services/clarifyRounds'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const CROSS_CLARIFY_SRC = resolve(import.meta.dir, '..', 'src', 'services', 'crossClarify.ts')
const CLARIFY_ROUNDS_SRC = resolve(import.meta.dir, '..', 'src', 'services', 'clarifyRounds.ts')

async function seedTask(
  db: DbClient,
  opts: { id?: string; ccNodeIds?: string[] } = {},
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = opts.id ?? `task_${Math.random().toString(36).slice(2, 8)}`
  const ccNodeIds = opts.ccNodeIds ?? ['cc1']
  const nodes: WorkflowNode[] = [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    ...ccNodeIds.map(
      (ccId) =>
        ({
          id: ccId,
          kind: 'clarify-cross-agent',
          title: ccId,
        }) as WorkflowNode,
    ),
  ]
  const edges = [] as WorkflowDefinition['edges']
  for (const ccId of ccNodeIds) {
    edges.push({
      id: `e_q_${ccId}`,
      source: { nodeId: 'questioner', portName: '__clarify__' },
      target: { nodeId: ccId, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${ccId}`,
      source: { nodeId: ccId, portName: 'to_designer' },
      target: { nodeId: 'designer', portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${ccId}`,
      source: { nodeId: ccId, portName: 'to_questioner' },
      target: { nodeId: 'questioner', portName: '__clarify_response__' },
    })
  }
  const def: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges,
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc-059-prompt',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc-059-prompt',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc-059-prompt/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  await db.insert(nodeRuns).values({
    id: 'nr_d_1',
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    crossClarifyIteration: 0,
    startedAt: Date.now() - 1000,
  })
  return { taskId, definition: def }
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

function makeA(id: string): ClarifyAnswer {
  return {
    questionId: id,
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
  }
}

async function spawnAndSubmit(
  db: DbClient,
  args: {
    taskId: string
    questionerRunId: string
    ccNodeId?: string
    questions: ClarifyQuestion[]
    answers: ClarifyAnswer[]
    questionScopes?: Record<string, 'designer' | 'questioner'>
    directive?: 'continue' | 'stop'
  },
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: args.questionerRunId,
    taskId: args.taskId,
    nodeId: 'questioner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    crossClarifyIteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId: args.taskId,
    crossClarifyNodeId: args.ccNodeId ?? 'cc1',
    sourceQuestionerNodeId: 'questioner',
    sourceQuestionerNodeRunId: args.questionerRunId,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: args.questions,
  })
  const result = await submitCrossClarifyAnswers({
    db,
    crossClarifyNodeRunId,
    answers: args.answers,
    directive: args.directive ?? 'continue',
    ...(args.questionScopes !== undefined ? { questionScopes: args.questionScopes } : {}),
  })
  // Clear designer_run_triggered_at on the session so the External Feedback
  // builder will return the source on the NEXT read (simulating the moment
  // BEFORE the designer rerun actually consumes the row).
  await db
    .update(crossClarifySessions)
    .set({ designerRunTriggeredAt: null })
    .where(eq(crossClarifySessions.id, result.session.id))
  await db
    .update(clarifyRounds)
    .set({ designerRunTriggeredAt: null })
    .where(eq(clarifyRounds.id, result.session.id))
  return result.session.id
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-059 T4 — designer External Feedback filter', () => {
  test('mixed scopes — designer block includes ONLY designer-scoped questions', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await spawnAndSubmit(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first-q'), makeQ('q2', 'second-q')],
      answers: [makeA('q1'), makeA('q2')],
      questionScopes: { q1: 'designer', q2: 'questioner' },
    })
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerCrossClarifyIteration: 1,
      definition,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.block).toContain('first-q') // q1 (designer)
    expect(ctx!.block).not.toContain('second-q') // q2 (questioner) filtered
  })

  test('all-designer scopes — full block (byte-equivalent to RFC-056 baseline)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await spawnAndSubmit(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first-q'), makeQ('q2', 'second-q')],
      answers: [makeA('q1'), makeA('q2')],
      questionScopes: { q1: 'designer', q2: 'designer' },
    })
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerCrossClarifyIteration: 1,
      definition,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.block).toContain('first-q')
    expect(ctx!.block).toContain('second-q')
  })

  test('NULL scopes (no questionScopes sent) — full block, RFC-056 fallback path', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await spawnAndSubmit(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first-q'), makeQ('q2', 'second-q')],
      answers: [makeA('q1'), makeA('q2')],
      // no questionScopes → server persists NULL → runtime treats as all-designer
    })
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerCrossClarifyIteration: 1,
      definition,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.block).toContain('first-q')
    expect(ctx!.block).toContain('second-q')
  })

  test('multi-source — peer A all-questioner gets skipped; peer B with mixed shows only its designer subset', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db, {
      ccNodeIds: ['cc_a', 'cc_b'],
    })
    // Peer A: all-questioner (fast path / designer-skipped → designerRunTriggeredAt
    // never stamped because the fast path doesn't go through the readiness
    // batch; we still need to clear it explicitly for the test's read).
    await spawnAndSubmit(db, {
      taskId,
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [makeQ('a1', 'a-only-questioner')],
      answers: [makeA('a1')],
      questionScopes: { a1: 'questioner' },
    })
    // Peer B: mixed.
    await spawnAndSubmit(db, {
      taskId,
      questionerRunId: 'nr_q_b',
      ccNodeId: 'cc_b',
      questions: [makeQ('b1', 'b-designer-keep'), makeQ('b2', 'b-questioner-drop')],
      answers: [makeA('b1'), makeA('b2')],
      questionScopes: { b1: 'designer', b2: 'questioner' },
    })
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerCrossClarifyIteration: 1,
      definition,
    })
    expect(ctx).toBeDefined()
    // Peer A's source skipped entirely — no heading from it.
    expect(ctx!.block).not.toContain('a-only-questioner')
    // Peer B's source present but only with its designer-scoped subset.
    expect(ctx!.block).toContain('b-designer-keep')
    expect(ctx!.block).not.toContain('b-questioner-drop')
  })

  test('every source goes all-questioner → builder returns undefined (no External Feedback block at all)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await spawnAndSubmit(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first-q'), makeQ('q2', 'second-q')],
      answers: [makeA('q1'), makeA('q2')],
      questionScopes: { q1: 'questioner', q2: 'questioner' },
    })
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerCrossClarifyIteration: 1,
      definition,
    })
    expect(ctx).toBeUndefined()
  })
})

describe('RFC-059 T4 — questioner side NEVER filters (C3)', () => {
  test('mixed scopes — buildPromptContext (cross-questioner) returns FULL Q&A', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await spawnAndSubmit(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first-q'), makeQ('q2', 'second-q')],
      answers: [makeA('q1'), makeA('q2')],
      questionScopes: { q1: 'designer', q2: 'questioner' },
    })
    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.questionsBlock).toContain('first-q')
    expect(ctx!.questionsBlock).toContain('second-q')
    expect(ctx!.answersBlock).toContain('first-q')
    expect(ctx!.answersBlock).toContain('second-q')
  })

  test('all-questioner scopes — buildPromptContext (cross-questioner) returns FULL Q&A', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await spawnAndSubmit(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'only-q')],
      answers: [makeA('q1')],
      questionScopes: { q1: 'questioner' },
    })
    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.questionsBlock).toContain('only-q')
  })

  test('reject path + mixed scopes — questioner still gets FULL Q&A', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await spawnAndSubmit(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first-q'), makeQ('q2', 'second-q')],
      answers: [makeA('q1'), makeA('q2')],
      questionScopes: { q1: 'designer', q2: 'questioner' },
      directive: 'stop',
    })
    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.questionsBlock).toContain('first-q')
    expect(ctx!.questionsBlock).toContain('second-q')
    expect(ctx!.directive).toBe('stop') // STOP CLARIFYING anchor is appended at render
  })
})

describe('RFC-059 T4 — source-code guards (questioner side must never read scopes)', () => {
  // Why these guards exist:
  //   The integration tests above will catch a regression at runtime, but
  //   bisecting "why are questioner-scoped questions suddenly missing from
  //   the rerun prompt" is expensive. These grep guards make the regression
  //   a 1-test failure with a clear pointer at the exact functions that
  //   must keep their no-filter contract.
  test('legacy `buildQuestionerCrossClarifyContext` does NOT read `questionScopesJson`', () => {
    const src = readFileSync(CROSS_CLARIFY_SRC, 'utf8')
    const fnIdx = src.indexOf('export async function buildQuestionerCrossClarifyContext(')
    expect(fnIdx).toBeGreaterThan(-1)
    // Slice from function start to the next top-level export so we only
    // grep within the function body (the file has the field name in OTHER
    // helpers — we MUST NOT grep the entire file).
    const after = src.slice(fnIdx)
    const nextExport = after.indexOf('\nexport ', 1)
    const body = nextExport === -1 ? after : after.slice(0, nextExport)
    expect(body).not.toContain('questionScopesJson')
    expect(body).not.toContain('extractDesignerScopedSubset')
  })

  test('unified `buildPromptContext` (cross-questioner branch) does NOT read `questionScopesJson`', () => {
    const src = readFileSync(CLARIFY_ROUNDS_SRC, 'utf8')
    const fnIdx = src.indexOf('export async function buildPromptContext(')
    expect(fnIdx).toBeGreaterThan(-1)
    const after = src.slice(fnIdx)
    const nextExport = after.indexOf('\nexport ', 1)
    const body = nextExport === -1 ? after : after.slice(0, nextExport)
    expect(body).not.toContain('questionScopesJson')
    expect(body).not.toContain('extractDesignerScopedSubset')
  })
})
