// RFC-056 patch 2026-05-24 — RFC-042 in-attempt retry preserves crossClarifyIteration.
//
// Symptom (user report): "在跨节点反问的时候，如果设计节点运行失败，重新执行
// 的时候，跨节点反问的内容就不在提示词里了". When the cross-clarify-triggered
// designer rerun's first attempt fails for any reason the RFC-042 retry path
// handles (process crash / timeout / envelope error / port validation), the
// retry attempt's prompt was missing the entire cross-clarify stack —
// `## External Feedback`, `## Prior Output (to be updated)`, `## Update
// Directive` — and on the questioner side `## Clarify Q&A` too. Designer
// silently fell back to white-board regenerate mode.
//
// Root cause: scheduler.ts:1147 RFC-042 retry path called `insertNodeRun`
// with an inherit map that included clarifyIteration / reviewIteration /
// shardKey / parentNodeRunId but NOT crossClarifyIteration. `insertNodeRun`
// (scheduler.ts:2466 prior to this patch) didn't even accept the field, so
// the retry row dropped to schema default 0 (schema.ts:386 default(0)). Next
// scheduler pass at :1306 read currentCrossClarifyIteration=0 → both gates
// (`isCrossClarifyTriggeredRerun` :1307, `isQuestionerCrossClarifyRerun`
// :1411) collapsed to false → `buildExternalFeedbackContext` :1448 returned
// undefined under its `args.designerCrossClarifyIteration <= 0` guard
// (crossClarify.ts:1038), `buildQuestionerCrossClarifyContext` :1414 was
// never called (its `<= 0` guard at :1125 would have caught it anyway),
// `priorOutputBlock` :1462 never composed.
//
// Pre-existing comment at scheduler.ts:1300 ("an in-attempt RFC-042 retry
// inherits crossClarifyIteration from the row it retries") already ASSUMED
// the inheritance — the author's invariant was right but the code didn't
// enforce it. This patch wires the assumption into the code via
// `inheritedCrossClarifyIteration` + the new `crossClarifyIteration` inherit
// field on `insertNodeRun`, mirroring how clarifyIteration / reviewIteration
// are inherited.
//
// This file locks the fix on three lines of defence:
//   1. Schema-of-mint: a node_run row inserted via the post-patch
//      `insertNodeRun` carries the caller-supplied `crossClarifyIteration`
//      verbatim; if omitted falls back to 0 (initial mint path).
//   2. Behavioural: against the live-shape DB state (designer pending row
//      already at crossClarifyIteration=1, retryIndex=10), the
//      `buildExternalFeedbackContext` / questioner gate logic that depends
//      on this row's iteration produces the expected non-empty blocks.
//   3. Source-text guard: scheduler.ts's two `insertNodeRun(...)` callsites
//      inside `scheduleAgentNode` BOTH include `crossClarifyIteration:` in
//      their inherit map, and `inheritedCrossClarifyIteration` is computed
//      off `latestExisting?.crossClarifyIteration ?? 0`. If a refactor
//      drops any of these the runtime regression is silent — the prompt
//      just stops carrying the cross-clarify stack — so we lock the source
//      text directly. Pairs with the source-text guards in
//      cross-clarify-update-mode-injection.test.ts.
//
// Live failure shape that motivated patch-2026-05-23-designer-retry-index
// (workflow `01KS7C0K5ZRJ29AZD7J13C42C2` "跨节点反问") was one round before
// this regression; this patch closes the same family of bugs along the
// in-attempt retry axis. If any of the three sections below go red the
// cross-clarify context is silently dropping on retries again — investigate
// before relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  buildQuestionerCrossClarifyContext,
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
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid: string): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
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
    name: 'retry-preserves-iteration',
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
    repoPath: '/tmp/aw-retry-preserves-iteration',
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
 * Mirror the inheritance-derivation block scheduler.ts uses to compute the
 * value an RFC-042 retry mint passes into `insertNodeRun`. Kept here as a
 * pure helper so the test can demonstrate the contract without booting the
 * scheduler. If the scheduler refactors the derivation into an exported
 * helper, replace this stub with a direct call — the assertions stay the
 * same.
 *
 * Mirrors scheduler.ts:1047-1062 (post-patch).
 */
function deriveInheritedCrossClarifyIteration(
  sameNodeIterRuns: Array<typeof nodeRuns.$inferSelect>,
): number {
  let latestExisting: (typeof sameNodeIterRuns)[number] | undefined
  for (const r of sameNodeIterRuns) {
    if (r.parentNodeRunId !== null) continue
    if (isFresherNodeRun(r, latestExisting)) latestExisting = r
  }
  return latestExisting?.crossClarifyIteration ?? 0
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 patch 2026-05-24 — RFC-042 retry preserves crossClarifyIteration', () => {
  test('inheritance derivation picks crossClarifyIteration off the freshest top-level row', async () => {
    // Live shape post patch-2026-05-23: designer ran self-clarify storm
    // (clarifyIter=6, retryIndex=9, done) then cross-clarify minted a new
    // pending at clarifyIter=6, retryIndex=10, crossClarifyIter=1. When
    // that pending attempt fails and RFC-042 kicks the inner retry loop,
    // scheduler.ts must inherit crossClarifyIteration=1 (NOT 0) on the
    // newly-minted retry row. The derivation must pick `latestExisting`
    // via `isFresherNodeRun` (keyed on clarifyIteration → retryIndex → id)
    // — which selects the new pending row (retry=10) over the prior done
    // (retry=9) — and read its crossClarifyIteration.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 9,
      clarifyIteration: 6,
      crossClarifyIteration: 0,
    })
    await seedRun(db, taskId, 'designer', {
      status: 'pending',
      retryIndex: 10,
      clarifyIteration: 6,
      crossClarifyIteration: 1,
    })
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    expect(deriveInheritedCrossClarifyIteration(rows)).toBe(1)
  })

  test('inheritance derivation returns 0 when no prior row exists (first-ever mint)', async () => {
    // Initial mint path (scheduler.ts:1063 `sameNodeIterRuns.length === 0`
    // branch). Must NOT over-fire: brand-new node has no row to inherit
    // from, so crossClarifyIteration stays at the schema default 0.
    expect(deriveInheritedCrossClarifyIteration([])).toBe(0)
  })

  test('inheritance derivation returns 0 when only fan-out children exist (parentNodeRunId set)', async () => {
    // Fan-out children are filtered out of latestExisting (scheduler.ts
    // :1049 `if (r.parentNodeRunId !== null) continue`). If a node's only
    // history is fan-out children, the top-level mint has nothing to
    // inherit from → 0.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 0,
      clarifyIteration: 0,
      crossClarifyIteration: 5,
      parentNodeRunId: 'some-parent',
    })
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    expect(deriveInheritedCrossClarifyIteration(rows)).toBe(0)
  })

  test('downstream context-build with crossClarifyIteration intact emits the External Feedback block', async () => {
    // Full forward pass: cross-clarify resolve mints a pending designer
    // row at crossClarifyIteration=1; even if a subsequent retry rebuilds
    // the prompt, as long as the retry row's crossClarifyIteration is
    // still 1, `buildExternalFeedbackContext` returns a populated block.
    // This is the "did the cross-clarify content actually make it into
    // the prompt" assertion — proxy for the user's symptom.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'in', { status: 'done' })
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 9,
      clarifyIteration: 6,
      crossClarifyIteration: 0,
      preSnapshot: 'snap-d',
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
      questions: [makeQ('q1', '测试设计是否覆盖断网场景？')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })

    // Now pretend the cross-clarify-triggered designer rerun failed once
    // and RFC-042 minted a retry row. The retry row MUST carry
    // crossClarifyIteration=1 (the contract this patch enforces). We
    // simulate it by writing the retry row directly with the inherited
    // value — exactly what scheduler.ts:1147 now does via
    // `inheritedCrossClarifyIteration`.
    const inherited = deriveInheritedCrossClarifyIteration(
      await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer'))),
    )
    expect(inherited).toBe(1)
    await seedRun(db, taskId, 'designer', {
      status: 'pending',
      retryIndex: 11,
      clarifyIteration: 6,
      crossClarifyIteration: inherited,
      preSnapshot: 'snap-d',
    })

    // The downstream context builder reads this retry row's iteration
    // implicitly via scheduler.ts:1306-1308; we exercise the underlying
    // helper directly with the inherited value.
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerCrossClarifyIteration: inherited,
      definition: fixtureDef(),
    })
    expect(ctx, 'External Feedback context must populate on retry').toBeDefined()
    expect(ctx?.block).toContain('测试设计是否覆盖断网场景？')
  })

  test('questioner-side context builds on retry too (mirrors designer-side regression)', async () => {
    // The same retry path applies to the questioner. If retry minted at
    // crossClarifyIteration=0, scheduler.ts:1411
    // `isQuestionerCrossClarifyRerun` flips false and the entire
    // `## Clarify Q&A` block disappears from the questioner's prompt. The
    // questioner re-emits its previous `<workflow-clarify>` envelope from
    // scratch, looping cross-clarify forever. Lock that the post-patch
    // retry row's crossClarifyIteration=1 still drives
    // `buildQuestionerCrossClarifyContext` to a non-empty result.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'in', { status: 'done' })
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 0,
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      preSnapshot: 'snap-d',
    })
    const qRun = await seedRun(db, taskId, 'questioner', {
      status: 'done',
      retryIndex: 0,
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
      questions: [makeQ('q1', '问卷端测试问题')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })

    // The cascade-mint inserts a new pending questioner row at the bumped
    // crossClarifyIteration. Read it back, simulate a retry mint under
    // post-patch inheritance rules.
    const qRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'questioner')))
    const inheritedQ = deriveInheritedCrossClarifyIteration(qRows)
    expect(inheritedQ).toBe(1)

    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: inheritedQ,
    })
    expect(ctx, 'Questioner cross-clarify context must populate on retry').toBeDefined()
    expect(ctx?.questionsBlock).toContain('问卷端测试问题')
    expect(ctx?.answersBlock).toContain('问卷端测试问题')
  })
})

describe('RFC-056 patch 2026-05-24 — scheduler source guard against inheritance regression', () => {
  // Source-code-text guards. If a future refactor drops the inheritance
  // (either omits `crossClarifyIteration` from `insertNodeRun`'s inherit
  // param, forgets to compute `inheritedCrossClarifyIteration`, or fails
  // to pass it at either callsite), the runtime symptom is silent — the
  // user's bug returns. Grep the source so silent re-introduction becomes
  // a hard CI fail. Pairs with the source-text guards in
  // cross-clarify-update-mode-injection.test.ts.

  test('insertNodeRun accepts crossClarifyIteration in its inherit param', () => {
    const src = readFileSync(SCHEDULER_SOURCE_PATH, 'utf8')
    // The `inherit?: { ... }` typedef on `insertNodeRun`. Bound the regex
    // to the function signature so we don't accidentally match unrelated
    // type aliases elsewhere in the file.
    const m = src.match(/async function insertNodeRun[\s\S]{0,400}inherit\?:\s*\{[^}]+\}/)
    expect(m, 'must find insertNodeRun inherit param typedef').not.toBeNull()
    expect(m![0]).toMatch(/crossClarifyIteration\?:\s*number/)
  })

  test('insertNodeRun writes crossClarifyIteration into the insert values', () => {
    const src = readFileSync(SCHEDULER_SOURCE_PATH, 'utf8')
    // The `db.insert(nodeRuns).values({...})` block inside insertNodeRun.
    const m = src.match(
      /async function insertNodeRun[\s\S]+?db\.insert\(nodeRuns\)\.values\(\{[\s\S]+?\}\)/,
    )
    expect(m, 'must find insertNodeRun insert-values block').not.toBeNull()
    expect(m![0]).toMatch(/crossClarifyIteration:\s*inherit\?\.crossClarifyIteration\s*\?\?\s*0/)
  })

  test('inheritedCrossClarifyIteration derivation is computed off latestExisting', () => {
    const src = readFileSync(SCHEDULER_SOURCE_PATH, 'utf8')
    expect(src).toMatch(
      /const\s+inheritedCrossClarifyIteration\s*=\s*latestExisting\?\.crossClarifyIteration\s*\?\?\s*0/,
    )
  })

  test('both insertNodeRun callsites inside scheduleAgentNode pass crossClarifyIteration', () => {
    const src = readFileSync(SCHEDULER_SOURCE_PATH, 'utf8')
    // There are exactly two `insertNodeRun(db, taskId, node.id, 'pending', ...)`
    // calls inside scheduleAgentNode: the initial mint (no-pending branch)
    // and the RFC-042 retry mint. Both must pass crossClarifyIteration in
    // their inherit map. Capture each call's argument block and assert.
    const callRe =
      /insertNodeRun\(db,\s*taskId,\s*node\.id,\s*'pending',\s*[^,]+,\s*iteration,\s*\{[\s\S]+?\}\s*\)/g
    const matches = src.match(callRe) ?? []
    // Three callers exist in the file overall (scheduler.ts seeds a
    // node-run for processError too — search wider); narrow to the ones
    // inside scheduleAgentNode by their proximity to inheritedClarifyIteration.
    const scheduleAgentNodeMintCalls = matches.filter((c) =>
      c.includes('inheritedClarifyIteration'),
    )
    expect(
      scheduleAgentNodeMintCalls.length,
      'scheduleAgentNode must have at least two insertNodeRun mint sites',
    ).toBeGreaterThanOrEqual(2)
    for (const call of scheduleAgentNodeMintCalls) {
      expect(call).toMatch(/crossClarifyIteration:\s*inheritedCrossClarifyIteration/)
    }
  })
})
