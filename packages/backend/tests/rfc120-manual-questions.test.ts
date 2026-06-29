// RFC-120 §15 — manual questions (自主新增/复制). A manual question = a human authors a
// title + instruction and assigns an agent node; dispatching reruns that node with the
// instruction injected as External Feedback (NO human-answer step). It is a
// source_kind='manual' task_questions row that REUSES the §18 per-node-queue dispatch +
// injection unchanged (its injected content is manual_body instead of a round's Q&A).
//
// Locks:
//   A. lifecycle — create → (reassign) → dispatch → buildExternalFeedbackContext injects
//      manual_body + binds → handler done+output → awaiting_confirm → confirm → done.
//   B. §16 H4 — two manual rows with synthetic (non-null, unique) origin coexist (no unique
//      collision); a dispatched manual row is VISIBLE in the list with the correct phase
//      (the old origin→round skip would have made it invisible).
//   C. dispatch fit — a manual entry flows through dispatchTaskQuestions like a pure-override
//      (frontier mint on its assigned node, NO graph-designer readiness block).
//   D. create semantics — target given → staged (待下发); omitted → pending (待指派);
//      validation (empty title/body, non-agent target); audit-only author never in prompt.
//   E. golden-lock — zero manual rows ⇒ the cross-clarify injection block is byte-identical
//      (no `Manual instruction` contamination).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import {
  confirmTaskQuestion,
  createManualTaskQuestion,
  listTaskQuestions,
  loadUndispatchedDesignerTargets,
  reassignTaskQuestion,
} from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { deriveFrontier } from '../src/services/scheduler'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const DESIGNER = 'designer'
const QUESTIONER = 'questioner'
const CC = 'cross1'
const FIXER = 'fixer' // a plain agent node with a prior run + NO __external_feedback__ edge
const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: FIXER, kind: 'agent-single', agentName: 'fixer' } as WorkflowNode,
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

/** Seed a deferred task + workflow snapshot + a prior `done` run on FIXER (so a frontier
 *  dispatch to it is not rejected as never-run). No clarify round needed for manual. */
async function seedTask(db: DbClient, opts: { deferred?: boolean } = {}): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc120-manual',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc120-manual',
    ownerUserId: '__system__',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc120-manual/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    deferredQuestionDispatch: opts.deferred ?? true,
  })
  // FIXER prior run (ULID id so freshness/lineage windows order before later mints).
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: FIXER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  return taskId
}

async function listOne(db: DbClient, taskId: string) {
  const all = await listTaskQuestions(db, taskId)
  return all.find((e) => e.sourceKind === 'manual')
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// A — full manual lifecycle.
// ---------------------------------------------------------------------------
describe('RFC-120 §15 — manual question lifecycle', () => {
  test('create(target=DESIGNER) → reassign(FIXER) → dispatch → inject manual_body+bind → done → confirm', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // DESIGNER needs a prior run too (the §15 re-gate requires the manual handler to have run).
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: DESIGNER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 900,
    })

    // create WITH a handler (required, §15) → 待下发 (staged). DESIGNER first to exercise reassign.
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      {
        title: 'Tighten the retry backoff',
        body: 'Cap retries at 3 with jitter.',
        targetNodeId: DESIGNER,
      },
      actor,
    )
    let dto = await listOne(db, taskId)
    expect(dto).toBeDefined()
    expect(dto?.sourceKind).toBe('manual')
    expect(dto?.roleKind).toBe('designer')
    expect(dto?.questionTitle).toBe('Tighten the retry backoff')
    expect(dto?.answerSummary).toBe('Cap retries at 3 with jitter.')
    expect(dto?.sourceNodeId).toBeNull()
    expect(dto?.originNodeRunId).toBeNull()
    expect(dto?.effectiveTargetNodeId).toBe(DESIGNER)
    expect(dto?.phase).toBe('staged')

    // re-target the handler via the SAME reassign service used for clarify designer entries.
    await reassignTaskQuestion(db, id, FIXER, actor)
    dto = await listOne(db, taskId)
    expect(dto?.effectiveTargetNodeId).toBe(FIXER)
    // still staged (reassign only moves the handler) → awaiting dispatch.
    expect(dto?.phase).toBe('staged')

    // dispatch via the §18 per-node-queue (UNCHANGED) → frontier mint on FIXER.
    const result = await dispatchTaskQuestions(db, taskId, [id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(FIXER)
    const runId = result.reruns[0]!.nodeRunId
    // dispatched_at stamped, not yet bound → processing.
    let row = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]
    expect(row?.dispatchedAt).not.toBeNull()
    expect(row?.dispatchedBy).toBe('u1')
    expect(row?.triggerRunId).toBeNull()
    expect((await listOne(db, taskId))?.phase).toBe('processing')

    // FIXER reruns → buildExternalFeedbackContext injects manual_body + binds (per-node queue).
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: FIXER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: runId,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.block).toContain('Cap retries at 3 with jitter.')
    expect(ctx?.block).toContain('Manual instruction: Tighten the retry backoff')
    expect(ctx?.runScoped).toBe(true)
    // a pure-manual handoff is NOT graph-owned (must process the instruction, not rewrite).
    expect(ctx?.graphOwned).toBe(false)
    row = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]
    expect(row?.triggerRunId).toBe(runId) // bound at rerun
    expect((await listOne(db, taskId))?.phase).toBe('processing') // run still pending

    // run finishes done+output → 已处理待确认.
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, runId))
    await db.insert(nodeRunOutputs).values({ nodeRunId: runId, portName: 'result', content: 'x' })
    expect((await listOne(db, taskId))?.phase).toBe('awaiting_confirm')

    // confirm → 完成.
    await confirmTaskQuestion(db, id, actor)
    const done = await listOne(db, taskId)
    expect(done?.phase).toBe('done')
    expect(done?.confirmation).toBe('confirmed')
  })

  test('create WITH a target → staged (待下发) immediately, ready for batch-dispatch', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await createManualTaskQuestion(
      db,
      taskId,
      { title: 'Add a smoke test', body: 'Cover the happy path.', targetNodeId: FIXER },
      actor,
    )
    const dto = await listOne(db, taskId)
    expect(dto?.phase).toBe('staged')
    expect(dto?.staged).toBe(true)
    expect(dto?.effectiveTargetNodeId).toBe(FIXER)
  })

  test('reusing the answer label — manual_body renders as the injected External Feedback content', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'T', body: 'BODY-MARKER-XYZ', targetNodeId: FIXER },
      actor,
    )
    const result = await dispatchTaskQuestions(db, taskId, [id], actor)
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: FIXER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: result.reruns[0]!.nodeRunId,
    })
    expect(ctx?.block).toContain('BODY-MARKER-XYZ')
  })
})

// ---------------------------------------------------------------------------
// B — §16 H4: synthetic identity (no collision) + visible-when-dispatched.
// ---------------------------------------------------------------------------
describe('RFC-120 §16 H4 — manual identity + visibility', () => {
  test('two manual rows with the SAME title/body coexist (no unique collision) + both visible', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const a = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'dupe', body: 'same', targetNodeId: FIXER },
      actor,
    )
    const b = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'dupe', body: 'same', targetNodeId: FIXER },
      actor,
    )
    expect(a.id).not.toBe(b.id)
    const rows = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
    expect(rows.length).toBe(2)
    // distinct synthetic origins keep the full uniq_task_questions_identity collision-free.
    expect(rows[0]?.originNodeRunId).not.toBe(rows[1]?.originNodeRunId)
    const list = await listTaskQuestions(db, taskId)
    expect(list.filter((e) => e.sourceKind === 'manual').length).toBe(2)
  })

  test('a DISPATCHED manual row is VISIBLE in the list with the correct phase', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'visible?', body: 'yes', targetNodeId: FIXER },
      actor,
    )
    await dispatchTaskQuestions(db, taskId, [id], actor)
    const list = await listTaskQuestions(db, taskId)
    const dto = list.find((e) => e.id === id)
    expect(dto).toBeDefined() // would be undefined under the old origin→round skip (H4 bug)
    expect(dto?.phase).toBe('processing')
  })

  test('manual rows never match a sourceNodeId filter (they have no source node)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: FIXER },
      actor,
    )
    const filtered = await listTaskQuestions(db, taskId, { sourceNodeId: FIXER })
    expect(filtered.length).toBe(0)
    const unfiltered = await listTaskQuestions(db, taskId)
    expect(unfiltered.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// C — dispatch fit (pure-override path, no graph readiness block).
// ---------------------------------------------------------------------------
describe('RFC-120 §15 — manual flows through dispatch like a pure-override', () => {
  test('dispatch to a node with NO __external_feedback__ edge succeeds (no designer-not-ready)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // FIXER has a prior run but no cross-clarify graph wiring. assertDesignerReady self-scopes
    // to default_target==node (NULL for manual) → skipped. assertSafeFrontierTarget passes
    // (prior run). So a manual entry dispatches like a pure-override with no readiness gate.
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: FIXER },
      actor,
    )
    const result = await dispatchTaskQuestions(db, taskId, [id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(FIXER)
  })

  test('two manual rows assigned to DIFFERENT nodes dispatch together (synthetic origins ⇒ no round-multi-target)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // DESIGNER also needs a prior run to be a valid frontier mint target.
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: DESIGNER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 800,
    })
    const a = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'a', body: 'aa', targetNodeId: FIXER },
      actor,
    )
    const b = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'b', body: 'bb', targetNodeId: DESIGNER },
      actor,
    )
    // Each manual row is its own (synthetic) origin → the per-origin single-target guard
    // never trips even though the two go to different handlers.
    const result = await dispatchTaskQuestions(db, taskId, [a.id, b.id], actor)
    expect(result.reruns.map((r) => r.targetNodeId).sort()).toEqual([DESIGNER, FIXER].sort())
  })

  test('Codex re-gate H1: a never-run target is rejected at CREATION (not parked-then-undispatchable)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // QUESTIONER has no prior run. The §15 re-gate rejects it at CREATION (a manual on a never-
    // run node would park via H1 but dispatch's assertSafeFrontierTarget could never mint it →
    // stranded). So the unsafe-dispatch state is now unreachable for manual: nothing inserted.
    let threw: unknown = null
    try {
      await createManualTaskQuestion(
        db,
        taskId,
        { title: 't', body: 'b', targetNodeId: QUESTIONER },
        actor,
      )
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('manual-question-target-never-run')
    const rows = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
    expect(rows.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// D — create semantics + validation + prompt isolation.
// ---------------------------------------------------------------------------
describe('RFC-120 §15 — create validation + audit isolation', () => {
  test('empty title / empty body → ValidationError', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    expect(
      createManualTaskQuestion(db, taskId, { title: '  ', body: 'b', targetNodeId: FIXER }, actor),
    ).rejects.toThrow()
    expect(
      createManualTaskQuestion(db, taskId, { title: 't', body: ' ', targetNodeId: FIXER }, actor),
    ).rejects.toThrow()
  })

  test('Codex re-gate: a handler is REQUIRED — create WITHOUT targetNodeId → rejected, nothing inserted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    let threw: unknown = null
    try {
      await createManualTaskQuestion(db, taskId, { title: 't', body: 'b' }, actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('manual-question-target-required')
    const rows = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
    expect(rows.length).toBe(0) // nothing inserted
  })

  test('non-agent / unknown target node → ValidationError (canReassign parity)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // CC is a clarify-cross-agent (NOT kind=agent) → rejected.
    expect(
      createManualTaskQuestion(db, taskId, { title: 't', body: 'b', targetNodeId: CC }, actor),
    ).rejects.toThrow()
    expect(
      createManualTaskQuestion(db, taskId, { title: 't', body: 'b', targetNodeId: 'ghost' }, actor),
    ).rejects.toThrow()
  })

  test('audit author (manual_created_by) is stored but NEVER appears in the injected prompt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const secretActor = { userId: 'SECRET-AUTHOR-ID', role: 'owner' as const }
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'T', body: 'B', targetNodeId: FIXER },
      secretActor,
    )
    const row = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]
    expect(row?.manualCreatedBy).toBe('SECRET-AUTHOR-ID') // recorded for audit
    const result = await dispatchTaskQuestions(db, taskId, [id], actor)
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: FIXER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: result.reruns[0]!.nodeRunId,
    })
    expect(ctx?.block).not.toContain('SECRET-AUTHOR-ID') // prompt isolation (RFC-099)
  })
})

// ---------------------------------------------------------------------------
// F — Codex impl-gate H1: a staged manual row parks the deferred task (scheduler-level).
// A synthetic-origin manual row has NO clarify round, so the park gate's INNER JOIN used to
// miss it → the scheduler could complete the task past an undispatched manual question (then
// a later dispatch can't resume a `done` task → instruction lost). The gate now includes
// manual designer rows via their own content-ready semantics.
// ---------------------------------------------------------------------------
describe('RFC-120 §15 — Codex impl-gate H1 (manual park gate)', () => {
  test('a staged-undispatched manual row enters loadUndispatchedDesignerTargets; dispatch releases it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db) // deferred; FIXER has a prior run
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: FIXER },
      actor,
    )
    // undispatched manual WITH a handler → parks FIXER (was INVISIBLE before the H1 fix:
    // the synthetic origin has no clarify round so the INNER JOIN dropped it).
    expect((await loadUndispatchedDesignerTargets(db, taskId)).has(FIXER)).toBe(true)
    await dispatchTaskQuestions(db, taskId, [id], actor)
    // dispatched → leaves the undispatched set (gate released).
    expect((await loadUndispatchedDesignerTargets(db, taskId)).has(FIXER)).toBe(false)
  })

  test('scheduler deriveFrontier PARKS the manual handler (awaiting_human, not completed) until dispatched', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: FIXER },
      actor,
    )
    const scopeNodes = liveDef().nodes as unknown as WorkflowNode[]
    const scopeIds = new Set(scopeNodes.map((n) => n.id))
    const NONE: ReadonlySet<string> = new Set()

    // BEFORE dispatch: FIXER is undispatched → deriveFrontier must NOT complete it (the
    // scheduler keeps the task awaiting_human so it can't finish past the manual question).
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const deferredBefore = await loadUndispatchedDesignerTargets(db, taskId)
    expect(deferredBefore.has(FIXER)).toBe(true)
    const fBefore = deriveFrontier(
      rows,
      liveDef(),
      scopeNodes,
      scopeIds,
      0,
      new Map(),
      NONE,
      NONE,
      NONE,
      NONE,
      NONE,
      deferredBefore,
    )
    expect(fBefore.awaitingHuman).toContain(FIXER)
    expect(fBefore.completed.has(FIXER)).toBe(false)

    // AFTER dispatch: FIXER leaves the set → deriveFrontier no longer parks it (its rerun runs).
    await dispatchTaskQuestions(db, taskId, [id], actor)
    const rows2 = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const deferredAfter = await loadUndispatchedDesignerTargets(db, taskId)
    expect(deferredAfter.has(FIXER)).toBe(false)
    const fAfter = deriveFrontier(
      rows2,
      liveDef(),
      scopeNodes,
      scopeIds,
      0,
      new Map(),
      NONE,
      NONE,
      NONE,
      NONE,
      NONE,
      deferredAfter,
    )
    expect(fAfter.awaitingHuman).not.toContain(FIXER)
  })
})

// ---------------------------------------------------------------------------
// G — Codex impl-gate H2: manual creation rejected on a non-deferred task (it could never
// be dispatched / injected → undispatchable orphan data).
// ---------------------------------------------------------------------------
describe('RFC-120 §15 — Codex impl-gate H2 (non-deferred create rejected)', () => {
  test('create on a NON-deferred task → ConflictError task-not-deferred-dispatch; nothing inserted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, { deferred: false })
    let threw: unknown = null
    try {
      await createManualTaskQuestion(
        db,
        taskId,
        { title: 't', body: 'b', targetNodeId: FIXER },
        actor,
      )
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-not-deferred-dispatch')
    const rows = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
    expect(rows.length).toBe(0) // nothing inserted
  })

  test('create on a deferred task → succeeds (control)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db) // deferred
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: FIXER },
      actor,
    )
    expect(id).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// H — Codex re-gate: create + dispatch rejected on a TERMINAL task (done/canceled) so no row
// is inserted / no node_run minted on a finished task with no scheduler to run it.
// ---------------------------------------------------------------------------
describe('RFC-120 §15 — Codex re-gate (terminal task guard)', () => {
  for (const status of ['done', 'canceled'] as const) {
    test(`create on a ${status} deferred task → rejected task-terminal; nothing inserted`, async () => {
      const db = createInMemoryDb(MIGRATIONS)
      const taskId = await seedTask(db)
      await db.update(tasks).set({ status }).where(eq(tasks.id, taskId))
      let threw: unknown = null
      try {
        await createManualTaskQuestion(
          db,
          taskId,
          { title: 't', body: 'b', targetNodeId: FIXER },
          actor,
        )
      } catch (e) {
        threw = e
      }
      expect((threw as { code?: string }).code).toBe('task-terminal')
      const rows = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
      expect(rows.length).toBe(0)
    })

    test(`dispatch on a ${status} deferred task → rejected task-terminal; no dispatched_at, no node_run minted`, async () => {
      const db = createInMemoryDb(MIGRATIONS)
      const taskId = await seedTask(db)
      // create + stage WHILE running (allowed), then the task goes terminal before dispatch.
      const { id } = await createManualTaskQuestion(
        db,
        taskId,
        { title: 't', body: 'b', targetNodeId: FIXER },
        actor,
      )
      const runsBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
        .length
      await db.update(tasks).set({ status }).where(eq(tasks.id, taskId))
      let threw: unknown = null
      try {
        await dispatchTaskQuestions(db, taskId, [id], actor)
      } catch (e) {
        threw = e
      }
      expect((threw as { code?: string }).code).toBe('task-terminal')
      // nothing stamped, nothing minted.
      const row = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]
      expect(row?.dispatchedAt).toBeNull()
      const runsAfter = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
      expect(runsAfter).toBe(runsBefore) // no new node_run
    })
  }

  test('control: create + dispatch on a FAILED (resumable) deferred task → allowed (not terminal)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.update(tasks).set({ status: 'failed' }).where(eq(tasks.id, taskId))
    // failed is resumable (resumeTask resumes it), so manual create + dispatch are allowed.
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: FIXER },
      actor,
    )
    const result = await dispatchTaskQuestions(db, taskId, [id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(FIXER)
  })
})

// ---------------------------------------------------------------------------
// E — golden-lock: zero manual rows ⇒ clarify injection byte-identical.
// ---------------------------------------------------------------------------
describe('RFC-120 §15 — golden-lock (no manual rows ⇒ clarify unchanged)', () => {
  test('a deferred cross-clarify designer injection is unaffected (no Manual instruction section)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // Seed a cross-clarify round + answer (deferred) so the designer has a per-node queue.
    const qRunId = ulid()
    await db.insert(nodeRuns).values({
      id: qRunId,
      taskId,
      nodeId: QUESTIONER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: DESIGNER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 700,
    })
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: CC,
      sourceQuestionerNodeId: QUESTIONER,
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: DESIGNER,
      loopIter: 0,
      questions: [mkQ('q1', 'CLARIFY-Q-MARKER?')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['A'],
          customText: '',
        },
      ],
      directive: 'continue',
    })
    const designer = (
      await db
        .select()
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
    ).find((e) => e.sourceKind === 'cross')!
    const result = await dispatchTaskQuestions(db, taskId, [designer.id], actor)
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: result.reruns[0]!.nodeRunId,
    })
    expect(ctx?.block).toContain('CLARIFY-Q-MARKER?')
    expect(ctx?.block).not.toContain('Manual instruction') // no manual contamination
    expect(ctx?.sourcesCsv).not.toContain('manual')
    expect(ctx?.graphOwned).toBe(true) // genuine graph designer round
  })
})

// ---------------------------------------------------------------------------
// I — Codex re-gate: H1 (manual reassign to a never-run node rejected) + H2 (terminal status
// is an IN-TX CAS, not just a pre-check — a status flip between guard and write rolls back).
// (The clarify-designer OVERRIDE path keeps its shipped reject-at-dispatch design — proven by
// rfc120-deferred-dispatch.test.ts's "never-run override target → rejected"; the manual guard
// is scoped to source_kind='manual', so that override test is unaffected.)
// ---------------------------------------------------------------------------
describe('RFC-120 §15 — Codex re-gate H1 (manual reassign never-run) + H2 (terminal CAS)', () => {
  test('H1: reassign a manual question to a never-run node → rejected; to a run node → allowed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // DESIGNER gets a run so it is a valid (runnable) re-target; QUESTIONER stays never-run.
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: DESIGNER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 900,
    })
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: FIXER },
      actor,
    )
    // never-run QUESTIONER → rejected (no park-but-undispatchable).
    let threw: unknown = null
    try {
      await reassignTaskQuestion(db, id, QUESTIONER, actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('manual-question-target-never-run')
    expect((await listOne(db, taskId))?.effectiveTargetNodeId).toBe(FIXER) // unchanged
    // run DESIGNER → allowed.
    await reassignTaskQuestion(db, id, DESIGNER, actor)
    expect((await listOne(db, taskId))?.effectiveTargetNodeId).toBe(DESIGNER)
  })

  // A db Proxy that flips tasks.status to `status` exactly once, on the FIRST nodeRuns read —
  // which for BOTH create (taskNodeHasRun) and dispatch (assertSafeFrontierTarget) is the last
  // async read BEFORE the write tx. So the pre-check sees a live task, the status flips, and
  // the in-tx CAS re-read must catch it. Mirrors the dispatch/reassign-race test's Proxy.
  function flipStatusOnFirstNodeRunsRead(db: DbClient, taskId: string, status: string) {
    let fired = false
    return new Proxy(db, {
      get(target, prop, receiver) {
        const orig = Reflect.get(target, prop, receiver)
        if (prop !== 'select') return orig
        return (...selectArgs: unknown[]) => {
          const builder = (orig as (...a: unknown[]) => Record<string, unknown>).apply(
            target,
            selectArgs,
          )
          const origFrom = (builder.from as (t: unknown) => Record<string, unknown>).bind(builder)
          builder.from = (tbl: unknown) => {
            const q = origFrom(tbl)
            if (tbl === nodeRuns && !fired) {
              fired = true
              const origThen = (q.then as (...a: unknown[]) => unknown).bind(q)
              q.then = (onF: unknown, onR: unknown) =>
                db
                  .update(tasks)
                  .set({ status: status as never })
                  .where(eq(tasks.id, taskId))
                  .then(() => origThen(onF, onR), onR as never)
            }
            return q
          }
          return builder
        }
      },
    }) as typeof db
  }

  test('H2: create — task flips to done BETWEEN the pre-check and the insert tx → rolls back, nothing inserted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db) // running; FIXER has a run
    const racingDb = flipStatusOnFirstNodeRunsRead(db, taskId, 'done')
    let threw: unknown = null
    try {
      await createManualTaskQuestion(
        racingDb,
        taskId,
        { title: 't', body: 'b', targetNodeId: FIXER },
        actor,
      )
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-terminal')
    // in-tx CAS rolled back → NO row inserted.
    const rows = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
    expect(rows.length).toBe(0)
  })

  test('H2: dispatch — task flips to canceled BETWEEN the pre-check and the stamp+mint tx → rolls back, no dispatched_at / no node_run', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const { id } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 't', body: 'b', targetNodeId: FIXER },
      actor,
    )
    const runsBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    const racingDb = flipStatusOnFirstNodeRunsRead(db, taskId, 'canceled')
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(racingDb, taskId, [id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-terminal')
    // in-tx CAS rolled back → entry NOT stamped, NO node_run minted.
    const row = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]
    expect(row?.dispatchedAt).toBeNull()
    const runsAfter = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    expect(runsAfter).toBe(runsBefore)
  })
})
