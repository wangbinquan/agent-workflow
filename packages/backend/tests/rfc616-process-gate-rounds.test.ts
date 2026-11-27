// RFC-616 §5.2 / §14 — the pure rules behind the gate facts collaboration offers
// to process metrics (`modules/collaboration/domain/processGateRounds.ts`).
//
// Why this file exists: every review and clarify statistic of process metrics
// (rounds, first-pass rate, comments per round, answer kinds, recommendation
// adoption, mindmap depth) is computed from the rows these rules produce, and
// the dual-engine suite (rfc616-process-gate-facts.test.ts) can only sample
// them. The cases below lock each rule on its edges:
//   - which doc versions form one review round, single- and multi-document;
//   - void rounds (superseded upstream, voided by a sibling's rejection,
//     canceled or abandoned clarify rounds) keep their interval, take ordinal 0
//     and never shift the numbering of the valid rounds around them;
//   - the four answer kinds, including the blank answer a round submit pads an
//     untouched question with (it must not read as "took the recommendation");
//   - mindmap depth over chains, forks, missing parents and parent loops.

import { describe, expect, test } from 'bun:test'
import {
  isTerminalNodeRunStatus,
  LOCAL_DECIDER,
  NODE_RUN_STATUS,
  SYSTEM_DECIDER,
  TERMINAL_NODE_RUN_STATUSES,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import {
  clarifyQuestionDepths,
  clarifyRoundClosesWithMediator,
  clarifyRoundDraft,
  clarifyRoundTexts,
  groupReviewRounds,
  numberGateRounds,
  orderTextItems,
  parseArchivedReviewComments,
  parseStoredQuestions,
  reviewRoundDraft,
  reviewRunEndOf,
  reviewRoundTexts,
  type ClarifyRoundContent,
  type ClarifyRoundFact,
  type GateRoundDraft,
  type ReviewVersionFact,
} from '@/modules/collaboration/domain/processGateRounds'
import type { ProcessTextItem } from '@/platform/contracts/processFacts'

const T = Date.UTC(2026, 10, 1)
const MIN = 60_000

function version(overrides: Partial<ReviewVersionFact> & { id: string }): ReviewVersionFact {
  return {
    taskId: 't1',
    reviewNodeId: 'review',
    reviewNodeRunId: 'run-1',
    sourceNodeId: 'design',
    versionIndex: 1,
    reviewIteration: 0,
    roundGeneration: null,
    itemIndex: null,
    selection: null,
    decision: 'pending',
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
    createdAt: T,
    ...overrides,
  }
}

function clarifyRound(overrides: Partial<ClarifyRoundFact> = {}): ClarifyRoundFact {
  return {
    id: 'round-1',
    taskId: 't1',
    askingNodeId: 'designer',
    askingShardKey: null,
    intermediaryNodeId: 'clarify',
    intermediaryNodeRunId: 'nr-clarify',
    status: 'answered',
    directive: 'continue',
    createdAt: T,
    answeredAt: T + 30 * MIN,
    answeredBy: 'u1',
    abandonedAt: null,
    ...overrides,
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
  overrides: Partial<Pick<ClarifyQuestion, 'kind' | 'options' | 'mindmap'>> = {},
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

function content(
  questions: readonly ClarifyQuestion[],
  answers: readonly ClarifyAnswer[] | null = null,
  attributions: Record<string, string> = {},
): ClarifyRoundContent {
  return {
    questions,
    answers,
    attributions: Object.fromEntries(
      Object.entries(attributions).map(([questionId, userId]) => [
        questionId,
        { userId, role: 'user' as const, updatedAt: T },
      ]),
    ),
  }
}

function draft(overrides: Partial<GateRoundDraft>): GateRoundDraft {
  return {
    taskId: 't1',
    kind: 'review',
    stageNodeId: 'review',
    relatedNodeId: 'design',
    askingShardKey: null,
    gateNodeRunId: 'run-1',
    instanceKey: 'run-1',
    void: false,
    openedAt: T,
    closedAt: null,
    outcome: null,
    deciderUserId: null,
    mindmap: false,
    measures: {},
    people: [],
    ...overrides,
  }
}

describe('RFC-616 gate rounds — review rounds', () => {
  test('a single-document review is one round per version, numbered in the order they became ready', () => {
    const rounds = groupReviewRounds([
      version({ id: 'v3', versionIndex: 3, createdAt: T + 20 * MIN }),
      version({
        id: 'v1',
        versionIndex: 1,
        decision: 'iterated',
        decidedAt: T + 5 * MIN,
        decidedBy: 'u1',
      }),
      version({
        id: 'v2',
        versionIndex: 2,
        createdAt: T + 10 * MIN,
        decision: 'rejected',
        decidedAt: T + 15 * MIN,
        decidedBy: 'u2',
      }),
    ])
    expect(rounds.map((round) => round.versions.map((member) => member.id))).toEqual([
      ['v1'],
      ['v2'],
      ['v3'],
    ])
    expect(rounds.every((round) => !round.multiDocument)).toBe(true)

    const rows = numberGateRounds(
      ['t1'],
      rounds.map((round) => reviewRoundDraft(round, null)),
    )
    expect(rows[0]).toEqual({
      taskId: 't1',
      kind: 'review',
      stageNodeId: 'review',
      relatedNodeId: 'design',
      askingShardKey: null,
      gateNodeRunId: 'run-1',
      instanceKey: 'run-1',
      ordinal: 1,
      void: false,
      openedAt: T,
      closedAt: T + 5 * MIN,
      outcome: 'iterated',
      deciderUserId: 'u1',
      mindmap: false,
      measures: {},
      people: [],
    })
    expect(rows.map((row) => [row.ordinal, row.outcome, row.closedAt, row.deciderUserId])).toEqual([
      [1, 'iterated', T + 5 * MIN, 'u1'],
      [2, 'rejected', T + 15 * MIN, 'u2'],
      [3, null, null, null],
    ])
  })

  test('the documents of a multi-document review form one round per generation', () => {
    const rounds = groupReviewRounds([
      version({
        id: 'g2-b',
        itemIndex: 1,
        roundGeneration: 2,
        createdAt: T + 10 * MIN,
        selection: 'unselected',
      }),
      version({
        id: 'g1-c',
        itemIndex: 2,
        roundGeneration: 1,
        createdAt: T + 2,
        selection: 'accepted',
        decision: 'superseded',
        decidedAt: T + 10 * MIN,
        decidedBy: SYSTEM_DECIDER,
      }),
      version({
        id: 'g2-a',
        itemIndex: 0,
        roundGeneration: 2,
        createdAt: T + 10 * MIN,
        selection: 'accepted',
      }),
      version({
        id: 'g1-a',
        itemIndex: 0,
        roundGeneration: 1,
        createdAt: T + 1,
        selection: 'unselected',
        decision: 'superseded',
        decidedAt: T + 10 * MIN,
        decidedBy: SYSTEM_DECIDER,
      }),
      version({
        id: 'g1-b',
        itemIndex: 1,
        roundGeneration: 1,
        createdAt: T,
        selection: 'not_accepted',
        decision: 'superseded',
        decidedAt: T + 10 * MIN,
        decidedBy: SYSTEM_DECIDER,
      }),
    ])
    expect(rounds.map((round) => round.versions.map((member) => member.id))).toEqual([
      ['g1-a', 'g1-b', 'g1-c'],
      ['g2-a', 'g2-b'],
    ])
    expect(rounds.every((round) => round.multiDocument)).toBe(true)
    // A round is ready when its first document is.
    expect(rounds[0]!.openedAt).toBe(T)

    const rows = numberGateRounds(
      ['t1'],
      [reviewRoundDraft(rounds[0]!, []), reviewRoundDraft(rounds[1]!, ['u1', 'u1', 'u2'])],
    )
    expect(rows.map((row) => [row.void, row.ordinal, row.outcome, row.closedAt])).toEqual([
      [true, 0, 'superseded', T + 10 * MIN],
      [false, 1, null, null],
    ])
    expect(rows[0]!.measures).toEqual({ documents: 3, documentsAccepted: 1 })
    expect(rows[1]!.measures).toEqual({
      comments: 3,
      commenters: 2,
      documents: 2,
      documentsAccepted: 1,
    })
    expect(rows[1]!.people).toEqual([
      { userId: 'u1', comments: 2, answers: 0 },
      { userId: 'u2', comments: 1, answers: 0 },
    ])
  })

  test('rounds minted before generations existed group by review iteration, and a run may hold both shapes', () => {
    const rounds = groupReviewRounds([
      version({ id: 'legacy-1b', itemIndex: 1, reviewIteration: 1, createdAt: T + 9 * MIN }),
      version({ id: 'legacy-0a', itemIndex: 0, reviewIteration: 0, decision: 'iterated' }),
      version({ id: 'legacy-1a', itemIndex: 0, reviewIteration: 1, createdAt: T + 9 * MIN }),
      version({ id: 'whole', versionIndex: 7, createdAt: T + 20 * MIN }),
      version({ id: 'other-run', reviewNodeRunId: 'run-2' }),
    ])
    expect(
      rounds.map((round) => [round.reviewNodeRunId, round.versions.map((member) => member.id)]),
    ).toEqual([
      ['run-1', ['whole']],
      ['run-1', ['legacy-0a']],
      ['run-1', ['legacy-1a', 'legacy-1b']],
      ['run-2', ['other-run']],
    ])
  })

  test('a superseded version and a version the system rejected are void; a person keeps the decision', () => {
    const [superseded, voided, rejected, lost] = groupReviewRounds([
      version({
        id: 'v1',
        versionIndex: 1,
        decision: 'superseded',
        decidedAt: T + MIN,
        decidedBy: SYSTEM_DECIDER,
      }),
      version({
        id: 'v2',
        versionIndex: 2,
        createdAt: T + 2 * MIN,
        decision: 'rejected',
        decidedAt: T + 3 * MIN,
        decidedBy: SYSTEM_DECIDER,
      }),
      version({
        id: 'v3',
        versionIndex: 3,
        createdAt: T + 4 * MIN,
        decision: 'rejected',
        decidedAt: T + 5 * MIN,
        decidedBy: LOCAL_DECIDER,
      }),
      // A decided row that lost its decision time still closed: where it opened.
      version({ id: 'v4', versionIndex: 4, createdAt: T + 6 * MIN, decision: 'superseded' }),
    ]).map((round) => reviewRoundDraft(round, null))
    expect(superseded).toMatchObject({
      void: true,
      outcome: 'superseded',
      openedAt: T,
      closedAt: T + MIN,
      deciderUserId: null,
    })
    expect(voided).toMatchObject({
      void: true,
      outcome: 'voided',
      openedAt: T + 2 * MIN,
      closedAt: T + 3 * MIN,
      deciderUserId: null,
    })
    // The pre-account local user decided it: a real decision by nobody a statistic can name.
    expect(rejected).toMatchObject({ void: false, outcome: 'rejected', deciderUserId: null })
    expect(lost).toMatchObject({ void: true, openedAt: T + 6 * MIN, closedAt: T + 6 * MIN })
  })

  test('a round still pending on a run the platform closed is over, and void: nobody decided it', () => {
    // Regression: canceling a task closes the waiting review run and leaves the version pending.
    // It read as an open round for ever, so the task "waited on review" until it ended.
    const [round] = groupReviewRounds([version({ id: 'v1', createdAt: T })])
    // The run still waits: the round is open.
    // Every state a run can still leave, straight from the shared status universe.
    const waiting = NODE_RUN_STATUS.filter((status) => !isTerminalNodeRunStatus(status))
    expect([...waiting].sort()).toEqual(['awaiting_human', 'awaiting_review', 'pending', 'running'])
    for (const status of waiting)
      expect(
        reviewRoundDraft(round!, null, reviewRunEndOf({ status, finishedAt: null })),
      ).toMatchObject({ void: false, closedAt: null, outcome: null })
    // Nothing known about the run: the round reads as open, as before.
    expect(reviewRoundDraft(round!, null)).toMatchObject({ void: false, closedAt: null })
    for (const status of TERMINAL_NODE_RUN_STATUSES)
      expect(
        reviewRoundDraft(round!, ['u1'], reviewRunEndOf({ status, finishedAt: T + 40 * MIN })),
      ).toMatchObject({
        void: true,
        outcome: 'canceled',
        openedAt: T,
        closedAt: T + 40 * MIN,
        deciderUserId: null,
        // What was written before the run ended is still counted on the round.
        measures: { comments: 1, commenters: 1 },
      })
    // A run that ended without a finish time, or with one before the round opened, closes it where it opened.
    for (const finishedAt of [null, T - MIN])
      expect(
        reviewRoundDraft(round!, null, reviewRunEndOf({ status: 'canceled', finishedAt })).closedAt,
      ).toBe(T)
    // A decided round is not touched by what became of its run.
    const [decided] = groupReviewRounds([
      version({ id: 'v2', decision: 'approved', decidedAt: T + MIN, decidedBy: 'u1' }),
    ])
    expect(
      reviewRoundDraft(
        decided!,
        null,
        reviewRunEndOf({ status: 'canceled', finishedAt: T + 9 * MIN }),
      ),
    ).toMatchObject({ void: false, outcome: 'approved', closedAt: T + MIN })
  })

  test('comments are counted per round; only authors with an account become people', () => {
    const [round] = groupReviewRounds([version({ id: 'v1' })])
    const counted = reviewRoundDraft(round!, [LOCAL_DECIDER, 'u1', LOCAL_DECIDER, SYSTEM_DECIDER])
    // Documents belong to multi-document rounds only.
    expect(counted.measures).toEqual({ comments: 4, commenters: 3 })
    expect(counted.people).toEqual([{ userId: 'u1', comments: 1, answers: 0 }])
    // Absent keys are zero: a round nobody commented on carries no measure at all.
    for (const authors of [[], null]) {
      const uncounted = reviewRoundDraft(round!, authors)
      expect(uncounted.measures).toEqual({})
      expect(uncounted.people).toEqual([])
    }
  })

  test('a damaged comment archive holds no comments instead of failing the summary', () => {
    expect(parseArchivedReviewComments(null)).toEqual([])
    expect(parseArchivedReviewComments('')).toEqual([])
    expect(parseArchivedReviewComments('[]')).toEqual([])
    expect(parseArchivedReviewComments('not json')).toEqual([])
    expect(parseArchivedReviewComments('{"author":"u1"}')).toEqual([])
    expect(
      parseArchivedReviewComments(
        JSON.stringify([
          { author: 'u1', commentText: 'tighten', createdAt: T },
          { commentText: 'no author' },
          'junk',
          null,
          { author: '', commentText: 7, createdAt: 'yesterday' },
        ]),
      ),
    ).toEqual([
      { author: 'u1', text: 'tighten', at: T },
      { author: LOCAL_DECIDER, text: 'no author', at: null },
      { author: LOCAL_DECIDER, text: '', at: null },
    ])
  })

  test('review text is every comment plus the reason of a rejection — never the rendered copy an iterate stores', () => {
    const item = (text: string, at: number): ProcessTextItem => ({
      source: 'review',
      taskId: 't1',
      caseId: null,
      stageRef: 'design',
      at,
      text,
    })
    const comments = [
      { text: 'tighten the scope', at: T + MIN },
      { text: '   ', at: T + 2 * MIN },
      { text: 'no timestamp', at: null },
    ]
    const [rejected, iterated, voided, pending] = groupReviewRounds([
      version({
        id: 'v1',
        versionIndex: 1,
        decision: 'rejected',
        decisionReason: '  start over  ',
        decidedAt: T + 5 * MIN,
        decidedBy: 'u1',
      }),
      version({
        id: 'v2',
        versionIndex: 2,
        decision: 'iterated',
        decisionReason: '### Comment 1\n**Comment**: tighten the scope',
        decidedAt: T + 9 * MIN,
        decidedBy: 'u1',
      }),
      version({
        id: 'v3',
        versionIndex: 3,
        decision: 'rejected',
        decisionReason: 'invalidated by sibling reject (RFC-005 A2)',
        decidedAt: T + 12 * MIN,
        decidedBy: SYSTEM_DECIDER,
      }),
      version({ id: 'v4', versionIndex: 4, createdAt: T + 20 * MIN }),
    ])
    expect(reviewRoundTexts(rejected!, comments)).toEqual([
      item('tighten the scope', T + MIN),
      item('no timestamp', T + 5 * MIN),
      item('start over', T + 5 * MIN),
    ])
    expect(reviewRoundTexts(iterated!, comments).map((entry) => entry.text)).toEqual([
      'tighten the scope',
      'no timestamp',
    ])
    expect(reviewRoundTexts(voided!, comments)).toEqual([])
    // A comment on a version still under review falls back to when it became ready.
    expect(reviewRoundTexts(pending!, [{ text: 'early note', at: null }])).toEqual([
      item('early note', T + 20 * MIN),
    ])
  })
})

describe('RFC-616 gate rounds — clarify rounds', () => {
  test('an answered round closes at its answer with the directive as outcome; an open one stays open', () => {
    expect(clarifyRoundDraft(clarifyRound(), null, null)).toEqual({
      taskId: 't1',
      kind: 'clarify',
      stageNodeId: 'clarify',
      relatedNodeId: 'designer',
      askingShardKey: null,
      gateNodeRunId: 'nr-clarify',
      instanceKey: 'designer|',
      void: false,
      openedAt: T,
      closedAt: T + 30 * MIN,
      outcome: 'continue',
      deciderUserId: 'u1',
      mindmap: false,
      measures: {},
      people: [],
    })
    expect(clarifyRoundDraft(clarifyRound({ directive: 'stop' }), null, null).outcome).toBe('stop')
    // Rounds answered before the directive existed kept asking.
    expect(
      clarifyRoundDraft(clarifyRound({ directive: null, answeredBy: null }), null, null),
    ).toMatchObject({ outcome: 'continue', deciderUserId: null })
    expect(
      clarifyRoundDraft(clarifyRound({ answeredBy: LOCAL_DECIDER }), null, null).deciderUserId,
    ).toBeNull()
    expect(
      clarifyRoundDraft(
        clarifyRound({ status: 'awaiting_human', answeredAt: null, answeredBy: null }),
        T + 99 * MIN,
        null,
      ),
    ).toMatchObject({ void: false, closedAt: null, outcome: null, deciderUserId: null })
  })

  test('a workgroup asker is told apart by its shard key', () => {
    expect(
      clarifyRoundDraft(
        clarifyRound({
          askingNodeId: '__wg_member__',
          askingShardKey: 'msg:mem-a:01',
          intermediaryNodeId: '__wg_clarify__',
        }),
        null,
        null,
      ),
    ).toMatchObject({
      stageNodeId: '__wg_clarify__',
      relatedNodeId: '__wg_member__',
      askingShardKey: 'msg:mem-a:01',
      instanceKey: '__wg_member__|msg:mem-a:01',
    })
  })

  test('a canceled round closes when its mediator run finished, and where it opened when nothing says', () => {
    const canceled = clarifyRound({ status: 'canceled', answeredAt: null, answeredBy: null })
    expect(clarifyRoundClosesWithMediator(canceled)).toBe(true)
    expect(clarifyRoundDraft(canceled, T + 12 * MIN, null)).toMatchObject({
      void: true,
      outcome: 'canceled',
      openedAt: T,
      closedAt: T + 12 * MIN,
      deciderUserId: null,
    })
    // A void round must never stretch to the end of its task.
    expect(clarifyRoundDraft(canceled, null, null)).toMatchObject({ void: true, closedAt: T })
    // A mediator finish before the round opened cannot close it earlier than it opened.
    expect(clarifyRoundDraft(canceled, T - MIN, null).closedAt).toBe(T)
  })

  test('an abandoned round closes at its own timestamp, and falls back to the mediator without one', () => {
    const abandoned = clarifyRound({
      status: 'abandoned',
      answeredAt: null,
      answeredBy: null,
      abandonedAt: T + 7 * MIN,
    })
    expect(clarifyRoundClosesWithMediator(abandoned)).toBe(false)
    expect(clarifyRoundDraft(abandoned, T + 20 * MIN, null)).toMatchObject({
      void: true,
      outcome: 'abandoned',
      closedAt: T + 7 * MIN,
    })
    const undated = { ...abandoned, abandonedAt: null }
    expect(clarifyRoundClosesWithMediator(undated)).toBe(true)
    expect(clarifyRoundDraft(undated, T + 20 * MIN, null).closedAt).toBe(T + 20 * MIN)
    expect(clarifyRoundDraft(undated, null, null).closedAt).toBe(T)
    expect(clarifyRoundClosesWithMediator(clarifyRound())).toBe(false)
  })

  test('every question of a submitted round falls into exactly one answer kind', () => {
    const three = [option('A', true), option('B', true), option('C')]
    const questions = [
      question('recommended'),
      question('other'),
      question('all-recommended', { kind: 'multi', options: three }),
      question('one-not-recommended', { kind: 'multi', options: three }),
      question('custom'),
      question('custom-with-options', { kind: 'multi' }),
      question('marked-skip'),
      question('blank'),
      question('missing'),
      question('stale-skip'),
      question('out-of-range'),
      // Rounds stored before options carried metadata hold plain strings.
      question('legacy-options', { options: ['A', 'B'] as unknown as ClarifyQuestion['options'] }),
    ]
    const answers = [
      answer('recommended', { selectedOptionIndices: [0], decision: { status: 'decided' } }),
      answer('other', { selectedOptionIndices: [1], decision: { status: 'provisional' } }),
      answer('all-recommended', { selectedOptionIndices: [0, 1] }),
      answer('one-not-recommended', { selectedOptionIndices: [0, 2] }),
      answer('custom', { customText: '  my own answer  ' }),
      answer('custom-with-options', { selectedOptionIndices: [0], customText: 'plus this' }),
      answer('marked-skip', { decision: { status: 'deferred' } }),
      // What a round submit pads an untouched question with: nothing selected is not "all
      // selected options were recommended".
      answer('blank'),
      // A skip status next to a real answer is stale: the answer wins.
      answer('stale-skip', { selectedOptionIndices: [0], decision: { status: 'not-applicable' } }),
      answer('out-of-range', { selectedOptionIndices: [9] }),
      answer('legacy-options', { selectedOptionIndices: [0] }),
    ]
    const row = clarifyRoundDraft(
      clarifyRound(),
      null,
      content(questions, answers, {
        recommended: 'u1',
        other: 'u2',
        custom: 'u2',
        'marked-skip': 'u1',
        // Frozen to the submitter, but nobody answered it.
        blank: 'u1',
        'stale-skip': LOCAL_DECIDER,
        'all-recommended': SYSTEM_DECIDER,
      }),
    )
    expect(row.measures).toEqual({
      questions: 12,
      questionsInitial: 12,
      depthSum: 12,
      depthMax: 1,
      answersRecommended: 3,
      answersOther: 4,
      answersCustom: 2,
      answersSkipped: 3,
      // The adoption rate is taken over answered questions that offered a recommendation.
      questionsWithRecommendation: 8,
      maturityDecided: 1,
      maturityProvisional: 1,
      maturityUnmarked: 7,
    })
    const kinds =
      row.measures.answersRecommended! +
      row.measures.answersOther! +
      row.measures.answersCustom! +
      row.measures.answersSkipped!
    expect(kinds).toBe(row.measures.questions!)
    // A marked skip is an answer its author gave; a blank one is nobody's.
    expect(row.people).toEqual([
      { userId: 'u1', comments: 0, answers: 2 },
      { userId: 'u2', comments: 0, answers: 2 },
    ])
    expect(row.mindmap).toBe(false)
  })

  test('answers are not counted before the round is submitted, nor when the stored payload is not an answer list', () => {
    const questions = [question('q1'), question('q2')]
    const answers = [answer('q1', { selectedOptionIndices: [0] })]
    const asked = { questions: 2, questionsInitial: 2, depthSum: 2, depthMax: 1 }
    for (const status of ['awaiting_human', 'canceled', 'abandoned']) {
      const row = clarifyRoundDraft(
        clarifyRound({ status, answeredAt: null }),
        null,
        content(questions, answers, { q1: 'u1' }),
      )
      expect(row.measures).toEqual(asked)
      expect(row.people).toEqual([])
    }
    const undecodable = clarifyRoundDraft(clarifyRound(), null, content(questions, null))
    expect(undecodable).toMatchObject({ void: false, outcome: 'continue', people: [] })
    expect(undecodable.measures).toEqual(asked)
    // Recorded as an empty list is different: the round was submitted with nothing answered.
    expect(clarifyRoundDraft(clarifyRound(), null, content(questions, [])).measures).toEqual({
      ...asked,
      answersSkipped: 2,
    })
  })

  test('mindmap depth follows the parent chain: chains, forks, missing parents and loops', () => {
    const child = (id: string, parentQuestionId: string) =>
      question(id, { mindmap: { categoryPath: ['Scope'], parentQuestionId } })
    const root = (id: string) => question(id, { mindmap: { categoryPath: ['Scope'] } })
    // A chain listed deepest first.
    expect(clarifyQuestionDepths([child('c', 'b'), child('b', 'a'), root('a')])).toEqual([3, 2, 1])
    // A fork.
    expect(
      clarifyQuestionDepths([root('a'), child('b', 'a'), child('c', 'a'), child('d', 'b')]),
    ).toEqual([1, 2, 2, 3])
    // A parent that is not in the round leaves the question a root.
    expect(clarifyQuestionDepths([child('orphan', 'gone'), question('plain')])).toEqual([1, 1])
    // A loop cannot be ranked but must end.
    expect(
      clarifyQuestionDepths([child('p', 'q'), child('q', 'p'), child('self', 'self')]),
    ).toEqual([2, 1, 1])
    // Iterative: a follow-up chain has no bound.
    const length = 30_000
    const chain = Array.from({ length }, (_, index) =>
      index === length - 1 ? root(`n${index}`) : child(`n${index}`, `n${index + 1}`),
    )
    const depths = clarifyQuestionDepths(chain)
    expect(depths[0]).toBe(length)
    expect(depths[length - 1]).toBe(1)
  })

  test('a mindmap round counts follow-up questions, requests, depth and the categories it reached', () => {
    const questions = [
      question('i1', { mindmap: { categoryPath: ['Scope', 'Limits'] } }),
      question('i2', { mindmap: { categoryPath: ['Scope'] } }),
      question('i3', { mindmap: { categoryPath: ['Data'] } }),
      question('f1', {
        mindmap: { categoryPath: ['Scope', 'Limits'], parentQuestionId: 'i1', requestId: 'req-1' },
      }),
      question('f2', {
        mindmap: { categoryPath: ['Scope', 'Limits'], parentQuestionId: 'i1', requestId: 'req-1' },
      }),
      // A follow-up on a category has no parent question.
      question('f3', { mindmap: { categoryPath: ['Risk'], requestId: 'req-2' } }),
      question('f4', {
        mindmap: { categoryPath: ['Scope', 'Limits'], parentQuestionId: 'f1', requestId: 'req-3' },
      }),
    ]
    const row = clarifyRoundDraft(
      clarifyRound({ status: 'awaiting_human', answeredAt: null }),
      null,
      content(questions),
    )
    expect(row.mindmap).toBe(true)
    expect(row.measures).toEqual({
      questions: 7,
      questionsInitial: 3,
      questionsFollowup: 4,
      followupRequests: 3,
      depthSum: 11,
      depthMax: 3,
    })
    // The top-level categories by name, each once: coverage is judged against the configured
    // names by the reader, so a count alone would not do.
    expect(row.categories).toEqual(['Scope', 'Data', 'Risk'])
    // Without the questions a round cannot tell that it is a mindmap.
    const bare = clarifyRoundDraft(clarifyRound(), null, null)
    expect(bare.mindmap).toBe(false)
    expect('categories' in bare).toBe(false)
    // A questionnaire round has no categories.
    expect(
      'categories' in clarifyRoundDraft(clarifyRound(), null, content([question('plain')])),
    ).toBe(false)
  })

  test('stored questions that are not objects are dropped, and a damaged list is empty', () => {
    expect(parseStoredQuestions(null)).toEqual([])
    expect(parseStoredQuestions('oops')).toEqual([])
    expect(parseStoredQuestions('{"id":"q1"}')).toEqual([])
    expect(parseStoredQuestions('[{"id":"q1"},null,"text",3,[1]]')).toEqual([
      { id: 'q1' } as unknown as ClarifyQuestion,
    ])
    // A question with nothing but an id still counts as asked.
    expect(
      clarifyRoundDraft(
        clarifyRound(),
        null,
        content(parseStoredQuestions('[{"id":"q1"}]'), [
          answer('q1', { selectedOptionIndices: [0] }),
        ]),
      ).measures,
    ).toEqual({
      questions: 1,
      questionsInitial: 1,
      depthSum: 1,
      depthMax: 1,
      answersOther: 1,
      maturityUnmarked: 1,
    })
  })

  test('clarify text is one question with the answer as the person gave it', () => {
    const questions = [
      question('picked'),
      question('several', {
        kind: 'multi',
        options: [option('A'), option('B'), option('C')],
      }),
      question('written'),
      question('skipped'),
      question('blank'),
      question('indices-only'),
    ]
    const answers = [
      answer('picked', { selectedOptionIndices: [0], selectedOptionLabels: ['A'] }),
      answer('several', {
        selectedOptionIndices: [0, 2],
        selectedOptionLabels: ['A', 'C'],
        customText: 'and D',
      }),
      answer('written', { customText: 'only mine' }),
      answer('skipped', { decision: { status: 'not-applicable' } }),
      answer('blank'),
      // Older answers hold the indices alone: the label comes from the question.
      { questionId: 'indices-only', selectedOptionIndices: [1] } as unknown as ClarifyAnswer,
    ]
    const round = clarifyRound({ askingNodeId: 'designer', answeredAt: T + 30 * MIN })
    const texts = clarifyRoundTexts(round, content(questions, answers))
    expect(texts.map((item) => item.text)).toEqual([
      'Q: picked?\nA: A',
      'Q: several?\nA: A; C; and D',
      'Q: written?\nA: only mine',
      'Q: indices-only?\nA: B',
    ])
    expect(texts[0]).toEqual({
      source: 'clarify',
      taskId: 't1',
      caseId: null,
      stageRef: 'designer',
      at: T + 30 * MIN,
      text: 'Q: picked?\nA: A',
    })
    // Only a submitted round with a decodable answer list has text.
    expect(
      clarifyRoundTexts(clarifyRound({ status: 'awaiting_human' }), content(questions, answers)),
    ).toEqual([])
    expect(clarifyRoundTexts(round, content(questions, null))).toEqual([])
  })
})

describe('RFC-616 gate rounds — numbering and order', () => {
  test('valid rounds of one instance are numbered by ready time; void rounds take 0 and do not shift them', () => {
    const rows = numberGateRounds(
      ['t2', 't1'],
      [
        draft({ stageNodeId: 'a', openedAt: T }),
        draft({ stageNodeId: 'b', openedAt: T + 1, void: true, outcome: 'superseded' }),
        // Two rounds ready in the same millisecond keep the order they were produced in.
        draft({ stageNodeId: 'c', openedAt: T + 2 }),
        draft({ stageNodeId: 'd', openedAt: T + 2 }),
        draft({ stageNodeId: 'e', openedAt: T + 3, void: true, outcome: 'voided' }),
        // Another review node run is another instance.
        draft({ stageNodeId: 'f', openedAt: T + 1, instanceKey: 'run-2', gateNodeRunId: 'run-2' }),
        // A clarify asker never shares numbering with a review, whatever its key.
        draft({ stageNodeId: 'g', openedAt: T + 1, kind: 'clarify' }),
        // The same key in another task is another instance.
        draft({ stageNodeId: 'h', openedAt: T + 5, taskId: 't2' }),
      ],
    )
    expect(rows.map((row) => [row.taskId, row.stageNodeId, row.ordinal])).toEqual([
      ['t2', 'h', 1],
      ['t1', 'a', 1],
      ['t1', 'g', 1],
      ['t1', 'b', 0],
      ['t1', 'f', 1],
      ['t1', 'c', 2],
      ['t1', 'd', 3],
      ['t1', 'e', 0],
    ])
  })

  test('rounds given out of ready order are still numbered by ready time', () => {
    const rows = numberGateRounds(
      ['t1'],
      [
        draft({ stageNodeId: 'late', openedAt: T + 9 }),
        draft({ stageNodeId: 'early', openedAt: T }),
      ],
    )
    expect(rows.map((row) => [row.stageNodeId, row.ordinal])).toEqual([
      ['early', 1],
      ['late', 2],
    ])
  })

  test('text items come back by task in the order given, then by time', () => {
    const item = (taskId: string, at: number, text: string): ProcessTextItem => ({
      source: 'review',
      taskId,
      caseId: null,
      stageRef: 'design',
      at,
      text,
    })
    expect(
      orderTextItems(
        ['t2', 't1'],
        [
          item('t1', T + 2, 'c'),
          item('t1', T + 1, 'b'),
          item('t2', T + 9, 'z'),
          item('t1', T + 1, 'a'),
          { ...item('t1', T + 1, 'a'), source: 'clarify' },
        ],
      ).map((entry) => [entry.taskId, entry.source, entry.text]),
    ).toEqual([
      ['t2', 'review', 'z'],
      ['t1', 'clarify', 'a'],
      ['t1', 'review', 'a'],
      ['t1', 'review', 'b'],
      ['t1', 'review', 'c'],
    ])
  })
})
