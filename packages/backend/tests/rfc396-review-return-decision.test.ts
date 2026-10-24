import { patchTaskFixture, readNodeRunOutputFixtures, readTaskFixtures } from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createReviewDecisionCommand } from '@/modules/collaboration/infrastructure/reviewDecisionCommand'
import { createCommittedHumanInputQueries } from '@/modules/collaboration/infrastructure/committedHumanInputQueries'
import { getReviewDetail } from '@/modules/collaboration/infrastructure/review'
import type { ReviewActor } from '@/modules/collaboration/public/types'
import { describeEachProvider } from './helpers/eachProvider'
import { withO2Closure } from './helpers/o2Closure'
import { seedReviewRound, REVIEW_OWNER, type ReviewRound } from './helpers/reviewDecisionFixture'

const actor: ReviewActor = {
  user: {
    id: REVIEW_OWNER,
    username: 'review-owner',
    displayName: 'Review owner',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
  permissions: new Set(),
}

describeEachProvider('RFC-396 independent review decisions', (harness) => {
  let round: ReviewRound | undefined
  afterEach(() => {
    round?.cleanup()
    round = undefined
  })
  for (const decision of ['approved', 'rejected', 'iterated'] as const) {
    test(`${decision} closes the gate, returns the actual decision and replays without upstream reruns`, async () => {
      const db = harness.db
      round = await seedReviewRound(db)
      const { nodeRuns, docVersions } = tablesOf(db)
      const task = (await readTaskFixtures(db, { id: round.taskId }))[0]!
      const definition = JSON.parse(task.workflowSnapshot)
      definition.nodes.find((node: { kind: string }) => node.kind === 'review').decisionHandling =
        'return-decision'
      await patchTaskFixture(
        db,
        { id: round.taskId },
        { workflowSnapshot: JSON.stringify(definition) },
      )
      const beforeRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, round.taskId))
      const command = createReviewDecisionCommand(withO2Closure({ db, appHome: round.appHome }))
      const request = {
        actor,
        authorRole: 'owner' as const,
        nodeRunId: round.reviewRunId,
        decision,
        expectedReviewIteration: 0,
        idempotencyKey: `return-${decision}`,
        rejectReason: 'Revise the conflict behavior',
        comments: [
          { commentText: 'Keep the original assumption visible', anchorRequest: { quote: 'body' } },
        ],
      }
      const result = await command.submit(request)
      const replay = await command.submit(request)
      expect(replay.receipt.operationId).toBe(result.receipt.operationId)
      expect(replay.receipt.replayed).toBe(true)
      expect(result.reviewIteration).toBe(0)
      const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, round.taskId))
      expect(runs).toHaveLength(beforeRuns.length)
      expect(runs.find((run) => run.id === round!.agentRunId)?.status).toBe('done')
      expect(runs.find((run) => run.id === round!.reviewRunId)?.status).toBe('done')
      const docs = await db
        .select()
        .from(docVersions)
        .where(eq(docVersions.reviewNodeRunId, round.reviewRunId))
      expect(docs[0]!.decision).toBe(decision)
      const outputs = await readNodeRunOutputFixtures(db, { nodeRunId: round.reviewRunId })
      expect(outputs.map((output) => output.portName)).toEqual(['decision_meta'])
      const meta = JSON.parse(outputs[0]!.content)
      expect(meta.decision).toBe(decision)
      expect(meta.receiptId).toBe(result.receipt.operationId)
      expect(
        await createCommittedHumanInputQueries({ db, appHome: round.appHome }).reviewDecision(
          round.taskId,
          round.reviewRunId,
        ),
      ).toMatchObject({
        receiptId: meta.receiptId,
        decision,
        documentDigests: meta.documents.map((d: { contentDigest: string }) => d.contentDigest),
      })
      expect(meta.documents[0].contentDigest).toMatch(/^[a-f0-9]{64}$/)
      if (decision === 'rejected') expect(meta.reason).toBe(request.rejectReason)
      if (decision === 'iterated')
        expect(meta.reason).toContain('Keep the original assumption visible')
      const detail = await getReviewDetail(db, round.appHome, round.reviewRunId)
      expect(detail.decisionHandling).toBe('return-decision')
    })
  }
  test('default review continues to rerun upstream on rejection', async () => {
    round = await seedReviewRound(harness.db)
    await createReviewDecisionCommand(
      withO2Closure({ db: harness.db, appHome: round.appHome }),
    ).submit({
      actor,
      authorRole: 'owner',
      nodeRunId: round.reviewRunId,
      decision: 'rejected',
      expectedReviewIteration: 0,
      rejectReason: 'Revise',
    })
    const { nodeRuns } = tablesOf(harness.db)
    const runs = await harness.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, round.taskId))
    expect(runs.find((run) => run.id === round!.reviewRunId)?.status).toBe('pending')
    expect(runs.some((run) => run.rerunCause === 'review-reject')).toBe(true)
  })
})
