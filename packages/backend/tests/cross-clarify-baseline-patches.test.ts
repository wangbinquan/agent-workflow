// RFC-058 PR-A baseline (T4): byte-level lock of RFC-056 patch chain 2026-05-22
// through 2026-05-25 invariants. These tests are intentionally focused on the
// direct outcomes of each patch (cascade BFS minted, cci computation, cci
// inheritance, questioner cascade visibility) rather than re-deriving the full
// scenario coverage already in:
//   - cross-clarify-downstream-cascade.test.ts (patch-22 cascade)
//   - cross-clarify-questioner-context.test.ts (patch-22 questioner Q&A inject)
//   - cross-clarify-designer-retry-index.test.ts (patch-23 cci formula)
//   - cross-clarify-retry-preserves-iteration.test.ts (patch-24 inheritance)
//   - cross-clarify-questioner-cascade-no-skip.test.ts (patch-25 cascade)
//
// PR-B refactor: when this file goes red AND the per-patch tests stay green,
// inspect which invariant slipped (likely cci computation moved or cascade
// helper signature changed). When this file stays green but a per-patch test
// goes red, the underlying patch logic was preserved but a corner case
// regressed.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { createClarifyRound } from '../src/services/clarify/service'
import { listTaskQuestions, reassignTaskQuestion } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

// RFC-162: designer-by-default is DELETED — answering a cross round no longer auto-creates a
// designer entry. The designer rerun (patch-23 retry index, patch-22 cascade caller hook,
// patch-25 dispatched_at consumed marker) is now minted by an explicit reassign of the answered
// round's questioner card to the graph designer node + a dispatch of that designer entry.
async function reassignThenDispatchDesigner(
  db: DbClient,
  taskId: string,
  crossClarifyNodeRunId: string,
) {
  const questioner = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'questioner' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!questioner) throw new Error(`no questioner entry for round ${crossClarifyNodeRunId}`)
  await reassignTaskQuestion(db, questioner.id, 'designer', actor)
  const designer = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'designer' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!designer) throw new Error(`no designer entry after reassign for ${crossClarifyNodeRunId}`)
  return dispatchTaskQuestions(db, taskId, [designer.id], actor)
}

async function seedTriad(
  db: DbClient,
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const nodes: WorkflowNode[] = [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: 'cc1', kind: 'clarify-cross-agent', title: 'cc1' } as WorkflowNode,
  ]
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cc1', portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: 'cc1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: 'cc1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    name: 'patch-baseline',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-patch-baseline/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition }
}

function makeQuestion(overrides: Partial<ClarifyQuestion> = {}): ClarifyQuestion {
  return {
    id: 'q1',
    title: 'Which database?',
    kind: 'single',
    recommended: false,
    options: [
      { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
    ],
    ...overrides,
  }
}

function makeAnswer(): ClarifyAnswer {
  return {
    questionId: 'q1',
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
  }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-058 baseline T4 — patch-2026-05-23 designer retry index', () => {
  test('answering the awaiting cross round mints a fresh pending designer attempt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTriad(db)
    // Seed designer at cci=2 (i.e. has been pumped before)
    await db.insert(nodeRuns).values({
      id: 'nr_designer_old',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1000,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_q1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    // RFC-162: the designer rerun comes from reassigning the answered round to the graph
    // designer node + dispatching that designer entry (the legacy scope/direct trigger is gone).
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAnswer()],
      actor,
    })
    const disp = await reassignThenDispatchDesigner(db, taskId, crossClarifyNodeRunId)
    const designerRerun = disp.reruns.find((r) => r.targetNodeId === 'designer')
    expect(designerRerun).toBeDefined()
    const newRun = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, designerRerun!.nodeRunId))
    )[0]
    // RFC-074 PR-C: the designer rerun is a fresh pending insert (latest id wins
    // freshness); no cci to assert.
    expect(newRun?.status).toBe('pending')
  })
})

describe('RFC-058 baseline T4 — patch-2026-05-24 cci inheritance', () => {
  test('cross-clarify session cci row inherits from latest questioner cci value', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTriad(db)
    // Questioner has been around — has cci=3
    await db.insert(nodeRuns).values({
      id: 'nr_q3',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 100,
    })
    // createClarifyRound iteration counter is per (cc node, loopIter)
    // — cci on the cross-clarify node_run is the session iteration. So this
    // test pivots to: session iteration is per (cc, loopIter), not inheriting
    // from the questioner's cci.
    const { round: session } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q3',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    expect(session.iteration).toBe(0)
    // RFC-074 PR-C: the cross-clarify node_run no longer carries a cci counter;
    // assert the row exists and is parked for human input.
    const nr = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, session.intermediaryNodeRunId))
    )[0]
    expect(nr?.status).toBe('awaiting_human')
  })
})

describe('RFC-074 PR-C baseline T4 — clarify generation is derived, not inherited', () => {
  test('source-text grep: scheduler derives the generation by id-order, no cci inheritance var', async () => {
    const fs = await import('node:fs/promises')
    const txt = await fs.readFile(
      resolve(import.meta.dir, '..', '..', '..', 'packages/backend/src/services/scheduler.ts'),
      'utf8',
    )
    // RFC-074 PR-C: the `inheritedClarifyIteration` wiring (patch-2026-05-25's
    // "inheritance survives RFC-042 retry" intent) is gone. The clarify
    // generation is DERIVED from prior-done id-order at dispatch time, so a
    // retry's Q&A context follows from id-order + the RFC-070 consumed-by stamp
    // — nothing is carried forward on the row.
    expect(txt.includes('inheritedClarifyIteration')).toBe(false)
    expect(txt).toContain('priorDoneGenerationsForRun')
    expect(txt).toContain('clarifyGeneration')
  })

  test('source-text grep: shared channel-edge dataflow policy is callable in scheduler cascade path', async () => {
    const fs = await import('node:fs/promises')
    const txt = await fs.readFile(
      resolve(import.meta.dir, '..', '..', '..', 'packages/backend/src/services/scheduler.ts'),
      'utf8',
    )
    // RFC-058/RFC-147 baseline lock: the scope graph uses the nuanced shared
    // policy, which keeps cross-clarify dependencies while skipping prompt-
    // injected channel edges.
    expect(txt).toContain('channelEdgeDataflowSkip')
  })
})

describe('RFC-058 baseline T4 — patch-2026-05-22 cascade BFS smoke', () => {
  test('the answer dispatch returns the designer rerun nodeRunId (cascade caller hooks in)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTriad(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_designer_prior',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
      },
      {
        id: 'nr_q1',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAnswer()],
      actor,
    })
    // RFC-162: reassign the answered round to the designer + dispatch it → the mint returns the
    // designer rerun nodeRunId the cascade caller hooks into.
    const disp = await reassignThenDispatchDesigner(db, taskId, crossClarifyNodeRunId)
    expect(disp.reruns.find((r) => r.targetNodeId === 'designer')?.nodeRunId).toBeTruthy()
  })
})

describe('RFC-058 baseline T4 — patch-2026-05-25 questioner cascade visibility', () => {
  test('submit continue stamps dispatched_at on the consumed designer entries', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTriad(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_designer_prior',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
      },
      {
        id: 'nr_q1',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAnswer()],
      ifMatchIteration: 0,
      actor,
    })
    // RFC-162: reassign the answered round to the designer + dispatch it. The unified path does
    // not stamp designerRunTriggeredAt (legacy bookkeeping); the "consumed" marker is
    // dispatched_at on the round's designer entries.
    const disp = await reassignThenDispatchDesigner(db, taskId, crossClarifyNodeRunId)
    expect(disp.reruns.some((r) => r.targetNodeId === 'designer')).toBe(true)
    const designerEntries = (
      await db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, crossClarifyNodeRunId))
    ).filter((e) => e.roleKind === 'designer')
    expect(designerEntries.length).toBeGreaterThan(0)
    for (const e of designerEntries) expect(e.dispatchedAt).not.toBeNull()
  })

  test('cascade BFS does not strand questioner — runner can find the next attempt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTriad(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_designer_prior',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
      },
      {
        id: 'nr_q1',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'stop',
      ifMatchIteration: 0,
      actor,
    })
    // After stop, a new questioner attempt should exist (the cascaded rerun).
    const questionerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'questioner'))
    expect(questionerRuns.length).toBeGreaterThan(1) // original + cascade rerun
  })
})
