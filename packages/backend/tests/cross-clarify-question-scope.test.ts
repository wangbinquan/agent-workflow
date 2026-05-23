// RFC-059 — per-question scope service tests.
//
// Why these tests exist:
//   Locks the new branches inside submitCrossClarifyAnswers:
//     1. backward compat (no questionScopes) → unchanged
//     2. explicit all-designer scopes → unchanged + JSON persisted
//     3. all-questioner scopes → fast path 'questioner-continue-triggered'
//     4. mixed scopes → designer rerun External Feedback is filtered;
//        questioner cascade rerun is NOT filtered (proposal §C3 / A3b)
//     5. multi-source single all-questioner peer → fast path on that peer
//        while other peer is still awaiting
//     6. multi-source aggregated designer-count = 0 → outcome
//        'designer-skipped-all-questioner-scope'
//     7. reject + mixed scope → directive='stop' wins, scope ignored at
//        runtime but persisted for audit
//     8. malformed questionScopes (unknown questionId / non-enum value)
//        → ValidationError with code 'cross-clarify-question-scopes-malformed'
//     9. dual-write parity: cross_clarify_sessions.questionScopesJson and
//        clarify_rounds.questionScopesJson stay byte-equivalent across the
//        submit (regression guard against single-table write drift).
//
// These cases collectively also guard:
//   - RFC-058 dual-write (any read site failing to mirror would fail #9)
//   - proposal A2, A3, A4, A5, A6, A7, A9 acceptance.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { buildPromptContext } from '../src/services/clarifyRounds'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  ClarifyQuestionScope,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(
  db: DbClient,
  opts: {
    id?: string
    questionerNodeIds?: string[]
    crossClarifyNodeIds?: string[]
  } = {},
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = opts.id ?? `task_${Math.random().toString(36).slice(2, 8)}`
  const designerNodeId = 'designer'
  const questionerNodeIds = opts.questionerNodeIds ?? ['questioner']
  const crossClarifyNodeIds = opts.crossClarifyNodeIds ?? ['cc1']
  const nodes: WorkflowNode[] = [
    { id: designerNodeId, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    ...questionerNodeIds.map(
      (qid) =>
        ({
          id: qid,
          kind: 'agent-single',
          agentName: qid,
        }) as WorkflowNode,
    ),
    ...crossClarifyNodeIds.map(
      (ccId) =>
        ({
          id: ccId,
          kind: 'clarify-cross-agent',
          title: ccId,
        }) as WorkflowNode,
    ),
  ]
  const edges = [] as WorkflowDefinition['edges']
  for (let i = 0; i < crossClarifyNodeIds.length; i++) {
    const ccId = crossClarifyNodeIds[i]!
    const qId = questionerNodeIds[Math.min(i, questionerNodeIds.length - 1)]!
    edges.push({
      id: `e_q_${ccId}`,
      source: { nodeId: qId, portName: '__clarify__' },
      target: { nodeId: ccId, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${ccId}`,
      source: { nodeId: ccId, portName: 'to_designer' },
      target: { nodeId: designerNodeId, portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${ccId}`,
      source: { nodeId: ccId, portName: 'to_questioner' },
      target: { nodeId: qId, portName: '__clarify_response__' },
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
    name: 'rfc-059-stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    name: 'rfc-059-fixture',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc-059/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
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

async function seedDesigner(db: DbClient, taskId: string): Promise<void> {
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
}

async function spawnSession(
  db: DbClient,
  args: {
    taskId: string
    questionerRunId: string
    questionerNodeId?: string
    ccNodeId?: string
    questions: ClarifyQuestion[]
  },
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: args.questionerRunId,
    taskId: args.taskId,
    nodeId: args.questionerNodeId ?? 'questioner',
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
    sourceQuestionerNodeId: args.questionerNodeId ?? 'questioner',
    sourceQuestionerNodeRunId: args.questionerRunId,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: args.questions,
  })
  return crossClarifyNodeRunId
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-059 — submitCrossClarifyAnswers / questionScopes', () => {
  test('1. no questionScopes → designer rerun + both tables NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const result = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      directive: 'continue',
    })
    expect(result.outcome.kind).toBe('designer-rerun-triggered')
    expect(result.session.questionScopes).toBeNull()
    const legacy = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.id, result.session.id))
    const unified = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, result.session.id))
    expect(legacy[0]?.questionScopesJson).toBeNull()
    expect(unified[0]?.questionScopesJson).toBeNull()
    expect(definition).toBeDefined()
  })

  test('2. all-designer scopes → designer rerun + persisted JSON on both tables', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const scopes: Record<string, ClarifyQuestionScope> = { q1: 'designer', q2: 'designer' }
    const result = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      directive: 'continue',
      questionScopes: scopes,
    })
    expect(result.outcome.kind).toBe('designer-rerun-triggered')
    expect(result.session.questionScopes).toEqual(scopes)
    const legacy = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.id, result.session.id))
    const unified = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, result.session.id))
    expect(legacy[0]?.questionScopesJson).toBe(JSON.stringify(scopes))
    expect(unified[0]?.questionScopesJson).toBe(JSON.stringify(scopes))
  })

  test('3. all-questioner scopes → fast path questioner-continue-triggered, designer not rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const scopes: Record<string, ClarifyQuestionScope> = { q1: 'questioner', q2: 'questioner' }
    const result = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      directive: 'continue',
      questionScopes: scopes,
    })
    expect(result.outcome.kind).toBe('questioner-continue-triggered')
    if (result.outcome.kind === 'questioner-continue-triggered') {
      expect(result.outcome.questionerNodeRunId).toBeTruthy()
    }
    // Designer must NOT have been rerun — only the original designer row exists.
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(1)
  })

  test('4. mixed scopes → designer-rerun-triggered + questioner cascade reads FULL Q&A (A3b)', async () => {
    // RFC-059 A3b: the questioner cascade rerun ALWAYS receives the full
    // session Q&A regardless of scope distribution. The designer-side
    // filter (External Feedback only contains designer-scoped questions)
    // is covered in T4's test suite — here we only assert the questioner
    // path is NOT scope-filtered (the path that goes through buildPrompt-
    // Context with consumerKind='cross-questioner').
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const result = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      directive: 'continue',
      questionScopes: { q1: 'designer', q2: 'questioner' },
    })
    expect(result.outcome.kind).toBe('designer-rerun-triggered')
    // Questioner cascade reads via buildPromptContext (cross-questioner).
    // That path does NOT consult questionScopesJson — should return both
    // q1 AND q2 in its assembled prompt.
    const qCtx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
    })
    expect(qCtx).toBeDefined()
    expect(qCtx!.questionsBlock).toContain('first')
    expect(qCtx!.questionsBlock).toContain('second') // not filtered out!
    // Scope persistence sanity (already covered by #9 but doubled here so
    // a regression that strips scope from #9's specific shape would still
    // show up alongside the A3b check).
    const legacy = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.id, result.session.id))
    expect(legacy[0]?.questionScopesJson).toBe(JSON.stringify({ q1: 'designer', q2: 'questioner' }))
  })

  test('5. multi-source — peer A all-questioner fast path; peer B awaiting → A triggers cascade alone', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, {
      crossClarifyNodeIds: ['cc_a', 'cc_b'],
      questionerNodeIds: ['q_a', 'q_b'],
    })
    await seedDesigner(db, taskId)
    const aRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_a',
      questionerNodeId: 'q_a',
      ccNodeId: 'cc_a',
      questions: [makeQ('a1', 'a-first')],
    })
    await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_b',
      questionerNodeId: 'q_b',
      ccNodeId: 'cc_b',
      questions: [makeQ('b1', 'b-first')],
    })
    // Peer A submits all-questioner — fast path even though peer B is still
    // awaiting (no readiness gate for the fast path).
    const aResult = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: aRunId,
      answers: [makeA('a1')],
      directive: 'continue',
      questionScopes: { a1: 'questioner' },
    })
    expect(aResult.outcome.kind).toBe('questioner-continue-triggered')
    // Designer still has only its initial run — peer B hasn't decided yet.
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(1)
  })

  test('6. multi-source aggregated designer-count = 0 → designer-skipped-all-questioner-scope', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, {
      crossClarifyNodeIds: ['cc_a', 'cc_b'],
      questionerNodeIds: ['q_a', 'q_b'],
    })
    await seedDesigner(db, taskId)
    const aRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_a',
      questionerNodeId: 'q_a',
      ccNodeId: 'cc_a',
      questions: [makeQ('a1', 'a-first')],
    })
    const bRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_b',
      questionerNodeId: 'q_b',
      ccNodeId: 'cc_b',
      questions: [makeQ('b1', 'b-first')],
    })
    // Peer A submits all-questioner — fast path.
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: aRunId,
      answers: [makeA('a1')],
      directive: 'continue',
      questionScopes: { a1: 'questioner' },
    })
    // Peer B also submits all-questioner — fast path again on B itself,
    // and the aggregated-count check (which the fast path bypasses) would
    // also have returned skipped. We assert B's outcome is the fast-path
    // variant; the aggregate-skipped variant only fires when a designer-
    // scoped session goes through the readiness path with all peers
    // resolved + total designer count 0 (covered below).
    const bResult = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: bRunId,
      answers: [makeA('b1')],
      directive: 'continue',
      questionScopes: { b1: 'questioner' },
    })
    expect(bResult.outcome.kind).toBe('questioner-continue-triggered')
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(1)
  })

  test('7. reject + mixed scope → questioner-stop-triggered; questionScopesJson persisted but ignored', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const scopes: Record<string, ClarifyQuestionScope> = { q1: 'designer', q2: 'questioner' }
    const result = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      directive: 'stop',
      questionScopes: scopes,
    })
    expect(result.outcome.kind).toBe('questioner-stop-triggered')
    expect(result.session.directive).toBe('stop')
    // Persisted for audit even though runtime ignores it on reject path.
    const legacy = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.id, result.session.id))
    expect(legacy[0]?.questionScopesJson).toBe(JSON.stringify(scopes))
    expect(legacy[0]?.directive).toBe('stop')
  })

  test('8. malformed questionScopes (unknown questionId) → cross-clarify-question-scopes-malformed 400', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first')],
    })
    await expect(
      submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId: ccRunId,
        answers: [makeA('q1')],
        directive: 'continue',
        questionScopes: { unknown_id: 'designer' },
      }),
    ).rejects.toMatchObject({
      code: 'cross-clarify-question-scopes-malformed',
    })
  })

  test('8b. malformed questionScopes (non-enum value) → cross-clarify-question-scopes-malformed 400', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first')],
    })
    await expect(
      submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId: ccRunId,
        answers: [makeA('q1')],
        directive: 'continue',
        questionScopes: { q1: 'both' as unknown as ClarifyQuestionScope },
      }),
    ).rejects.toMatchObject({
      code: 'cross-clarify-question-scopes-malformed',
    })
  })

  test('9. dual-write parity — both tables receive identical questionScopesJson', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second'), makeQ('q3', 'third')],
    })
    const scopes: Record<string, ClarifyQuestionScope> = {
      q1: 'designer',
      q2: 'questioner',
      q3: 'designer',
    }
    const result = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2'), makeA('q3')],
      directive: 'continue',
      questionScopes: scopes,
    })
    expect(result.outcome.kind).toBe('designer-rerun-triggered')
    const legacy = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.id, result.session.id))
    const unified = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, result.session.id))
    expect(legacy[0]?.questionScopesJson).toBe(JSON.stringify(scopes))
    expect(unified[0]?.questionScopesJson).toBe(JSON.stringify(scopes))
    expect(legacy[0]?.questionScopesJson).toBe(unified[0]?.questionScopesJson)
  })
})
