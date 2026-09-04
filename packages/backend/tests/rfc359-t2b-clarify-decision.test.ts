// RFC-359 W1-T2b（F-H2-1 之二）—— 快速澄清决定命令在两个引擎上各跑一遍。
//
// dual-provider-parity-audit-2026-09-04 F-H2-1：PostgreSQL daemon 从未注入 `clarifyDecisions`，
// 路由一到就 500；而 SQLite 那份（seal 的 dbTxSync + `SqliteHumanGateOperationStore`）在 PG 上
// 根本跑不起来。现在 seal → clarify decision participant → autoDispatch 整条链跑在
// `DatabaseSession` 上，`createClarifyDecisionCommand` 对两个 provider 是同一段代码。
// 场景对照 SQLite 黄金锁 `rfc128-p5-d-autodispatch.test.ts` / `rfc128-p1-per-question-seal.test.ts`。

import { beforeEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import {
  clarifyRounds,
  collaborationGateOperations,
  committedEvents,
  nodeRuns,
  taskQuestions,
  tasks,
} from '@/db/schema'
import { createClarifyDecisionCommand } from '@/modules/collaboration/infrastructure/clarifyDecisionCommand'
import { sealRoundQuestions } from '@/modules/collaboration/infrastructure/legacySqliteClarify/seal'
import { listNodeClarifyDirectives } from '@/modules/collaboration/infrastructure/legacySqliteTaskClarifyDirective'
import type { ClarifyDecisionCommandPort } from '@/modules/collaboration/public/types'
import type { EnqueueMemoryDistillJobInput } from '@/modules/memory/public/commands'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { ConflictError } from '@/util/errors'
import { resetBroadcastersForTests } from '@/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'
import {
  DESIGNER,
  freshTaskId,
  mkQ,
  seedRound,
  seedRun,
  seedTask,
} from './helpers/questionDispatchFixture'
import type { ProviderNeutralDatabase } from '@/db/query'

const actor = { user: { id: 'u1' } } as Parameters<ClarifyDecisionCommandPort['submit']>[0]['actor']

function ans(questionId: string) {
  return { questionId, selectedOptionIndices: [0], selectedOptionLabels: ['A'], customText: '' }
}

function recordingEnqueuer(): MemoryDistillEnqueuer & { calls: EnqueueMemoryDistillJobInput[] } {
  const calls: EnqueueMemoryDistillJobInput[] = []
  return {
    calls,
    async enqueue(input) {
      calls.push(input)
      return { jobId: `job_${calls.length}`, debounceKey: input.sourceEventId, nextRunAt: 0 }
    },
  }
}

async function seedOpenSelfRound(db: ProviderNeutralDatabase, taskId: string) {
  await seedTask(db, taskId)
  await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
  return await seedRound(db, taskId, 'self', [mkQ('q1'), mkQ('q2')], { status: 'awaiting_human' })
}

const roundById = async (db: ProviderNeutralDatabase, id: string) =>
  (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, id)))[0]!
const runById = async (db: ProviderNeutralDatabase, id: string) =>
  (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
const entriesOf = (db: ProviderNeutralDatabase, origin: string) =>
  db.select().from(taskQuestions).where(eq(taskQuestions.originNodeRunId, origin))
const mintedReruns = async (db: ProviderNeutralDatabase, taskId: string) =>
  (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
    (r) => r.rerunCause === 'clarify-answer',
  )
const decisionOps = (db: ProviderNeutralDatabase, taskId: string) =>
  db
    .select()
    .from(collaborationGateOperations)
    .where(
      and(
        eq(collaborationGateOperations.taskId, taskId),
        eq(collaborationGateOperations.gateKind, 'clarify'),
        eq(collaborationGateOperations.operationKind, 'decide'),
      ),
    )
const decisionEvents = (db: ProviderNeutralDatabase, roundId: string) =>
  db
    .select()
    .from(committedEvents)
    .where(
      and(
        eq(committedEvents.producer, 'collaboration'),
        eq(committedEvents.eventType, 'collaboration.human-gate-decision-committed.v1'),
        eq(committedEvents.aggregateId, roundId),
      ),
    )

describeEachProvider('RFC-359 T2b —— 快速澄清决定命令（clarifyDecisions）', (harness) => {
  beforeEach(() => resetBroadcastersForTests())

  test('整轮 finalize：round answered、澄清 node_run done、self 条目 sealed+dispatched、铸 clarify-answer rerun、回执 + 事件 + 蒸馏入队', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    const round = await seedOpenSelfRound(db, taskId)
    const enqueuer = recordingEnqueuer()
    const result = await createClarifyDecisionCommand(db, enqueuer).submit({
      actor,
      actorRole: 'owner',
      nodeRunId: round.origin,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
      ifMatchIteration: 0,
      idempotencyKey: 'k1',
    })
    expect(result.taskId).toBe(taskId)
    expect(result.roundKind).toBe('self')
    expect([...result.sealedQuestionIds].sort()).toEqual(['q1', 'q2'])
    expect(result.roundFullySealed).toBe(true)
    expect(result.receipt.replayed).toBe(false)
    expect(result.receipt.gate).toEqual({ kind: 'clarify', ref: `clarify:${round.origin}` })
    expect(result.reruns).toHaveLength(1)
    expect(result.reruns[0]!.targetNodeId).toBe(DESIGNER)
    expect(result.dispatchedEntryIds).toHaveLength(2)
    expect(result.deferred).toEqual([])

    const roundRow = await roundById(db, round.roundId)
    expect(roundRow.status).toBe('answered')
    expect(roundRow.answeredBy).toBe('u1')
    expect(roundRow.directive).toBe('continue')
    expect(
      JSON.parse(roundRow.answersJson ?? '[]').map((a: { questionId: string }) => a.questionId),
    ).toEqual(['q1', 'q2'])
    expect((await runById(db, round.origin)).status).toBe('done')
    const entries = await entriesOf(db, round.origin)
    expect(entries).toHaveLength(2)
    for (const e of entries) {
      expect(e.roleKind).toBe('self')
      expect(e.sealedAt).not.toBeNull()
      expect(e.sealedBy).toBe('u1')
      expect(e.dispatchedAt).not.toBeNull()
    }
    const minted = await mintedReruns(db, taskId)
    expect(minted).toHaveLength(1)
    expect(minted[0]!.nodeId).toBe(DESIGNER)
    expect(minted[0]!.status).toBe('pending')
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.status).not.toBe(
      'awaiting_human',
    )
    // RFC-041：仅 self 轮 finalize 后入蒸馏队列，sourceEventId = round id。
    expect(enqueuer.calls).toEqual([
      { sourceKind: 'clarify', sourceEventId: round.roundId, taskId },
    ])
    const ops = await decisionOps(db, taskId)
    expect(ops).toHaveLength(1)
    expect(ops[0]!.state).toBe('completed')
    expect(ops[0]!.idempotencyKey).toBe('k1')
    expect(ops[0]!.receiptJson).not.toBeNull()
    expect(await decisionEvents(db, round.roundId)).toHaveLength(1)
  })

  test('重放：同 idempotencyKey 再提交 → replayed 回执、不双铸 rerun、不重复入队；换 key 再提 → clarify-already-answered', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    const round = await seedOpenSelfRound(db, taskId)
    const enqueuer = recordingEnqueuer()
    const command = createClarifyDecisionCommand(db, enqueuer)
    const submit = (idempotencyKey: string) =>
      command.submit({
        actor,
        actorRole: 'owner',
        nodeRunId: round.origin,
        answers: [ans('q1'), ans('q2')],
        directive: 'continue',
        idempotencyKey,
      })
    const first = await submit('k1')
    const replay = await submit('k1')
    expect(replay.receipt.replayed).toBe(true)
    expect(replay.receipt.operationId).toBe(first.receipt.operationId)
    expect(replay.roundFullySealed).toBe(true)
    // 重放从 durable 派发事件重建 rerun 集合——与首提相同，不再铸新的。
    expect(replay.reruns.map((r) => r.nodeRunId)).toEqual(first.reruns.map((r) => r.nodeRunId))
    expect(await mintedReruns(db, taskId)).toHaveLength(1)
    expect(await decisionOps(db, taskId)).toHaveLength(1)
    expect(enqueuer.calls).toHaveLength(1)

    await expect(submit('k2')).rejects.toMatchObject({ code: 'clarify-already-answered' })
  })

  test('过期 gate revision → human-gate-operation-stale，整个 seal 事务回滚（两引擎同样不留半截）', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    const round = await seedOpenSelfRound(db, taskId)
    const enqueuer = recordingEnqueuer()
    let error: unknown
    try {
      await createClarifyDecisionCommand(db, enqueuer).submit({
        actor,
        actorRole: 'owner',
        nodeRunId: round.origin,
        answers: [ans('q1'), ans('q2')],
        directive: 'continue',
        expectedGateRevision: 7,
      })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).code).toBe('human-gate-operation-stale')
    expect((await roundById(db, round.roundId)).status).toBe('awaiting_human')
    expect((await runById(db, round.origin)).status).toBe('awaiting_human')
    expect((await entriesOf(db, round.origin)).filter((e) => e.sealedAt !== null)).toHaveLength(0)
    expect(await mintedReruns(db, taskId)).toHaveLength(0)
    expect(await decisionOps(db, taskId)).toHaveLength(0)
    expect(enqueuer.calls).toHaveLength(0)
  })

  test("directive='stop'：节点 directive 与 round.directive 同一事务落 stop", async () => {
    const db = harness.db
    const taskId = freshTaskId()
    const round = await seedOpenSelfRound(db, taskId)
    const result = await createClarifyDecisionCommand(db, recordingEnqueuer()).submit({
      actor,
      actorRole: 'owner',
      nodeRunId: round.origin,
      answers: [ans('q1'), ans('q2')],
      directive: 'stop',
    })
    expect(result.roundFullySealed).toBe(true)
    expect((await roundById(db, round.roundId)).directive).toBe('stop')
    expect(await listNodeClarifyDirectives(db, taskId)).toEqual({ [DESIGNER]: 'stop' })
  })

  test('控制通道逐题 seal：部分 → 整轮，autoStage、重答守卫与 deferred 决定事件两引擎一致', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    const round = await seedOpenSelfRound(db, taskId)
    const partial = await sealRoundQuestions({
      db,
      originNodeRunId: round.origin,
      answers: [ans('q1')],
      sealedBy: 'u1',
      sealedByRole: 'owner',
      autoStage: true,
    })
    expect(partial).toEqual({
      sealedQuestionIds: ['q1'],
      resealedQuestionIds: [],
      roundFullySealed: false,
    })
    expect((await roundById(db, round.roundId)).status).toBe('awaiting_human')
    const afterPartial = await entriesOf(db, round.origin)
    expect(afterPartial.map((e) => e.questionId).sort()).toEqual(['q1', 'q2'])
    const q1 = afterPartial.find((e) => e.questionId === 'q1')!
    expect(q1.sealedAt).not.toBeNull()
    expect(q1.stagedAt).not.toBeNull()
    expect(afterPartial.find((e) => e.questionId === 'q2')!.sealedAt).toBeNull()

    // 已 seal 且已 staged 的题不声明重答就再 seal → 409（RFC-136 exactly-once）。
    await expect(
      sealRoundQuestions({ db, originNodeRunId: round.origin, answers: [ans('q1')] }),
    ).rejects.toMatchObject({ code: 'clarify-question-already-sealed' })

    const full = await sealRoundQuestions({
      db,
      originNodeRunId: round.origin,
      answers: [ans('q2')],
      sealedBy: 'u1',
      sealedByRole: 'owner',
    })
    expect(full.roundFullySealed).toBe(true)
    expect(full.sealedQuestionIds).toEqual(['q2'])
    expect((await roundById(db, round.roundId)).status).toBe('answered')
    expect((await runById(db, round.origin)).status).toBe('done')
    // 控制通道整轮 seal 没有决定参与者：记一条 gateStatus='deferred' 的决定事件，不铸 rerun。
    const events = await decisionEvents(db, round.roundId)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.payloadJson).payload.gateStatus).toBe('deferred')
    expect(await mintedReruns(db, taskId)).toHaveLength(0)
  })
})
