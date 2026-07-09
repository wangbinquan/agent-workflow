// RFC-140 (design/RFC-140-one-click-dispatch-all) — 批量下发一次点击全下发。
//
// Live trigger (task 01KWFZRQFPZFQQEM8JTCHQMGP5 "QMGP5", 2026-07-03 16:21): a batch dispatch of
// 10 entries delivered only 5 — the user had reassigned q1's QUESTIONER entry onto the round's
// DESIGNER node, so that one home carried two mutually-exclusive causes and the RFC-128 §5.2.13
// auto-split deferred all 5 designer entries; the deferral was non-persistent and nothing ever
// auto-continued it (the user had to remember to re-click after the first rerun finished).
//
// W1 — symmetric collapse (mirror of RFC-138): reassigning a cross QUESTIONER entry to its
//   round's designer (targetConsumerNodeId) flips the question's scope to 'designer' — the
//   designer row becomes the question's ONLY handler (one run, one delivery), the asking node
//   keeps visibility via an ECHO receipt (RFC-134 — the asymmetry vs RFC-138, where the survivor
//   itself points at the asking node). Survivor three-branch (Codex design-gate P2 ×2 rounds):
//   undispatched stale third-node override → normalized back to the designer; dispatched &&
//   effective == designer → collapse proceeds, survivor untouched (D6 mirror); dispatched &&
//   effective == third node → 409 (committed work; reopen's job).
// W2 — deferred auto-serial redispatch: auto-split-deferred entries get a persisted
//   `auto_dispatch_deferred_at` marker (stamped in the dispatch tx, lock B held across the whole
//   read→plan→stamp pipeline); the scheduler tick redispatches (marker + undispatched + staged)
//   via ONE full-set dispatchTaskQuestions call ('__system__' actor). Stage/unstage BOTH clear
//   the marker (lifecycle invariant: born only from a user-clicked dispatch; any staging change
//   kills it). Retryable conflicts (DESIGNER_DEFERRABLE_CONFLICTS) keep the marker; anything
//   else clears it (back to the manual board, never silent-spin).

import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  crossClarifySessions,
  nodeRuns,
  nodeRunOutputs,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { autoDispatchDeferredQuestions } from '../src/services/clarifyAutoDispatch'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { reassignTaskQuestion, stageTaskQuestion } from '../src/services/taskQuestions'
import { ConflictError } from '../src/util/errors'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const ASKER = 'asker' // cross 轮提问节点
const DESIGNER = 'designer' // cross 轮图设计节点（塌缩目标 / 混批 home）
const OTHER = 'other' // 第三 agent 节点（golden-lock / 三分支 409）
const CC = 'cc'
const CL = 'cl'
const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: ASKER, kind: 'agent-single', agentName: 'agent-asker' } as WorkflowNode,
    { id: DESIGNER, kind: 'agent-single', agentName: 'agent-designer' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: 'agent-other' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_dataflow',
        source: { nodeId: DESIGNER, portName: 'out' },
        target: { nodeId: ASKER, portName: 'in' },
      },
      {
        id: 'e_cc_designer',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_questioner',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: ASKER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  } as unknown as WorkflowDefinition
}

function mkQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `${id}-title`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function ans(qid: string) {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

async function seedTask(db: DbClient, taskId: string): Promise<void> {
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc140',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc140',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc140',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  over: { status?: string; hasOutput?: boolean; rerunCause?: string } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: 0,
    ...(over.rerunCause ? { rerunCause: over.rerunCause } : {}),
  })
  if (over.hasOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'out', content: 'x' })
  }
  return id
}

async function seedCrossRound(
  db: DbClient,
  taskId: string,
  questions: ClarifyQuestion[],
  opts: { scopesJson?: string | null } = {},
): Promise<{ roundId: string; origin: string }> {
  const askingRunId = await seedRun(db, taskId, ASKER, { status: 'done' })
  const intRunId = await seedRun(db, taskId, CC, { status: 'done' })
  const roundId = ulid()
  const questionsJson = JSON.stringify(questions)
  const answersJson = JSON.stringify(questions.map((q) => ans(q.id)))
  await db.insert(clarifyRounds).values({
    id: roundId,
    taskId,
    kind: 'cross',
    askingNodeId: ASKER,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: CC,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: DESIGNER,
    iteration: 0,
    questionsJson,
    answersJson,
    questionScopesJson: opts.scopesJson ?? null,
    directive: 'continue',
    status: 'answered',
    answeredAt: Date.now(),
  })
  await db.insert(crossClarifySessions).values({
    id: roundId,
    taskId,
    crossClarifyNodeId: CC,
    crossClarifyNodeRunId: intRunId,
    sourceQuestionerNodeId: ASKER,
    sourceQuestionerNodeRunId: askingRunId,
    targetDesignerNodeId: DESIGNER,
    questionsJson,
    answersJson,
    questionScopesJson: opts.scopesJson ?? null,
    status: 'answered',
    answeredAt: Date.now(),
  })
  return { roundId, origin: intRunId }
}

/** self 轮（DESIGNER 自问）——混批测试的 clarify-answer cause 来源。 */
async function seedSelfRound(
  db: DbClient,
  taskId: string,
  questions: ClarifyQuestion[],
): Promise<{ roundId: string; origin: string }> {
  const askingRunId = await seedRun(db, taskId, DESIGNER, { status: 'done' })
  const intRunId = await seedRun(db, taskId, CL, { status: 'done' })
  const roundId = ulid()
  await db.insert(clarifyRounds).values({
    id: roundId,
    taskId,
    kind: 'self',
    askingNodeId: DESIGNER,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: CL,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: null,
    iteration: 0,
    questionsJson: JSON.stringify(questions),
    answersJson: JSON.stringify(questions.map((q) => ans(q.id))),
    directive: 'continue',
    status: 'answered',
    answeredAt: Date.now(),
  })
  return { roundId, origin: intRunId }
}

interface EntrySeed {
  originNodeRunId: string
  questionId: string
  roleKind: 'self' | 'questioner' | 'designer'
  sourceKind?: 'self' | 'cross'
  defaultTargetNodeId: string | null
  overrideTargetNodeId?: string | null
  sealed?: boolean
  dispatchedAt?: number | null
  stagedAt?: number | null
}

async function insertEntry(db: DbClient, taskId: string, e: EntrySeed): Promise<string> {
  const id = ulid()
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: e.questionId,
    questionTitle: `${e.questionId}-title`,
    sourceKind: e.sourceKind ?? 'cross',
    roleKind: e.roleKind,
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    overrideTargetNodeId: e.overrideTargetNodeId ?? null,
    sealedAt: (e.sealed ?? true) ? Date.now() : null,
    sealedBy: (e.sealed ?? true) ? 'u1' : null,
    dispatchedAt: e.dispatchedAt ?? null,
    dispatchedBy: e.dispatchedAt ? 'u1' : null,
    stagedAt: e.stagedAt ?? null,
    stagedBy: e.stagedAt ? 'u1' : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

const allEntries = (db: DbClient, taskId: string) =>
  db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))

const entryById = async (db: DbClient, id: string) =>
  (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]

async function scopesOf(db: DbClient, roundId: string) {
  const round = (
    await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)).limit(1)
  )[0]!
  const session = (
    await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.id, roundId))
      .limit(1)
  )[0]!
  return { round: round.questionScopesJson, session: session.questionScopesJson }
}

beforeEach(() => resetBroadcastersForTests())

// ===========================================================================
// W1 — symmetric collapse (questioner → designer)
// ===========================================================================
describe('RFC-140 W1 collapse 正路径', () => {
  test('questioner 行改派到该轮设计节点 → 行删除、两表 scope=designer、echo 物化、返回 collapsed-to-designer', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const qEid = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      stagedAt: Date.now(),
    })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })

    const action = await reassignTaskQuestion(db, qEid, DESIGNER, actor)
    expect(action).toBe('collapsed-to-designer')

    const rows = await allEntries(db, taskId)
    expect(rows.find((r) => r.roleKind === 'questioner')).toBeUndefined()
    const designer = rows.find((r) => r.roleKind === 'designer')!
    expect(designer.defaultTargetNodeId).toBe(DESIGNER)
    expect(designer.overrideTargetNodeId).toBeNull()
    // echo receipt for the asking node — dispatched immediately, zero-mint.
    const echo = rows.find((r) => r.roleKind === 'echo')!
    expect(echo.defaultTargetNodeId).toBe(ASKER)
    expect(echo.dispatchedAt).not.toBeNull()
    expect(echo.sealedAt).not.toBeNull()
    // dual-write lockstep.
    const scopes = await scopesOf(db, roundId)
    expect(JSON.parse(scopes.round!)).toEqual({ q1: 'designer' })
    expect(JSON.parse(scopes.session!)).toEqual({ q1: 'designer' })
  })

  test('designer 行不存在（原 scope=questioner）→ insert-if-missing + seal 归一化 + staged 继承', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')], {
      scopesJson: JSON.stringify({ q1: 'questioner' }),
    })
    const stagedAt = Date.now() - 5000
    const qEid = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      stagedAt,
    })

    expect(await reassignTaskQuestion(db, qEid, DESIGNER, actor)).toBe('collapsed-to-designer')
    const designer = (await allEntries(db, taskId)).find((r) => r.roleKind === 'designer')!
    expect(designer.defaultTargetNodeId).toBe(DESIGNER)
    expect(designer.sealedAt).not.toBeNull()
    expect(designer.stagedAt).toBe(stagedAt) // 暂存意图随题转移
  })

  test('幸存行三分支：未下发旧 override 归一化 / 已下发同目标零改动 / 已下发第三节点 409', async () => {
    // (a) undispatched survivor with a stale third-node override → normalized + audit stamp.
    {
      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `t_${ulid()}`
      await seedTask(db, taskId)
      const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
      const qEid = await insertEntry(db, taskId, {
        originNodeRunId: origin,
        questionId: 'q1',
        roleKind: 'questioner',
        defaultTargetNodeId: ASKER,
      })
      const dEid = await insertEntry(db, taskId, {
        originNodeRunId: origin,
        questionId: 'q1',
        roleKind: 'designer',
        defaultTargetNodeId: DESIGNER,
        overrideTargetNodeId: OTHER,
      })
      expect(await reassignTaskQuestion(db, qEid, DESIGNER, actor)).toBe('collapsed-to-designer')
      const survivor = (await entryById(db, dEid))!
      expect(survivor.overrideTargetNodeId).toBeNull()
      expect(survivor.lastReassignedBy).toBe(actor.userId)
      expect(survivor.lastReassignedAt).not.toBeNull()
    }
    // (b) dispatched survivor already on the designer → collapse proceeds, survivor untouched.
    {
      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `t_${ulid()}`
      await seedTask(db, taskId)
      const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
      const qEid = await insertEntry(db, taskId, {
        originNodeRunId: origin,
        questionId: 'q1',
        roleKind: 'questioner',
        defaultTargetNodeId: ASKER,
      })
      const dispatchedAt = Date.now() - 1000
      const dEid = await insertEntry(db, taskId, {
        originNodeRunId: origin,
        questionId: 'q1',
        roleKind: 'designer',
        defaultTargetNodeId: DESIGNER,
        dispatchedAt,
      })
      expect(await reassignTaskQuestion(db, qEid, DESIGNER, actor)).toBe('collapsed-to-designer')
      const survivor = (await entryById(db, dEid))!
      expect(survivor.dispatchedAt).toBe(dispatchedAt)
      expect(survivor.lastReassignedBy).toBeNull() // untouched (D6 mirror)
      expect(
        (await allEntries(db, taskId)).find((r) => r.roleKind === 'questioner'),
      ).toBeUndefined()
    }
    // (c) dispatched survivor pointing at a THIRD node → 409, questioner row preserved.
    {
      const db = createInMemoryDb(MIGRATIONS)
      const taskId = `t_${ulid()}`
      await seedTask(db, taskId)
      const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
      const qEid = await insertEntry(db, taskId, {
        originNodeRunId: origin,
        questionId: 'q1',
        roleKind: 'questioner',
        defaultTargetNodeId: ASKER,
      })
      await insertEntry(db, taskId, {
        originNodeRunId: origin,
        questionId: 'q1',
        roleKind: 'designer',
        defaultTargetNodeId: DESIGNER,
        overrideTargetNodeId: OTHER,
        dispatchedAt: Date.now(),
      })
      let caught: unknown
      try {
        await reassignTaskQuestion(db, qEid, DESIGNER, actor)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(ConflictError)
      expect((caught as ConflictError).code).toBe('task-question-already-dispatched')
      expect((await entryById(db, qEid))?.roleKind).toBe('questioner') // preserved, no partial write
      const scopes = await scopesOf(db, roundId)
      expect(scopes.round).toBeNull() // scope untouched
    }
  })
})

describe('RFC-140 W1 collapse 边界', () => {
  test('golden-lock：改派到第三节点 → override、行保留、零 scope 翻转、零 echo', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const qEid = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
    })
    expect(await reassignTaskQuestion(db, qEid, OTHER, actor)).toBe('override')
    const row = (await entryById(db, qEid))!
    expect(row.overrideTargetNodeId).toBe(OTHER)
    expect((await allEntries(db, taskId)).find((r) => r.roleKind === 'echo')).toBeUndefined()
    expect((await scopesOf(db, roundId)).round).toBeNull()
  })

  test('未答轮塌缩不伪造 seal：幸存 designer 行与 echo 的 sealed_at 保持 NULL（Codex 实现门 P1）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    // an UNANSWERED round (awaiting_human, no answers yet) — the questioner row exists pre-answer.
    const { origin, roundId } = await seedCrossRound(db, taskId, [mkQ('q1')])
    await db
      .update(clarifyRounds)
      .set({ status: 'awaiting_human', answersJson: null, answeredAt: null })
      .where(eq(clarifyRounds.id, roundId))
    const qEid = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      sealed: false, // not answered yet
    })
    expect(await reassignTaskQuestion(db, qEid, DESIGNER, actor)).toBe('collapsed-to-designer')
    const rows = await allEntries(db, taskId)
    const designer = rows.find((r) => r.roleKind === 'designer')!
    const echo = rows.find((r) => r.roleKind === 'echo')!
    // No fabricated answer evidence: the real seal later stamps the whole question's rows
    // (sealRoundQuestions keys (origin, questionId) + IS NULL with no role filter).
    expect(designer.sealedAt).toBeNull()
    expect(echo.sealedAt).toBeNull()
  })

  test('questioner 行已 dispatched → 409（塌缩分支前 CAS）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const qEid = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      dispatchedAt: Date.now(),
    })
    let caught: unknown
    try {
      await reassignTaskQuestion(db, qEid, DESIGNER, actor)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-already-dispatched')
  })

  test('QMGP5 形态：q1 塌缩后 10→9 条一次全发（deferredEntryCount=0，两 home 各单一 cause）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const qs = ['q1', 'q2', 'q3', 'q4', 'q5'].map(mkQ)
    const { origin } = await seedCrossRound(db, taskId, qs)
    // prior runs so both frontier targets are inheritable.
    await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
    const now = Date.now()
    const entryIds: string[] = []
    const q1QuestionerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      stagedAt: now,
    })
    for (const q of ['q2', 'q3', 'q4', 'q5']) {
      entryIds.push(
        await insertEntry(db, taskId, {
          originNodeRunId: origin,
          questionId: q,
          roleKind: 'questioner',
          defaultTargetNodeId: ASKER,
          stagedAt: now,
        }),
      )
    }
    for (const q of ['q1', 'q2', 'q3', 'q4', 'q5']) {
      entryIds.push(
        await insertEntry(db, taskId, {
          originNodeRunId: origin,
          questionId: q,
          roleKind: 'designer',
          defaultTargetNodeId: DESIGNER,
          stagedAt: now,
        }),
      )
    }
    // the QMGP5 move: q1's questioner entry reassigned to the designer → collapse.
    expect(await reassignTaskQuestion(db, q1QuestionerId, DESIGNER, actor)).toBe(
      'collapsed-to-designer',
    )
    // one click dispatches EVERYTHING (9 rows): per home a single cause → no auto-split defer.
    const res = await dispatchTaskQuestions(db, taskId, entryIds, actor)
    expect(res.deferred).toHaveLength(0)
    expect(res.dispatchedEntryIds).toHaveLength(9)
    const undispatched = (await allEntries(db, taskId)).filter(
      (r) => r.dispatchedAt === null && r.roleKind !== 'echo',
    )
    expect(undispatched).toHaveLength(0)
  })
})

// ===========================================================================
// W2 — deferred marker + auto-serial redispatch
// ===========================================================================

/** 混批夹具：DESIGNER home 上 self（clarify-answer）+ designer（cross-clarify-answer）两类
 *  cause；self staged 更早 → aging 选 self 先发，designer 批被 defer。返回 defer 批 id。 */
async function seedMixedBatch(
  db: DbClient,
  taskId: string,
): Promise<{ selfIds: string[]; designerIds: string[] }> {
  await seedTask(db, taskId)
  await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
  const self = await seedSelfRound(db, taskId, [mkQ('sq1')])
  const cross = await seedCrossRound(db, taskId, [mkQ('dq1'), mkQ('dq2')])
  const selfIds = [
    await insertEntry(db, taskId, {
      originNodeRunId: self.origin,
      questionId: 'sq1',
      roleKind: 'self',
      sourceKind: 'self',
      defaultTargetNodeId: DESIGNER,
      stagedAt: Date.now() - 10_000, // older → self cause wins the auto-split
    }),
  ]
  const designerIds = []
  for (const q of ['dq1', 'dq2']) {
    designerIds.push(
      await insertEntry(db, taskId, {
        originNodeRunId: cross.origin,
        questionId: q,
        roleKind: 'designer',
        defaultTargetNodeId: DESIGNER,
        stagedAt: Date.now(),
      }),
    )
  }
  return { selfIds, designerIds }
}

describe('RFC-140 W2 deferred 登记 + 自动补发', () => {
  test('混批 defer 盖列 → 承接 rerun done 后 autoDispatch 补发（__system__），嵌套收敛', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    const { selfIds, designerIds } = await seedMixedBatch(db, taskId)

    const res = await dispatchTaskQuestions(db, taskId, [...selfIds, ...designerIds], actor)
    expect(res.dispatchedEntryIds).toEqual(selfIds) // self cause won (older staged)
    expect(res.deferred.map((d) => d.entryId).sort()).toEqual([...designerIds].sort())
    for (const id of designerIds) {
      const row = (await entryById(db, id))!
      expect(row.autoDispatchDeferredAt).not.toBeNull() // marker persisted
      expect(row.dispatchedAt).toBeNull()
    }
    // the minted self continuation is still pending → in-flight gate blocks the redispatch.
    await autoDispatchDeferredQuestions(db, taskId)
    expect((await entryById(db, designerIds[0]!))!.dispatchedAt).toBeNull()
    expect((await entryById(db, designerIds[0]!))!.autoDispatchDeferredAt).not.toBeNull() // retryable → kept
    // the continuation runs (its injection binds the self entries — bindTriggerRun, as the real
    // scheduler does) and finishes: done releases the in-flight gate (RFC-133/139).
    const pending = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.status === 'pending',
    )!
    await db
      .update(taskQuestions)
      .set({ triggerRunId: pending.id })
      .where(inArray(taskQuestions.id, selfIds))
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, pending.id))
    await autoDispatchDeferredQuestions(db, taskId)
    for (const id of designerIds) {
      const row = (await entryById(db, id))!
      expect(row.dispatchedAt).not.toBeNull()
      expect(row.dispatchedBy).toBe('__system__')
    }
    // a cross-clarify-answer rerun was minted on the designer home.
    const minted = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === 'cross-clarify-answer',
    )
    expect(minted).toHaveLength(1)
  })

  test('越权防护：staged 未点发（无登记）不被自动下发', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
    const cross = await seedCrossRound(db, taskId, [mkQ('dq1')])
    const id = await insertEntry(db, taskId, {
      originNodeRunId: cross.origin,
      questionId: 'dq1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      stagedAt: Date.now(), // staged but the user never clicked batch dispatch
    })
    await autoDispatchDeferredQuestions(db, taskId)
    expect((await entryById(db, id))!.dispatchedAt).toBeNull()
  })

  test('撤回防护：unstage 清登记（级联）→ 不再自动发；re-stage 不复活登记', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    const { designerIds } = await seedMixedBatch(db, taskId)
    const selfIds = (await allEntries(db, taskId))
      .filter((r) => r.roleKind === 'self')
      .map((r) => r.id)
    await dispatchTaskQuestions(db, taskId, [...selfIds, ...designerIds], actor)
    expect((await entryById(db, designerIds[0]!))!.autoDispatchDeferredAt).not.toBeNull()
    // withdraw: unstage one deferred card → per-question cascade clears the marker.
    await stageTaskQuestion(db, designerIds[0]!, false, actor)
    const withdrawn = (await entryById(db, designerIds[0]!))!
    expect(withdrawn.stagedAt).toBeNull()
    expect(withdrawn.autoDispatchDeferredAt).toBeNull()
    // re-stage: back to the staging area — the marker must NOT resurrect.
    await stageTaskQuestion(db, designerIds[0]!, true, actor)
    expect((await entryById(db, designerIds[0]!))!.autoDispatchDeferredAt).toBeNull()
    // the continuation binds its self entries (as the real scheduler injection does) and
    // finishes; then redispatch: only the still-marked sibling fires.
    const pending = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.status === 'pending',
    )!
    await db
      .update(taskQuestions)
      .set({ triggerRunId: pending.id })
      .where(inArray(taskQuestions.id, selfIds))
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, pending.id))
    await autoDispatchDeferredQuestions(db, taskId)
    expect((await entryById(db, designerIds[0]!))!.dispatchedAt).toBeNull() // withdrawn → untouched
    expect((await entryById(db, designerIds[1]!))!.dispatchedAt).not.toBeNull() // sibling fired
  })

  test('不可恢复 Conflict（task-terminal）→ 清登记 + 不再重试（回手动轨道）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    const { selfIds, designerIds } = await seedMixedBatch(db, taskId)
    await dispatchTaskQuestions(db, taskId, [...selfIds, ...designerIds], actor)
    expect((await entryById(db, designerIds[0]!))!.autoDispatchDeferredAt).not.toBeNull()
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId))
    await autoDispatchDeferredQuestions(db, taskId) // task-terminal — NOT in the retryable set
    for (const id of designerIds) {
      const row = (await entryById(db, id))!
      expect(row.autoDispatchDeferredAt).toBeNull() // cleared
      expect(row.dispatchedAt).toBeNull() // and of course not dispatched
      expect(row.stagedAt).not.toBeNull() // stays staged — manual board track
    }
  })

  test('源级锁：补发经 dispatchDeferredTaskQuestions（选择在锁 B 内）且一次全量（禁逐 home 拆分）', async () => {
    // Codex impl-gate P1: the tick entry must NOT pre-select ids outside the lock — selection +
    // dispatch share ONE lock-B holding (dispatchDeferredTaskQuestions), else a concurrent
    // unstage between the select and the dispatch would still dispatch the withdrawn entry.
    const auto = await Bun.file(
      fileURLToPath(new URL('../src/services/clarifyAutoDispatch.ts', import.meta.url)),
    ).text()
    const fnBody = auto.slice(auto.indexOf('export async function autoDispatchDeferredQuestions'))
    expect(fnBody.split('dispatchDeferredTaskQuestions(').length - 1).toBe(1)
    expect(fnBody).not.toContain('.select(') // no pre-lock selection in the tick entry
    // ONE full-set dispatch — per-home splitting breaks the upstream frontier (design-gate R3 P1).
    const dispatch = await Bun.file(
      fileURLToPath(new URL('../src/services/taskQuestionDispatch.ts', import.meta.url)),
    ).text()
    const deferredFn = dispatch.slice(
      dispatch.indexOf('export async function dispatchDeferredTaskQuestions'),
      dispatch.indexOf('async function dispatchTaskQuestionsLocked'),
    )
    expect(deferredFn).toContain('getTaskQuestionWriteSem(taskId).run')
    expect(deferredFn.split('dispatchTaskQuestionsLocked(').length - 1).toBe(1)
  })

  test('stage/unstage 与 dispatch 串行（锁 B）：dispatch 锁获取点在读条目之前（源级文本锁）', async () => {
    const src = await Bun.file(
      fileURLToPath(new URL('../src/services/taskQuestionDispatch.ts', import.meta.url)),
    ).text()
    // The public wrapper acquires lock B and delegates to the locked pipeline — the read/plan
    // phase must NOT run before the lock (Codex design-gate rounds 3-4: a stage/unstage inter-
    // leaving the pre-lock plan could resurrect a withdrawn dispatch intent via the marker stamp).
    const wrapper = src.slice(
      src.indexOf('export async function dispatchTaskQuestions'),
      src.indexOf('async function dispatchTaskQuestionsLocked'),
    )
    expect(wrapper).toContain('getTaskQuestionWriteSem(taskId).run')
    expect(wrapper).not.toContain('.select()') // no reads before the lock
    const stageSrc = await Bun.file(
      fileURLToPath(new URL('../src/services/taskQuestions.ts', import.meta.url)),
    ).text()
    const stageFn = stageSrc.slice(
      stageSrc.indexOf('export async function stageTaskQuestion'),
      stageSrc.indexOf('const MANUAL_TITLE_MAX'),
    )
    expect(stageFn).toContain('getTaskQuestionWriteSem(entry.taskId).run')
  })
})
