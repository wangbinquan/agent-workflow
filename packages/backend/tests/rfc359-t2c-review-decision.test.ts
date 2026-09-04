// RFC-359 W1-T2c（F-H2-1 之三）—— 评审决定命令在两个引擎上各跑一遍。
//
// dual-provider-parity-audit-2026-09-04 F-H2-1：PostgreSQL daemon 从未注入 `reviewDecisions`，
// 路由一到就 500；而 SQLite 那份（`legacySqliteReview.ts` 的五个 dbTxSync 事务体）在 PG 上跑不
// 起来。现在决定 / 评论 / 选择跑在 `DatabaseSession` 上，node_run 状态 CAS、任务成员判定、
// 正文读取、互斥作用域各只剩一份实现。场景对照 SQLite 黄金锁 `review-decision-full-asserts.test.ts`。

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import {
  collaborationGateOperations,
  committedEvents,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
} from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  addReviewComment,
  deleteReviewComment,
  setDocumentSelection,
  updateReviewCommentText,
} from '@/modules/collaboration/infrastructure/legacySqliteReview'
import { createReviewDecisionCommand } from '@/modules/collaboration/infrastructure/reviewDecisionCommand'
import type { ReviewDecisionCommandPort } from '@/modules/collaboration/public/types'
import { ConflictError } from '@/util/errors'
import { resetBroadcastersForTests } from '@/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'
import {
  DOC,
  REVIEW_OWNER,
  seedReviewRound,
  type ReviewRound,
} from './helpers/reviewDecisionFixture'

const actor = { user: { id: REVIEW_OWNER } } as Parameters<
  ReviewDecisionCommandPort['submit']
>[0]['actor']

const runById = async (db: ProviderNeutralDatabase, id: string) =>
  (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
const docById = async (db: ProviderNeutralDatabase, id: string) =>
  (await db.select().from(docVersions).where(eq(docVersions.id, id)))[0]!
const outputsOf = (db: ProviderNeutralDatabase, runId: string) =>
  db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, runId))
const commentsOf = (db: ProviderNeutralDatabase, docVersionId: string) =>
  db.select().from(reviewComments).where(eq(reviewComments.docVersionId, docVersionId))
const decisionOps = (db: ProviderNeutralDatabase, taskId: string) =>
  db
    .select()
    .from(collaborationGateOperations)
    .where(
      and(
        eq(collaborationGateOperations.taskId, taskId),
        eq(collaborationGateOperations.gateKind, 'review'),
        eq(collaborationGateOperations.operationKind, 'decide'),
      ),
    )
const reviewEvents = (db: ProviderNeutralDatabase, reviewRunId: string, type: string) =>
  db
    .select()
    .from(committedEvents)
    .where(
      and(
        eq(committedEvents.producer, 'collaboration'),
        eq(committedEvents.eventType, type),
        eq(committedEvents.aggregateId, reviewRunId),
      ),
    )
const taskRuns = (db: ProviderNeutralDatabase, taskId: string) =>
  db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))

describeEachProvider('RFC-359 T2c —— 评审决定命令（reviewDecisions）', (harness) => {
  let round: ReviewRound | undefined
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => {
    round?.cleanup()
    round = undefined
  })

  test('approve：评审 run done、doc_version approved、approved_doc + approval_meta 落 outputs、回执 + 决定事件', async () => {
    const db = harness.db
    round = await seedReviewRound(db)
    const command = createReviewDecisionCommand({ db, appHome: round.appHome })
    const result = await command.submit({
      actor,
      authorRole: 'owner',
      nodeRunId: round.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      idempotencyKey: 'k-approve',
    })
    expect(result.taskId).toBe(round.taskId)
    expect(result.reviewIteration).toBe(0)
    expect(result.receipt.replayed).toBe(false)
    expect(result.receipt.gate).toEqual({ kind: 'review', ref: `review:${round.reviewRunId}` })
    expect(result.commentsAdded).toBe(0)

    const run = await runById(db, round.reviewRunId)
    expect(run.status).toBe('done')
    expect(run.finishedAt).not.toBeNull()
    const doc = await docById(db, round.docVersionIds[0]!)
    expect(doc.decision).toBe('approved')
    expect(doc.decidedBy).toBe(REVIEW_OWNER)
    expect(doc.decidedByRole).toBe('owner')
    expect(doc.decisionReason).toBeNull()
    const outs = await outputsOf(db, round.reviewRunId)
    const byPort = new Map(outs.map((o) => [o.portName, o]))
    expect(byPort.get('approved_doc')?.content).toBe('# body inline')
    expect(byPort.get('approved_doc')?.kind ?? null).toBeNull()
    const meta = JSON.parse(byPort.get('approval_meta')!.content) as Record<string, unknown>
    expect(meta.decision).toBe('approved')
    expect(meta.sourceNodeId).toBe(DOC)
    expect(meta.decidedBy).toBeUndefined()
    const ops = await decisionOps(db, round.taskId)
    expect(ops).toHaveLength(1)
    expect(ops[0]!.state).toBe('completed')
    expect(ops[0]!.idempotencyKey).toBe('k-approve')
    const events = await reviewEvents(
      db,
      round.reviewRunId,
      'collaboration.human-gate-decision-committed.v1',
    )
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.payloadJson).payload.gateStatus).toBe('committed')
  })

  test('reject + 批量评论：上游 run 作废并铸 review-reject 重跑，评审 run 回 pending 且 iteration+1，评论归档进 doc_version', async () => {
    const db = harness.db
    round = await seedReviewRound(db)
    const command = createReviewDecisionCommand({ db, appHome: round.appHome })
    const result = await command.submit({
      actor,
      authorRole: 'owner',
      nodeRunId: round.reviewRunId,
      decision: 'rejected',
      rejectReason: 'needs a rewrite',
      expectedReviewIteration: 0,
      comments: [{ commentText: 'tighten this', anchorRequest: { quote: 'body' } }],
    })
    expect(result.reviewIteration).toBe(1)
    expect(result.commentsAdded).toBe(1)
    expect(result.commentsSkippedAsDuplicate).toBe(0)

    const review = await runById(db, round.reviewRunId)
    expect(review.status).toBe('pending')
    expect(review.reviewIteration).toBe(1)
    const upstream = await runById(db, round.agentRunId)
    expect(upstream.status).toBe('canceled')
    expect(upstream.supersededByReview).toBe('rejected')
    expect(upstream.rolledBack).toBe(false)
    const minted = (await taskRuns(db, round.taskId)).filter(
      (r) => r.rerunCause === 'review-reject',
    )
    expect(minted).toHaveLength(1)
    expect(minted[0]!.nodeId).toBe(DOC)
    expect(minted[0]!.status).toBe('pending')
    expect(minted[0]!.retryIndex).toBe(1)
    const doc = await docById(db, round.docVersionIds[0]!)
    expect(doc.decision).toBe('rejected')
    expect(doc.decisionReason).toBe('needs a rewrite')
    const archived = JSON.parse(doc.commentsJson) as Array<{ commentText: string }>
    expect(archived.map((c) => c.commentText)).toEqual(['tighten this'])
    expect(await commentsOf(db, round.docVersionIds[0]!)).toHaveLength(0)
    expect((await decisionOps(db, round.taskId))[0]!.state).toBe('completed')
  })

  test('重放：同 idempotencyKey 再提交 → replayed 回执、不再铸第二个重跑', async () => {
    const db = harness.db
    round = await seedReviewRound(db)
    const command = createReviewDecisionCommand({ db, appHome: round.appHome })
    const submit = () =>
      command.submit({
        actor,
        authorRole: 'owner',
        nodeRunId: round!.reviewRunId,
        decision: 'iterated',
        expectedReviewIteration: 0,
        idempotencyKey: 'k-iterate',
      })
    const first = await submit()
    const replay = await submit()
    expect(replay.receipt.replayed).toBe(true)
    expect(replay.receipt.operationId).toBe(first.receipt.operationId)
    expect(replay.reviewIteration).toBe(first.reviewIteration)
    expect(await decisionOps(db, round.taskId)).toHaveLength(1)
    const minted = (await taskRuns(db, round.taskId)).filter(
      (r) => r.rerunCause === 'review-iterate',
    )
    expect(minted).toHaveLength(1)
  })

  test('过期 gate revision → human-gate-operation-stale，整个决定事务回滚', async () => {
    const db = harness.db
    round = await seedReviewRound(db)
    const command = createReviewDecisionCommand({ db, appHome: round.appHome })
    let error: unknown
    try {
      await command.submit({
        actor,
        authorRole: 'owner',
        nodeRunId: round.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        expectedGateRevision: 9,
      })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).code).toBe('human-gate-operation-stale')
    expect((await runById(db, round.reviewRunId)).status).toBe('awaiting_review')
    expect((await docById(db, round.docVersionIds[0]!)).decision).toBe('pending')
    expect(await outputsOf(db, round.reviewRunId)).toHaveLength(0)
    expect(await decisionOps(db, round.taskId)).toHaveLength(0)
  })

  test('评论增 / 改 / 删各自一个事务，事件各记一条', async () => {
    const db = harness.db
    round = await seedReviewRound(db)
    const authz = { actorUserId: REVIEW_OWNER, role: 'owner' as const }
    const added = await addReviewComment({
      db,
      appHome: round.appHome,
      nodeRunId: round.reviewRunId,
      anchorRequest: { quote: 'inline' },
      commentText: 'first',
      author: REVIEW_OWNER,
      authorRole: 'owner',
    })
    expect(added.anchor.selectedText).toBe('inline')
    expect((await commentsOf(db, round.docVersionIds[0]!)).map((c) => c.commentText)).toEqual([
      'first',
    ])
    const updated = await updateReviewCommentText(db, round.reviewRunId, added.id, 'second', authz)
    expect(updated.commentText).toBe('second')
    expect((await commentsOf(db, round.docVersionIds[0]!))[0]!.commentText).toBe('second')
    await deleteReviewComment(db, round.reviewRunId, added.id, authz)
    expect(await commentsOf(db, round.docVersionIds[0]!)).toHaveLength(0)
    expect(
      await reviewEvents(db, round.reviewRunId, 'collaboration.review-comments-changed.v1'),
    ).toHaveLength(3)
  })

  test('多文档：逐项选择 + 决定里的批量选择 → accepted 子集与 approval_meta 两引擎一致', async () => {
    const db = harness.db
    round = await seedReviewRound(db, { bodies: ['# doc zero', '# doc one', '# doc two'] })
    const [dv0, dv1, dv2] = round.docVersionIds as [string, string, string]
    await setDocumentSelection({
      db,
      nodeRunId: round.reviewRunId,
      docVersionId: dv0,
      selection: 'accepted',
    })
    expect((await docById(db, dv0)).selection).toBe('accepted')
    expect(
      await reviewEvents(db, round.reviewRunId, 'collaboration.review-selection-changed.v1'),
    ).toHaveLength(1)
    const result = await createReviewDecisionCommand({ db, appHome: round.appHome }).submit({
      actor,
      authorRole: 'owner',
      nodeRunId: round.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      selections: [
        { docVersionId: dv1, selection: 'not_accepted' },
        { docVersionId: dv2, selection: 'accepted' },
      ],
    })
    expect(result.selectionsApplied).toBe(2)
    const outs = await outputsOf(db, round.reviewRunId)
    const accepted = outs.find((o) => o.portName === 'accepted')!
    expect(accepted.kind).toBe('list<markdown>')
    expect(accepted.content).toContain('# doc zero')
    expect(accepted.content).toContain('# doc two')
    expect(accepted.content).not.toContain('# doc one')
    const meta = JSON.parse(outs.find((o) => o.portName === 'approval_meta')!.content) as {
      acceptedItemIndices: number[]
      itemCount: number
    }
    expect(meta.itemCount).toBe(3)
    expect(meta.acceptedItemIndices).toEqual([0, 2])
    for (const id of round.docVersionIds) expect((await docById(db, id)).decision).toBe('approved')
    expect((await runById(db, round.reviewRunId)).status).toBe('done')
  })
})
