// RFC-616 §5.2 / §14 "人工门事实" — the review and clarify gate facts collaboration
// offers to process metrics (`modules/collaboration/infrastructure/processGateFacts.ts`),
// on both providers.
//
// Why this file exists: process metrics never read collaboration's tables; every
// review and clarify statistic comes from these two reads. The rules themselves
// are locked in rfc616-process-gate-rounds.test.ts — this suite locks what only
// the stored rows can tell:
//   - a round counts the same comments before its decision (live rows) and
//     after it (the archive the decision writes while deleting those rows);
//   - the exact stamps the writers leave: a version superseded by an upstream
//     refresh and a version voided by a sibling review's rejection are void,
//     keep their interval and do not shift the numbering of valid rounds;
//   - answers sealed by the real seal path are counted once each by how they
//     were given, and each person by the answers attributed to them;
//   - a canceled clarify round closes when its mediator node run finished;
//   - the interval listing never reads stored JSON, and a batch costs one
//     statement per ledger however many rounds it holds.
// The decisions, comments, drafts and seals below go through the production
// writers; only shapes with no cheap writer (multi-version histories, canceled
// and legacy rounds) are seeded as rows.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import {
  LOCAL_DECIDER,
  SYSTEM_DECIDER,
  WORKGROUP_TURN_CLARIFY_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  buildMsgShardKey,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import type { ReviewDecisionCommandPort } from '@/modules/collaboration/application/ports/reviewDecisionCommand'
import { createProcessGateFacts } from '@/modules/collaboration/composition/processFacts'
import { sealRoundQuestions } from '@/modules/collaboration/infrastructure/clarify/seal'
import { createClarifyAnswerWritePort } from '@/modules/collaboration/infrastructure/clarifyAnswerWrite'
import {
  addReviewComment,
  dispatchReviewNode,
  setDocumentSelection,
} from '@/modules/collaboration/infrastructure/review'
import { createReviewDecisionCommand } from '@/modules/collaboration/infrastructure/reviewDecisionCommand'
import { legacyContentRef } from '@/platform/content/contentRef'
import {
  contentRowColumns,
  inlineContentColumns,
} from '@/platform/content/infrastructure/contentStore'
import {
  PROCESS_FACT_ID_BATCH,
  type ProcessTaskGateRoundRow,
  type ProcessTextItem,
} from '@/platform/contracts/processFacts'
import { createHumanGatePersistenceParticipantInTx } from '@/modules/task-execution/infrastructure/humanGatePersistenceParticipant'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { resetBroadcastersForTests } from '@/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'
import {
  agentFixture,
  clarifyRoundFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  patchTaskFixture,
  readClarifyRoundFixtures,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { withO2Closure } from './helpers/o2Closure'
import {
  CL,
  DESIGNER,
  freshTaskId,
  seedRound,
  seedRun,
  seedTask,
} from './helpers/questionDispatchFixture'
import {
  DOC,
  REVIEW,
  REVIEW_OWNER,
  reviewDefinition,
  seedReviewRound,
  type ReviewRound,
} from './helpers/reviewDecisionFixture'
import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'

const ulid = monotonicFactory()
const T = Date.UTC(2026, 10, 1)
const MIN = 60_000

const ownerActor = { user: { id: REVIEW_OWNER } } as Parameters<
  ReviewDecisionCommandPort['submit']
>[0]['actor']

type ReviewDecisionInput = Omit<
  Parameters<ReviewDecisionCommandPort['submit']>[0],
  'actor' | 'authorRole' | 'nodeRunId'
>

/** Decide a seeded review the way the route does: as the task owner, through the command. */
function decide(db: PersistenceDb, review: ReviewRound, input: ReviewDecisionInput) {
  return createReviewDecisionCommand(withO2Closure({ db, appHome: review.appHome })).submit({
    actor: ownerActor,
    authorRole: 'owner',
    nodeRunId: review.reviewRunId,
    ...input,
  })
}

function comment(
  db: PersistenceDb,
  review: ReviewRound,
  input: { quote: string; text: string; author: string; docVersionId?: string },
) {
  return addReviewComment({
    taskExecutionParticipants,
    db,
    appHome: review.appHome,
    nodeRunId: review.reviewRunId,
    anchorRequest: { quote: input.quote },
    commentText: input.text,
    author: input.author,
    authorRole: input.author === REVIEW_OWNER ? 'owner' : 'user',
    ...(input.docVersionId === undefined ? {} : { docVersionId: input.docVersionId }),
  })
}

async function storedVersion(db: PersistenceDb, id: string) {
  const { docVersions } = tablesOf(db)
  return (await db.select().from(docVersions).where(eq(docVersions.id, id)))[0]!
}

interface VersionSeed {
  readonly versionIndex: number
  readonly createdAt: number
  readonly decision?: 'pending' | 'approved' | 'rejected' | 'iterated' | 'superseded'
  readonly decisionReason?: string
  readonly decidedAt?: number
  readonly decidedBy?: string
  readonly commentsJson?: string
}

/** One more version of a review, as its writers leave it (the facts never read a body). */
async function addVersion(
  db: PersistenceDb,
  review: { taskId: string; reviewNodeId: string; reviewNodeRunId: string },
  seed: VersionSeed,
): Promise<string> {
  const { docVersions } = tablesOf(db)
  const id = ulid()
  await insertOne(db, docVersions, {
    id,
    taskId: review.taskId,
    reviewNodeId: review.reviewNodeId,
    reviewNodeRunId: review.reviewNodeRunId,
    sourceNodeId: DOC,
    sourcePortName: 'docpath',
    versionIndex: seed.versionIndex,
    reviewIteration: seed.versionIndex - 1,
    ...contentRowColumns(
      legacyContentRef('review-body-path', 'local-file', `doc_versions/${id}.md`),
    ),
    commentsJson: seed.commentsJson ?? '[]',
    decision: seed.decision ?? 'pending',
    decisionReason: seed.decisionReason ?? null,
    createdAt: seed.createdAt,
    decidedAt: seed.decidedAt ?? null,
    decidedBy: seed.decidedBy ?? null,
  })
  return id
}

/** A comment as a decision freezes it into `doc_versions.comments_json`. */
function frozenComment(author: string, commentText: string, createdAt: number) {
  return {
    id: ulid(),
    docVersionId: 'frozen',
    anchor: {
      sectionPath: '',
      paragraphIdx: 0,
      offsetStart: 0,
      offsetEnd: 4,
      selectedText: 'body',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 1,
    },
    commentText,
    author,
    authorRole: null,
    createdAt,
  }
}

const option = (label: string, recommended = false) => ({
  label,
  description: '',
  recommended,
  recommendationReason: '',
})

/** A question whose first option is the recommended one unless options are given. */
function question(
  id: string,
  overrides: Partial<Pick<ClarifyQuestion, 'options' | 'mindmap'>> = {},
): ClarifyQuestion {
  return {
    id,
    title: `${id}?`,
    kind: 'single',
    recommended: false,
    options: [option('A', true), option('B')],
    ...overrides,
  }
}

function answer(questionId: string, overrides: Partial<ClarifyAnswer> = {}): ClarifyAnswer {
  return {
    questionId,
    selectedOptionIndices: [],
    selectedOptionLabels: [],
    customText: '',
    ...overrides,
  }
}

const EMPTY_WORKFLOW = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

/** A task that only has to exist: the clarify rows below are seeded, not executed. */
async function seedPlainTask(db: PersistenceDb): Promise<string> {
  const id = `t_rfc616_${ulid()}`
  const workflowId = `wf_rfc616_${ulid()}`
  await workflowFixture(db, {
    id: workflowId,
    name: workflowId,
    description: '',
    definition: EMPTY_WORKFLOW,
    version: 1,
    schemaVersion: 2,
  })
  await taskFixture(db, {
    id,
    name: id,
    workflowId,
    workflowSnapshot: EMPTY_WORKFLOW,
    repoPath: '/tmp/aw-rfc616-never-read',
    worktreePath: `/tmp/aw-rfc616-never-read/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: T,
  })
  return id
}

async function seedNodeRun(
  db: PersistenceDb,
  taskId: string,
  nodeId: string,
  overrides: {
    status?: 'done' | 'canceled' | 'awaiting_human'
    shardKey?: string
    startedAt?: number
    finishedAt?: number
  } = {},
): Promise<string> {
  const id = `nr_rfc616_${ulid()}`
  await nodeRunFixture(db, { id, taskId, nodeId, status: 'done', ...overrides })
  return id
}

interface RoundSeed {
  readonly kind?: 'self' | 'cross'
  readonly askingNodeId: string
  readonly askingNodeRunId: string
  readonly askingShardKey?: string
  readonly intermediaryNodeId: string
  readonly intermediaryNodeRunId: string
  readonly questions?: readonly ClarifyQuestion[]
  /** A JSON text is stored verbatim, which is how a legacy payload is seeded. */
  readonly answers?: readonly ClarifyAnswer[] | string
  readonly attributions?: Readonly<Record<string, string>>
  readonly status: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned'
  readonly directive?: 'continue' | 'stop'
  readonly createdAt: number
  readonly answeredAt?: number
  readonly answeredBy?: string
  readonly abandonedAt?: number
}

async function seedClarifyRound(
  db: PersistenceDb,
  taskId: string,
  seed: RoundSeed,
): Promise<string> {
  const id = `cr_rfc616_${ulid()}`
  await clarifyRoundFixture(db, {
    id,
    taskId,
    kind: seed.kind ?? 'self',
    askingNodeId: seed.askingNodeId,
    askingNodeRunId: seed.askingNodeRunId,
    askingShardKey: seed.askingShardKey ?? null,
    intermediaryNodeId: seed.intermediaryNodeId,
    intermediaryNodeRunId: seed.intermediaryNodeRunId,
    questions: JSON.stringify(seed.questions ?? [question('q1')]),
    ...(seed.answers === undefined
      ? {}
      : {
          answers: typeof seed.answers === 'string' ? seed.answers : JSON.stringify(seed.answers),
        }),
    ...(seed.attributions === undefined
      ? {}
      : {
          answerAttributions: JSON.stringify(
            Object.fromEntries(
              Object.entries(seed.attributions).map(([questionId, userId]) => [
                questionId,
                { userId, role: 'user', updatedAt: seed.answeredAt ?? seed.createdAt },
              ]),
            ),
          ),
        }),
    status: seed.status,
    directive: seed.directive ?? null,
    createdAt: seed.createdAt,
    answeredAt: seed.answeredAt ?? null,
    answeredBy: seed.answeredBy ?? null,
    abandonedAt: seed.abandonedAt ?? null,
  })
  return id
}

const brief = (row: ProcessTaskGateRoundRow) => ({
  ordinal: row.ordinal,
  void: row.void,
  outcome: row.outcome,
  openedAt: row.openedAt,
  closedAt: row.closedAt,
})

describeEachProvider('RFC-616 process gate facts — review rounds', (harness) => {
  const cleanups: (() => void)[] = []
  const seedReview = async (db: PersistenceDb, bodies?: readonly string[]) => {
    const review = await seedReviewRound(db, bodies === undefined ? {} : { bodies })
    cleanups.push(review.cleanup)
    return review
  }
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  test('a round counts the same comments before its decision (live rows) and after it (the archive)', async () => {
    const db = harness.db
    const review = await seedReview(db)
    const facts = createProcessGateFacts(db, taskExecutionParticipants)
    await comment(db, review, { quote: 'body', text: 'tighten the scope', author: REVIEW_OWNER })
    await comment(db, review, { quote: 'inline', text: 'name an owner', author: 'u2' })
    await comment(db, review, { quote: 'body', text: 'and add an example', author: 'u2' })
    const versionId = review.docVersionIds[0]!
    const opened = await storedVersion(db, versionId)

    const pending = await facts.rounds([review.taskId], { measures: true })
    expect(pending).toEqual([
      {
        taskId: review.taskId,
        kind: 'review',
        stageNodeId: REVIEW,
        relatedNodeId: DOC,
        askingShardKey: null,
        gateNodeRunId: review.reviewRunId,
        instanceKey: review.reviewRunId,
        ordinal: 1,
        void: false,
        openedAt: Number(opened.createdAt),
        closedAt: null,
        outcome: null,
        deciderUserId: null,
        mindmap: false,
        measures: { comments: 3, commenters: 2 },
        people: [
          { userId: REVIEW_OWNER, comments: 1, answers: 0 },
          { userId: 'u2', comments: 2, answers: 0 },
        ],
      },
    ])
    const liveTexts = await facts.texts([review.taskId], ['review'])
    expect(liveTexts.map((item) => item.text).sort()).toEqual([
      'and add an example',
      'name an owner',
      'tighten the scope',
    ])
    for (const item of liveTexts) {
      expect(item).toMatchObject({
        source: 'review',
        taskId: review.taskId,
        caseId: null,
        stageRef: DOC,
      })
      expect(item.at).toBeGreaterThanOrEqual(Number(opened.createdAt))
    }

    await decide(db, review, { decision: 'approved', expectedReviewIteration: 0 })

    // The decision moved the comments from the live table into the version's archive.
    const { reviewComments } = tablesOf(db)
    expect(
      await db.select().from(reviewComments).where(eq(reviewComments.docVersionId, versionId)),
    ).toHaveLength(0)
    const decided = await storedVersion(db, versionId)
    const approved = await facts.rounds([review.taskId], { measures: true })
    expect(approved).toEqual([
      {
        ...pending[0]!,
        closedAt: Number(decided.decidedAt),
        outcome: 'approved',
        deciderUserId: REVIEW_OWNER,
      },
    ])
    expect(await facts.texts([review.taskId], ['review'])).toEqual(liveTexts)
    // The interval listing carries the same round without anything counted.
    expect(await facts.rounds([review.taskId], { measures: false })).toEqual([
      { ...approved[0]!, measures: {}, people: [] },
    ])
  })

  test('a review left pending when its task is canceled is over, and nobody decided it', async () => {
    // Regression: the terminal sweep closes the waiting review run and leaves the version
    // `pending`. Read from the version alone, the round stayed open until the task ended.
    const db = harness.db
    const review = await seedReview(db)
    const facts = createProcessGateFacts(db, taskExecutionParticipants)
    await comment(db, review, { quote: 'body', text: 'tighten the scope', author: 'u2' })
    const opened = await storedVersion(db, review.docVersionIds[0]!)
    expect((await facts.rounds([review.taskId], { measures: false }))[0]).toMatchObject({
      void: false,
      closedAt: null,
    })

    // The task is canceled: the sweep the lifecycle consumer runs.
    const canceledAt = Number(opened.createdAt) + 40 * MIN
    const swept = await databaseSessionFor(db).transaction((tx) =>
      createHumanGatePersistenceParticipantInTx(tx).cancelTaskGateRuns({
        taskId: review.taskId,
        now: canceledAt,
        cause: 'task-canceled',
      }),
    )
    expect(swept.map((row) => row.nodeRunId)).toEqual([review.reviewRunId])
    // The version itself was not touched.
    expect((await storedVersion(db, review.docVersionIds[0]!)).decision).toBe('pending')

    const [round] = await facts.rounds([review.taskId], { measures: true })
    expect(round).toMatchObject({
      kind: 'review',
      gateNodeRunId: review.reviewRunId,
      // Not a round anyone handled: it takes no number.
      ordinal: 0,
      void: true,
      openedAt: Number(opened.createdAt),
      closedAt: canceledAt,
      outcome: 'canceled',
      deciderUserId: null,
      measures: { comments: 1, commenters: 1 },
    })
    // The interval listing agrees.
    expect((await facts.rounds([review.taskId], { measures: false }))[0]).toMatchObject({
      void: true,
      closedAt: canceledAt,
    })
    // Without the node-run reads nothing says the run ended: the round reads as open.
    expect(
      (await createProcessGateFacts(db).rounds([review.taskId], { measures: false }))[0],
    ).toMatchObject({ void: false, closedAt: null })
  })

  test('an iterate closes its round; its stored reason is a rendered copy of the comments and is not text', async () => {
    const db = harness.db
    const review = await seedReview(db)
    const facts = createProcessGateFacts(db, taskExecutionParticipants)
    await comment(db, review, {
      quote: 'body',
      text: 'explain the retry policy',
      author: REVIEW_OWNER,
    })
    await decide(db, review, {
      decision: 'iterated',
      expectedReviewIteration: 0,
      comments: [{ commentText: 'cover the empty case', anchorRequest: { quote: 'inline' } }],
    })

    const decided = await storedVersion(db, review.docVersionIds[0]!)
    expect(decided.decisionReason).toContain('cover the empty case')
    const rounds = await facts.rounds([review.taskId], { measures: true })
    expect(rounds).toHaveLength(1)
    expect(rounds[0]).toMatchObject({
      ordinal: 1,
      void: false,
      outcome: 'iterated',
      deciderUserId: REVIEW_OWNER,
      closedAt: Number(decided.decidedAt),
    })
    expect(rounds[0]!.measures).toEqual({ comments: 2, commenters: 1 })
    expect(rounds[0]!.people).toEqual([{ userId: REVIEW_OWNER, comments: 2, answers: 0 }])
    const texts = await facts.texts([review.taskId], ['review', 'clarify'])
    expect(texts.map((item) => item.text).sort()).toEqual([
      'cover the empty case',
      'explain the retry policy',
    ])
  })

  test('a rejection closes its round and its reason is text of the reviewed node', async () => {
    const db = harness.db
    const review = await seedReview(db)
    const facts = createProcessGateFacts(db, taskExecutionParticipants)
    await decide(db, review, {
      decision: 'rejected',
      rejectReason: 'needs a rewrite',
      expectedReviewIteration: 0,
      comments: [{ commentText: 'tighten this', anchorRequest: { quote: 'body' } }],
    })

    const decided = await storedVersion(db, review.docVersionIds[0]!)
    const rounds = await facts.rounds([review.taskId], { measures: true })
    expect(rounds.map(brief)).toEqual([
      {
        ordinal: 1,
        void: false,
        outcome: 'rejected',
        openedAt: Number(decided.createdAt),
        closedAt: Number(decided.decidedAt),
      },
    ])
    expect(rounds[0]!.deciderUserId).toBe(REVIEW_OWNER)
    expect(rounds[0]!.measures).toEqual({ comments: 1, commenters: 1 })
    const texts = await facts.texts([review.taskId], ['review'])
    expect(texts.map((item) => item.text).sort()).toEqual(['needs a rewrite', 'tighten this'])
    expect(texts.find((item) => item.text === 'needs a rewrite')).toEqual({
      source: 'review',
      taskId: review.taskId,
      caseId: null,
      stageRef: DOC,
      at: Number(decided.decidedAt),
      text: 'needs a rewrite',
    })
    // Asking for clarify text only returns no review text.
    expect(await facts.texts([review.taskId], ['clarify'])).toEqual([])
  })

  test('versions of one review run are numbered by ready time; void versions keep their interval and take no number', async () => {
    const db = harness.db
    const review = await seedReview(db)
    const facts = createProcessGateFacts(db, taskExecutionParticipants)
    const { docVersions } = tablesOf(db)
    const run = { taskId: review.taskId, reviewNodeId: REVIEW, reviewNodeRunId: review.reviewRunId }
    // v1: sent back with two comments by two people.
    await db
      .update(docVersions)
      .set({
        createdAt: T,
        decision: 'iterated',
        decidedAt: T + 5 * MIN,
        decidedBy: REVIEW_OWNER,
        commentsJson: JSON.stringify([
          frozenComment(REVIEW_OWNER, 'first comment', T + MIN),
          frozenComment('u2', 'second comment', T + 2 * MIN),
        ]),
      })
      .where(eq(docVersions.id, review.docVersionIds[0]!))
    // v2: retired by an upstream refresh before anybody decided it.
    await addVersion(db, run, {
      versionIndex: 2,
      createdAt: T + 10 * MIN,
      decision: 'superseded',
      decisionReason: 'upstream-refreshed',
      decidedAt: T + 12 * MIN,
      decidedBy: SYSTEM_DECIDER,
    })
    // v3: rejected by the local user of an installation without accounts.
    await addVersion(db, run, {
      versionIndex: 3,
      createdAt: T + 12 * MIN,
      decision: 'rejected',
      decisionReason: 'not yet',
      decidedAt: T + 20 * MIN,
      decidedBy: LOCAL_DECIDER,
      commentsJson: JSON.stringify([frozenComment(LOCAL_DECIDER, 'third comment', T + 15 * MIN)]),
    })
    // v4: voided by a sibling review's rejection.
    await addVersion(db, run, {
      versionIndex: 4,
      createdAt: T + 30 * MIN,
      decision: 'rejected',
      decisionReason: 'invalidated by sibling reject (RFC-005 A2)',
      decidedAt: T + 31 * MIN,
      decidedBy: SYSTEM_DECIDER,
    })
    await addVersion(db, run, {
      versionIndex: 5,
      createdAt: T + 40 * MIN,
      decision: 'approved',
      decidedAt: T + 45 * MIN,
      decidedBy: 'u2',
    })
    await addVersion(db, run, { versionIndex: 6, createdAt: T + 50 * MIN })

    const rounds = await facts.rounds([review.taskId], { measures: true })
    expect(rounds.map(brief)).toEqual([
      { ordinal: 1, void: false, outcome: 'iterated', openedAt: T, closedAt: T + 5 * MIN },
      {
        ordinal: 0,
        void: true,
        outcome: 'superseded',
        openedAt: T + 10 * MIN,
        closedAt: T + 12 * MIN,
      },
      {
        ordinal: 2,
        void: false,
        outcome: 'rejected',
        openedAt: T + 12 * MIN,
        closedAt: T + 20 * MIN,
      },
      { ordinal: 0, void: true, outcome: 'voided', openedAt: T + 30 * MIN, closedAt: T + 31 * MIN },
      {
        ordinal: 3,
        void: false,
        outcome: 'approved',
        openedAt: T + 40 * MIN,
        closedAt: T + 45 * MIN,
      },
      { ordinal: 4, void: false, outcome: null, openedAt: T + 50 * MIN, closedAt: null },
    ])
    expect(rounds.every((row) => row.instanceKey === review.reviewRunId)).toBe(true)
    expect(rounds.map((row) => row.deciderUserId)).toEqual([
      REVIEW_OWNER,
      null,
      null,
      null,
      'u2',
      null,
    ])
    expect(rounds.map((row) => row.measures)).toEqual([
      { comments: 2, commenters: 2 },
      {},
      { comments: 1, commenters: 1 },
      {},
      {},
      {},
    ])
    expect(rounds.map((row) => row.people)).toEqual([
      [
        { userId: REVIEW_OWNER, comments: 1, answers: 0 },
        { userId: 'u2', comments: 1, answers: 0 },
      ],
      [],
      [],
      [],
      [],
      [],
    ])
    // The intervals and numbers do not depend on reading the archives.
    expect((await facts.rounds([review.taskId], { measures: false })).map(brief)).toEqual(
      rounds.map(brief),
    )
    // Text: the archived comments and the one reason a person typed, oldest first.
    expect(
      (await facts.texts([review.taskId], ['review'])).map((item) => [item.at, item.text]),
    ).toEqual([
      [T + MIN, 'first comment'],
      [T + 2 * MIN, 'second comment'],
      [T + 15 * MIN, 'third comment'],
      [T + 20 * MIN, 'not yet'],
    ])
  })

  test('a multi-document review is one round with its documents and the accepted ones', async () => {
    const db = harness.db
    const review = await seedReview(db, ['# doc zero', '# doc one', '# doc two'])
    const facts = createProcessGateFacts(db, taskExecutionParticipants)
    const [zero, one, two] = review.docVersionIds as [string, string, string]
    await comment(db, review, {
      quote: 'one',
      text: 'split this document',
      author: REVIEW_OWNER,
      docVersionId: one,
    })
    await setDocumentSelection({
      taskExecutionParticipants,
      db,
      nodeRunId: review.reviewRunId,
      docVersionId: zero,
      selection: 'accepted',
    })

    const open = await facts.rounds([review.taskId], { measures: true })
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ kind: 'review', ordinal: 1, void: false, outcome: null })
    expect(open[0]!.measures).toEqual({
      comments: 1,
      commenters: 1,
      documents: 3,
      documentsAccepted: 1,
    })

    await decide(db, review, {
      decision: 'approved',
      expectedReviewIteration: 0,
      selections: [
        { docVersionId: one, selection: 'not_accepted' },
        { docVersionId: two, selection: 'accepted' },
      ],
    })
    const closed = await facts.rounds([review.taskId], { measures: true })
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({
      ordinal: 1,
      void: false,
      outcome: 'approved',
      deciderUserId: REVIEW_OWNER,
      // The round was ready when its first document was.
      openedAt: open[0]!.openedAt,
    })
    expect(closed[0]!.measures).toEqual({
      comments: 1,
      commenters: 1,
      documents: 3,
      documentsAccepted: 2,
    })
    expect(closed[0]!.people).toEqual([{ userId: REVIEW_OWNER, comments: 1, answers: 0 }])
  })

  test("a sibling review's rejection voids this review's pending version; its next version is the first round", async () => {
    const db = harness.db
    const review = await seedReview(db)
    const facts = createProcessGateFacts(db, taskExecutionParticipants)
    // A second review node reads the same upstream port and is waiting too.
    const base = reviewDefinition(`doc-${review.taskId}`)
    const definition: WorkflowDefinition = {
      ...base,
      nodes: [...base.nodes, { id: 'rev_2', kind: 'review' } as unknown as WorkflowNode],
      edges: [
        ...base.edges,
        {
          id: 'e_review_2',
          source: { nodeId: DOC, portName: 'docpath' },
          target: { nodeId: 'rev_2', portName: '__review_input__' },
        },
      ],
    }
    await patchTaskFixture(
      db,
      { id: review.taskId },
      { workflowSnapshot: JSON.stringify(definition) },
    )
    const siblingRunId = ulid()
    await nodeRunFixture(db, {
      id: siblingRunId,
      taskId: review.taskId,
      nodeId: 'rev_2',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now() - 40,
    })
    const sibling = {
      taskId: review.taskId,
      reviewNodeId: 'rev_2',
      reviewNodeRunId: siblingRunId,
    }
    const voidedId = await addVersion(db, sibling, { versionIndex: 1, createdAt: Date.now() - 30 })

    await decide(db, review, {
      decision: 'rejected',
      rejectReason: 'start over',
      expectedReviewIteration: 0,
    })

    // The stamp the cascade leaves: a rejection nobody made.
    const voided = await storedVersion(db, voidedId)
    expect(voided.decision).toBe('rejected')
    expect(voided.decidedBy).toBe(SYSTEM_DECIDER)
    const rounds = await facts.rounds([review.taskId], { measures: true })
    expect(rounds).toHaveLength(2)
    expect(rounds.find((row) => row.stageNodeId === REVIEW)).toMatchObject({
      ordinal: 1,
      void: false,
      outcome: 'rejected',
      deciderUserId: REVIEW_OWNER,
    })
    expect(rounds.find((row) => row.stageNodeId === 'rev_2')).toMatchObject({
      relatedNodeId: DOC,
      gateNodeRunId: siblingRunId,
      instanceKey: siblingRunId,
      ordinal: 0,
      void: true,
      outcome: 'voided',
      deciderUserId: null,
      openedAt: Number(voided.createdAt),
      closedAt: Number(voided.decidedAt),
    })

    await addVersion(db, sibling, { versionIndex: 2, createdAt: Number(voided.decidedAt) + MIN })
    expect(
      (await facts.rounds([review.taskId], { measures: false }))
        .filter((row) => row.stageNodeId === 'rev_2')
        .map((row) => [row.void, row.ordinal]),
    ).toEqual([
      [true, 0],
      [false, 1],
    ])
    // What the framework wrote on the voided version is not a reviewer's text.
    expect((await facts.texts([review.taskId], ['review'])).map((item) => item.text)).toEqual([
      'start over',
    ])
  })

  test('a version superseded by an upstream refresh is void and the refreshed version is the first round', async () => {
    const db = harness.db
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc616-gate-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const appHome = join(home, 'appHome')
    const worktree = join(home, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    await agentFixture(db, {
      id: ulid(),
      name: 'doc',
      description: '',
      outputs: JSON.stringify(['docpath']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
    })
    const definition: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'src', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'src', portName: 'docpath' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const workflowId = ulid()
    await workflowFixture(db, {
      id: workflowId,
      name: 'rfc616-refresh',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })
    const taskId = ulid()
    await taskFixture(db, {
      id: taskId,
      name: 'rfc616-refresh',
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
      ]),
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: worktree,
      worktreePath: worktree,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const task = (await readTaskFixtures(db, { id: taskId }))[0]!
    const upstreamFinished = async (id: string, body: string) => {
      await nodeRunFixture(db, {
        id,
        taskId,
        nodeId: 'src',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      })
      await nodeRunOutputFixture(db, { nodeRunId: id, portName: 'docpath', content: body })
    }
    const dispatch = () =>
      dispatchReviewNode(
        withO2Closure({
          db,
          taskId,
          scopeRoot: task.worktreePath,
          appHome,
          definition,
          node: definition.nodes[1]!,
          iteration: 0,
        }),
      )

    // The review opens on the first upstream run, then the upstream produces a fresher one.
    await upstreamFinished('01A_OLD', '# old body')
    expect((await dispatch()).kind).toBe('awaiting_review')
    await upstreamFinished('01B_NEW', '# new body after the upstream reran')
    expect((await dispatch()).kind).toBe('awaiting_review')

    const { docVersions } = tablesOf(db)
    const versions = (
      await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))
    ).sort((a, b) => Number(a.versionIndex) - Number(b.versionIndex))
    expect(versions.map((row) => [Number(row.versionIndex), row.decision, row.decidedBy])).toEqual([
      [1, 'superseded', SYSTEM_DECIDER],
      [2, 'pending', null],
    ])
    const rounds = await createProcessGateFacts(db, taskExecutionParticipants).rounds([taskId], {
      measures: true,
    })
    expect(rounds.map((row) => [row.void, row.ordinal, row.outcome])).toEqual([
      [true, 0, 'superseded'],
      [false, 1, null],
    ])
    expect(rounds[0]).toMatchObject({
      kind: 'review',
      stageNodeId: 'rev_1',
      relatedNodeId: 'src',
      deciderUserId: null,
      openedAt: Number(versions[0]!.createdAt),
      closedAt: Number(versions[0]!.decidedAt),
    })
    expect(rounds[1]!.gateNodeRunId).toBe(rounds[0]!.gateNodeRunId)
    // The refreshed version was ready no earlier than the old one was retired.
    expect(rounds[1]!.openedAt).toBeGreaterThanOrEqual(rounds[0]!.closedAt!)
  })

  test('task id lists are de-duplicated, may be empty, and are refused beyond the batch size', async () => {
    const db = harness.db
    const review = await seedReview(db)
    const facts = createProcessGateFacts(db)
    expect(await facts.rounds([], { measures: true })).toEqual([])
    expect(await facts.texts([], ['review', 'clarify'])).toEqual([])
    expect(
      await facts.rounds([review.taskId, review.taskId, 'no-such-task'], { measures: true }),
    ).toHaveLength(1)
    expect(await facts.texts([review.taskId], [])).toEqual([])

    const tooMany = Array.from({ length: PROCESS_FACT_ID_BATCH + 1 }, (_, index) => `t-${index}`)
    await expect(facts.rounds(tooMany, { measures: false })).rejects.toBeInstanceOf(RangeError)
    await expect(facts.texts(tooMany, ['review'])).rejects.toBeInstanceOf(RangeError)
    // Exactly one batch is accepted.
    expect(await facts.rounds(tooMany.slice(1), { measures: true })).toEqual([])
    expect(await facts.texts(tooMany.slice(1), ['review', 'clarify'])).toEqual([])
  })
})

describeEachProvider('RFC-616 process gate facts — clarify rounds', (harness) => {
  beforeEach(() => resetBroadcastersForTests())

  test('a sealed round counts each answer once by how it was given, and each person by the answers they gave', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
    const round = await seedRound(
      db,
      taskId,
      'self',
      [
        question('q_rec'),
        question('q_other'),
        question('q_custom', { options: [option('A'), option('B')] }),
        question('q_skip'),
        question('q_blank'),
      ],
      { status: 'awaiting_human' },
    )
    const facts = createProcessGateFacts(db, taskExecutionParticipants)
    // A collaborator drafts one answer; the owner then submits the round with it unchanged.
    await createClarifyAnswerWritePort(db).saveDraft({
      roundId: round.roundId,
      intermediaryNodeRunId: round.origin,
      questionId: 'q_other',
      value: { selectedOptionIndices: [1], customText: '' },
      editor: { userId: 'u2', role: 'user' },
    })

    const asked = { questions: 5, questionsInitial: 5, depthSum: 5, depthMax: 1 }
    const open = await facts.rounds([taskId], { measures: true })
    expect(open).toHaveLength(1)
    // An open round has questions, but a draft is not an answer yet.
    expect(open[0]).toMatchObject({ ordinal: 1, void: false, outcome: null, closedAt: null })
    expect(open[0]!.measures).toEqual(asked)
    expect(open[0]!.people).toEqual([])
    expect(await facts.texts([taskId], ['clarify'])).toEqual([])

    const sealed = await sealRoundQuestions({
      taskExecutionParticipants,
      db,
      originNodeRunId: round.origin,
      answers: [
        answer('q_rec', { selectedOptionIndices: [0], decision: { status: 'decided' } }),
        answer('q_other', { selectedOptionIndices: [1] }),
        answer('q_custom', {
          customText: 'reuse the existing queue',
          decision: { status: 'provisional' },
        }),
        answer('q_skip', { decision: { status: 'not-applicable' } }),
        // What a whole-round submit pads an untouched question with.
        answer('q_blank'),
      ],
      directive: 'stop',
      sealedBy: 'u1',
      sealedByRole: 'owner',
    })
    expect(sealed.roundFullySealed).toBe(true)

    const stored = (await readClarifyRoundFixtures(db, { id: round.roundId }))[0]!
    expect(await facts.rounds([taskId], { measures: true })).toEqual([
      {
        taskId,
        kind: 'clarify',
        stageNodeId: CL,
        relatedNodeId: DESIGNER,
        askingShardKey: null,
        gateNodeRunId: round.origin,
        instanceKey: `${DESIGNER}|`,
        ordinal: 1,
        void: false,
        openedAt: Number(stored.createdAt),
        closedAt: Number(stored.answeredAt),
        outcome: 'stop',
        deciderUserId: 'u1',
        mindmap: false,
        measures: {
          ...asked,
          answersRecommended: 1,
          answersOther: 1,
          answersCustom: 1,
          // The marked skip and the blank answer.
          answersSkipped: 2,
          questionsWithRecommendation: 2,
          maturityDecided: 1,
          maturityProvisional: 1,
          maturityUnmarked: 1,
        },
        // The drafted answer stays its author's; the blank one is nobody's.
        people: [
          { userId: 'u1', comments: 0, answers: 3 },
          { userId: 'u2', comments: 0, answers: 1 },
        ],
      },
    ])
    const text = (body: string): ProcessTextItem => ({
      source: 'clarify',
      taskId,
      caseId: null,
      stageRef: DESIGNER,
      at: Number(stored.answeredAt),
      text: body,
    })
    expect(await facts.texts([taskId], ['clarify', 'review'])).toEqual([
      text('Q: q_custom?\nA: reuse the existing queue'),
      text('Q: q_other?\nA: B'),
      text('Q: q_rec?\nA: A'),
    ])
  })

  test('a mindmap round carries follow-ups, depth, maturity and categories — and none of it in the interval listing', async () => {
    const db = harness.db
    const taskId = await seedPlainTask(db)
    const questions = [
      question('i1', { mindmap: { categoryPath: ['Scope', 'Limits'] } }),
      question('i2', { mindmap: { categoryPath: ['Scope'] } }),
      question('i3', {
        options: [option('A'), option('B')],
        mindmap: { categoryPath: ['Data'] },
      }),
      question('f1', {
        mindmap: { categoryPath: ['Scope', 'Limits'], parentQuestionId: 'i1', requestId: 'req-1' },
      }),
      question('f2', {
        mindmap: { categoryPath: ['Scope', 'Limits'], parentQuestionId: 'i1', requestId: 'req-1' },
      }),
      question('f3', { mindmap: { categoryPath: ['Risk'], requestId: 'req-2' } }),
      question('f4', {
        mindmap: { categoryPath: ['Scope', 'Limits'], parentQuestionId: 'f1', requestId: 'req-3' },
      }),
      // Its parent is not in the round: it stays a root.
      question('f5', {
        mindmap: { categoryPath: ['Scope'], parentQuestionId: 'gone', requestId: 'req-3' },
      }),
    ]
    const mediator = await seedNodeRun(db, taskId, 'clarify')
    await seedClarifyRound(db, taskId, {
      askingNodeId: 'designer',
      askingNodeRunId: await seedNodeRun(db, taskId, 'designer'),
      intermediaryNodeId: 'clarify',
      intermediaryNodeRunId: mediator,
      questions,
      answers: [
        answer('i1', { selectedOptionIndices: [0], decision: { status: 'decided' } }),
        answer('i2', { selectedOptionIndices: [1], decision: { status: 'provisional' } }),
        answer('i3', { customText: 'neither' }),
        answer('f1', { decision: { status: 'deferred' } }),
        answer('f2', { selectedOptionIndices: [0] }),
        answer('f3', { selectedOptionIndices: [0], decision: { status: 'decided' } }),
        answer('f4', { selectedOptionIndices: [1] }),
        answer('f5', { selectedOptionIndices: [0] }),
      ],
      attributions: {
        i1: 'u1',
        i2: 'u1',
        i3: 'u1',
        f1: 'u1',
        f2: 'u1',
        f3: 'u3',
        f4: 'u1',
        f5: 'u1',
      },
      status: 'answered',
      directive: 'continue',
      createdAt: T,
      answeredAt: T + 30 * MIN,
      answeredBy: 'u1',
    })
    const facts = createProcessGateFacts(db, taskExecutionParticipants)

    const [round] = await facts.rounds([taskId], { measures: true })
    expect(round).toMatchObject({
      kind: 'clarify',
      stageNodeId: 'clarify',
      relatedNodeId: 'designer',
      gateNodeRunId: mediator,
      ordinal: 1,
      void: false,
      openedAt: T,
      closedAt: T + 30 * MIN,
      outcome: 'continue',
      deciderUserId: 'u1',
      mindmap: true,
    })
    expect(round!.measures).toEqual({
      questions: 8,
      questionsInitial: 3,
      questionsFollowup: 5,
      followupRequests: 3,
      // i1 i2 i3 f3 f5 at depth 1, f1 f2 at 2, f4 at 3.
      depthSum: 12,
      depthMax: 3,
      answersRecommended: 4,
      answersOther: 2,
      answersCustom: 1,
      answersSkipped: 1,
      questionsWithRecommendation: 6,
      maturityDecided: 2,
      maturityProvisional: 1,
      maturityUnmarked: 4,
    })
    expect(round!.people).toEqual([
      { userId: 'u1', comments: 0, answers: 7 },
      { userId: 'u3', comments: 0, answers: 1 },
    ])
    expect(round!.categories).toEqual(['Scope', 'Data', 'Risk'])
    const { categories: _categories, ...interval } = round!
    expect(await facts.rounds([taskId], { measures: false })).toEqual([
      { ...interval, mindmap: false, measures: {}, people: [] },
    ])
  })

  test('a canceled round closes when its mediator run finished, an abandoned one at its own time; neither takes a number', async () => {
    const db = harness.db
    const taskId = await seedPlainTask(db)
    const asking = await seedNodeRun(db, taskId, 'designer')
    const self = (intermediaryNodeRunId: string) => ({
      askingNodeId: 'designer',
      askingNodeRunId: asking,
      intermediaryNodeId: 'clarify',
      intermediaryNodeRunId,
    })
    await seedClarifyRound(db, taskId, {
      ...self(await seedNodeRun(db, taskId, 'clarify')),
      answers: [answer('q1', { selectedOptionIndices: [0] })],
      status: 'answered',
      directive: 'continue',
      createdAt: T,
      answeredAt: T + 10 * MIN,
      answeredBy: 'u1',
    })
    // Canceled with the task: the sweep stamped the mediator run's finish time.
    await seedClarifyRound(db, taskId, {
      ...self(
        await seedNodeRun(db, taskId, 'clarify', {
          status: 'canceled',
          startedAt: T + 40 * MIN,
          finishedAt: T + 55 * MIN,
        }),
      ),
      status: 'canceled',
      createdAt: T + 40 * MIN,
    })
    // Canceled, but its mediator run recorded no finish time.
    await seedClarifyRound(db, taskId, {
      ...self(await seedNodeRun(db, taskId, 'clarify', { status: 'canceled' })),
      status: 'canceled',
      createdAt: T + 60 * MIN,
    })
    await seedClarifyRound(db, taskId, {
      ...self(await seedNodeRun(db, taskId, 'clarify')),
      answers: [answer('q1', { selectedOptionIndices: [1] })],
      status: 'answered',
      directive: 'stop',
      createdAt: T + 70 * MIN,
      answeredAt: T + 80 * MIN,
      answeredBy: 'u1',
    })
    // A cross-agent round abandoned with its own timestamp, before its mediator run ended.
    await seedClarifyRound(db, taskId, {
      kind: 'cross',
      askingNodeId: 'asker',
      askingNodeRunId: await seedNodeRun(db, taskId, 'asker'),
      intermediaryNodeId: 'cross',
      intermediaryNodeRunId: await seedNodeRun(db, taskId, 'cross', {
        status: 'canceled',
        startedAt: T + 85 * MIN,
        finishedAt: T + 95 * MIN,
      }),
      status: 'abandoned',
      createdAt: T + 85 * MIN,
      abandonedAt: T + 90 * MIN,
    })

    const withNodeRuns = await createProcessGateFacts(db, taskExecutionParticipants).rounds(
      [taskId],
      { measures: false },
    )
    expect(withNodeRuns.map((row) => [row.instanceKey, brief(row)])).toEqual([
      [
        'designer|',
        { ordinal: 1, void: false, outcome: 'continue', openedAt: T, closedAt: T + 10 * MIN },
      ],
      [
        'designer|',
        {
          ordinal: 0,
          void: true,
          outcome: 'canceled',
          openedAt: T + 40 * MIN,
          closedAt: T + 55 * MIN,
        },
      ],
      [
        'designer|',
        {
          ordinal: 0,
          void: true,
          outcome: 'canceled',
          openedAt: T + 60 * MIN,
          // Nothing says when it ended: it closes where it opened.
          closedAt: T + 60 * MIN,
        },
      ],
      [
        'designer|',
        {
          ordinal: 2,
          void: false,
          outcome: 'stop',
          openedAt: T + 70 * MIN,
          closedAt: T + 80 * MIN,
        },
      ],
      [
        'asker|',
        {
          ordinal: 0,
          void: true,
          outcome: 'abandoned',
          openedAt: T + 85 * MIN,
          closedAt: T + 90 * MIN,
        },
      ],
    ])
    expect(withNodeRuns.every((row) => row.deciderUserId === (row.void ? null : 'u1'))).toBe(true)

    // Without node-run reads a canceled round cannot find its end and closes where it opened.
    const withoutNodeRuns = await createProcessGateFacts(db).rounds([taskId], { measures: true })
    expect(withoutNodeRuns.map((row) => row.closedAt)).toEqual([
      T + 10 * MIN,
      T + 40 * MIN,
      T + 60 * MIN,
      T + 80 * MIN,
      T + 90 * MIN,
    ])
    expect(withoutNodeRuns.map((row) => row.ordinal)).toEqual([1, 0, 0, 2, 0])
  })

  test('a round whose answers survive only as a legacy payload is still an answered round, with nothing counted from them', async () => {
    const db = harness.db
    const taskId = await seedPlainTask(db)
    const legacy = JSON.stringify({ q1: 'the first option', q2: 'something else' })
    const roundId = await seedClarifyRound(db, taskId, {
      askingNodeId: 'designer',
      askingNodeRunId: await seedNodeRun(db, taskId, 'designer'),
      intermediaryNodeId: 'clarify',
      intermediaryNodeRunId: await seedNodeRun(db, taskId, 'clarify'),
      questions: [question('q1'), question('q2')],
      answers: legacy,
      status: 'answered',
      createdAt: T,
      answeredAt: T + 5 * MIN,
      answeredBy: LOCAL_DECIDER,
    })
    // The payload is not an answer list, so it lives in the legacy column alone.
    const stored = (await readClarifyRoundFixtures(db, { id: roundId }))[0]!
    expect(stored.legacyAnswersJson).toBe(legacy)
    expect(stored.answersRecorded).toBe(false)

    const facts = createProcessGateFacts(db, taskExecutionParticipants)
    const [round] = await facts.rounds([taskId], { measures: true })
    expect(round).toMatchObject({
      ordinal: 1,
      void: false,
      openedAt: T,
      closedAt: T + 5 * MIN,
      // Answered before the directive existed, by the local user.
      outcome: 'continue',
      deciderUserId: null,
    })
    expect(round!.measures).toEqual({
      questions: 2,
      questionsInitial: 2,
      depthSum: 2,
      depthMax: 1,
    })
    expect(round!.people).toEqual([])
    expect(await facts.texts([taskId], ['clarify'])).toEqual([])
  })

  test('workgroup askers are told apart by the shard key of their host run', async () => {
    const db = harness.db
    const taskId = await seedPlainTask(db)
    const shardA = buildMsgShardKey('mem-a', '01MSG1')
    const shardB = buildMsgShardKey('mem-b', '01MSG2')
    const hostA = await seedNodeRun(db, taskId, WORKGROUP_TURN_MEMBER_NODE_ID, { shardKey: shardA })
    const hostB = await seedNodeRun(db, taskId, WORKGROUP_TURN_MEMBER_NODE_ID, { shardKey: shardB })
    const ask = async (
      host: string,
      shard: string,
      seed: Pick<RoundSeed, 'status' | 'createdAt' | 'answeredAt'>,
    ) =>
      seedClarifyRound(db, taskId, {
        askingNodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
        askingNodeRunId: host,
        askingShardKey: shard,
        intermediaryNodeId: WORKGROUP_TURN_CLARIFY_NODE_ID,
        intermediaryNodeRunId: await seedNodeRun(db, taskId, WORKGROUP_TURN_CLARIFY_NODE_ID, {
          status: seed.status === 'answered' ? 'done' : 'awaiting_human',
        }),
        ...(seed.status === 'answered'
          ? {
              answers: [answer('q1', { selectedOptionIndices: [0] })],
              directive: 'continue' as const,
              answeredBy: 'u1',
            }
          : {}),
        ...seed,
      })
    await ask(hostA, shardA, { status: 'answered', createdAt: T, answeredAt: T + 5 * MIN })
    await ask(hostB, shardB, { status: 'awaiting_human', createdAt: T + 2 * MIN })
    await ask(hostA, shardA, {
      status: 'answered',
      createdAt: T + 10 * MIN,
      answeredAt: T + 12 * MIN,
    })

    const rounds = await createProcessGateFacts(db, taskExecutionParticipants).rounds([taskId], {
      measures: true,
    })
    expect(
      rounds.map((row) => [row.askingShardKey, row.instanceKey, row.ordinal, row.outcome]),
    ).toEqual([
      [shardA, `${WORKGROUP_TURN_MEMBER_NODE_ID}|${shardA}`, 1, 'continue'],
      [shardB, `${WORKGROUP_TURN_MEMBER_NODE_ID}|${shardB}`, 1, null],
      [shardA, `${WORKGROUP_TURN_MEMBER_NODE_ID}|${shardA}`, 2, 'continue'],
    ])
    for (const row of rounds) {
      expect(row).toMatchObject({
        kind: 'clarify',
        stageNodeId: WORKGROUP_TURN_CLARIFY_NODE_ID,
        relatedNodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
      })
    }
  })

  test('the interval listing reads no stored JSON, and counting costs one statement per ledger', async () => {
    const db = harness.db
    const review = await seedReviewRound(db)
    try {
      // Seeded as a row: nothing may publish in the background while statements are recorded.
      const { reviewComments } = tablesOf(db)
      await insertOne(db, reviewComments, {
        id: ulid(),
        docVersionId: review.docVersionIds[0]!,
        anchorSectionPath: '',
        anchorParagraphIdx: 0,
        anchorOffsetStart: 2,
        anchorOffsetEnd: 6,
        selectedText: 'body',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
        ...inlineContentColumns(Buffer.from('a live comment', 'utf8'), 'text/plain'),
        author: REVIEW_OWNER,
        createdAt: T,
      })
      const taskIds = [review.taskId]
      // Three more tasks, each with two answered rounds and a canceled one.
      for (let index = 0; index < 3; index++) {
        const taskId = await seedPlainTask(db)
        taskIds.push(taskId)
        const asking = await seedNodeRun(db, taskId, 'designer')
        for (const status of ['answered', 'answered', 'canceled'] as const) {
          await seedClarifyRound(db, taskId, {
            askingNodeId: 'designer',
            askingNodeRunId: asking,
            intermediaryNodeId: 'clarify',
            intermediaryNodeRunId: await seedNodeRun(db, taskId, 'clarify', {
              status: status === 'answered' ? 'done' : 'canceled',
            }),
            status,
            createdAt: T,
            ...(status === 'answered'
              ? {
                  answers: [answer('q1', { selectedOptionIndices: [0] })],
                  attributions: { q1: 'u1' },
                  directive: 'continue' as const,
                  answeredAt: T + MIN,
                  answeredBy: 'u1',
                }
              : {}),
          })
        }
      }
      const facts = createProcessGateFacts(db, taskExecutionParticipants)
      const reading = (statements: readonly { sql: string }[], table: string) =>
        statements.filter((statement) => statement.sql.includes(`"${table}"`)).length

      const interval = harness.recordStatements()
      try {
        expect(await facts.rounds(taskIds, { measures: false })).toHaveLength(10)
        const selects = interval.selects()
        expect(reading(selects, 'doc_versions')).toBe(1)
        expect(reading(selects, 'clarify_rounds')).toBe(1)
        expect(reading(selects, 'review_comments')).toBe(0)
        expect(reading(selects, 'clarify_answers')).toBe(0)
        expect(reading(selects, 'clarify_answer_attributions')).toBe(0)
        for (const column of [
          'comments_json',
          'decision_reason',
          'questions_json',
          'legacy_answers_json',
        ]) {
          expect(
            selects.filter((statement) => statement.sql.includes(column)),
            `the interval listing must not load ${column}`,
          ).toEqual([])
        }
      } finally {
        interval.stop()
      }

      const counting = harness.recordStatements()
      try {
        const rounds = await facts.rounds(taskIds, { measures: true })
        expect(rounds).toHaveLength(10)
        expect(rounds.filter((row) => row.measures.answersRecommended === 1)).toHaveLength(6)
        // One scan per ledger for the whole batch, not one per round.
        const selects = counting.selects()
        for (const table of [
          'doc_versions',
          'review_comments',
          'clarify_rounds',
          'clarify_answers',
          'clarify_answer_attributions',
        ]) {
          expect(reading(selects, table), `statements reading ${table}`).toBe(1)
        }
        // The archive is read for counting; the decision reason only for text.
        expect(selects.filter((statement) => statement.sql.includes('decision_reason'))).toEqual([])
      } finally {
        counting.stop()
      }

      const texting = harness.recordStatements()
      try {
        // The live comment and one answered question per submitted round.
        const texts = await facts.texts(taskIds, ['review', 'clarify'])
        expect(texts.map((item) => item.text).sort()).toEqual([
          ...Array.from({ length: 6 }, () => 'Q: q1?\nA: A'),
          'a live comment',
        ])
        const selects = texting.selects()
        for (const table of [
          'doc_versions',
          'review_comments',
          'clarify_rounds',
          'clarify_answers',
        ]) {
          expect(reading(selects, table), `statements reading ${table}`).toBe(1)
        }
        // Who answered is not text.
        expect(reading(selects, 'clarify_answer_attributions')).toBe(0)
      } finally {
        texting.stop()
      }
    } finally {
      review.cleanup()
    }
    // Four tasks with their runs and rounds are seeded row by row: more than the default budget
    // on a busy PostgreSQL lane, and none of it is what the test measures.
  }, 20_000)
})
