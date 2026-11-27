// RFC-616 §5.2 — review and clarify rounds as process metrics read them.
//
// Pure rules over rows the persistence adapter has already loaded: which doc
// versions form one review round, which rounds are void, how the rounds of one
// gate instance are numbered, and what a round's stored comments, questions and
// answers count as. The stored JSON was written by many versions of the
// product, so every field of it is read defensively: a damaged entry counts for
// nothing instead of failing a whole summary.

import {
  clarifySkipStatus,
  isMindmapRound,
  isSystemDecision,
  isTerminalNodeRunStatus,
  LOCAL_DECIDER,
  type ClarifyAnswer,
  type ClarifyAnswerAttributions,
  type ClarifyDraftValue,
  type ClarifyQuestion,
  type NodeRunStatus,
} from '@agent-workflow/shared'
import type {
  ProcessGateMeasure,
  ProcessGatePerson,
  ProcessTaskGateRoundRow,
  ProcessTextItem,
} from '@/platform/contracts/processFacts'
import { groupDocVersionRounds } from './reviewRounds'

/** A gate round before the rounds of its instance are numbered. */
export type GateRoundDraft = Omit<ProcessTaskGateRoundRow, 'ordinal'>

type GateCounts = Partial<Record<ProcessGateMeasure, number>>

interface RoundClose {
  readonly void: boolean
  readonly closedAt: number | null
  readonly outcome: string | null
  readonly deciderUserId: string | null
}

const STILL_OPEN: RoundClose = { void: false, closedAt: null, outcome: null, deciderUserId: null }
// Shared by every row that carries an interval only, hence frozen.
const NOTHING_COUNTED: Pick<GateRoundDraft, 'measures' | 'people'> = Object.freeze({
  measures: Object.freeze({}),
  people: Object.freeze([]),
})

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/**
 * The audit columns hold a user id or one of two markers: the framework's own
 * decisions, and the single local user of installations that predate accounts.
 * Neither marker is a person a statistic can name.
 */
function personOf(value: unknown): string | null {
  const id = textOrNull(value)
  return id === null || id === LOCAL_DECIDER || isSystemDecision(id) ? null : id
}

/** Absent keys are zero in the contract, so a zero count is left out rather than stored. */
function keepCounts(counts: GateCounts): GateCounts {
  const kept: GateCounts = {}
  for (const [name, value] of Object.entries(counts) as [ProcessGateMeasure, number][]) {
    if (value > 0) kept[name] = value
  }
  return kept
}

function peopleOf(
  tally: ReadonlyMap<string, number>,
  counted: 'comments' | 'answers',
): ProcessGatePerson[] {
  return [...tally]
    .map(([userId, count]) =>
      counted === 'comments'
        ? { userId, comments: count, answers: 0 }
        : { userId, comments: 0, answers: count },
    )
    .sort((a, b) => compareText(a.userId, b.userId))
}

// --- review -------------------------------------------------------------------

/** The columns of a doc version the round rules read. */
export interface ReviewVersionFact {
  readonly id: string
  readonly taskId: string
  readonly reviewNodeId: string
  readonly reviewNodeRunId: string
  readonly sourceNodeId: string
  readonly versionIndex: number
  readonly reviewIteration: number
  readonly roundGeneration: number | null
  readonly itemIndex: number | null
  readonly selection: string | null
  readonly decision: string
  /** Loaded for text only; null elsewhere. */
  readonly decisionReason: string | null
  readonly decidedAt: number | null
  readonly decidedBy: string | null
  readonly createdAt: number
}

export interface ReviewRound<V extends ReviewVersionFact = ReviewVersionFact> {
  readonly taskId: string
  readonly reviewNodeId: string
  readonly reviewNodeRunId: string
  readonly sourceNodeId: string
  /** One version for a single-document round; the documents in item order for a multi-document one. */
  readonly versions: readonly V[]
  readonly multiDocument: boolean
  readonly decision: string
  readonly decisionReason: string | null
  readonly decidedAt: number | null
  readonly decidedBy: string | null
  /** When the round's content became ready for review. */
  readonly openedAt: number
}

/**
 * Doc versions as review rounds, each review node run's rounds in the order
 * they were produced. A single-document review has one round per version; the
 * documents of a multi-document review are grouped by the rule the review page
 * itself uses (`groupDocVersionRounds`). A run that holds both shapes keeps both.
 */
export function groupReviewRounds<V extends ReviewVersionFact>(
  versions: readonly V[],
): ReviewRound<V>[] {
  const byRun = new Map<string, V[]>()
  for (const version of versions) {
    const run = byRun.get(version.reviewNodeRunId)
    if (run === undefined) byRun.set(version.reviewNodeRunId, [version])
    else run.push(version)
  }
  const rounds: ReviewRound<V>[] = []
  for (const run of byRun.values()) {
    const single = run
      .filter((version) => version.itemIndex === null)
      .sort((a, b) => a.versionIndex - b.versionIndex || compareText(a.id, b.id))
    for (const version of single) {
      rounds.push({
        taskId: version.taskId,
        reviewNodeId: version.reviewNodeId,
        reviewNodeRunId: version.reviewNodeRunId,
        sourceNodeId: version.sourceNodeId,
        versions: [version],
        multiDocument: false,
        decision: version.decision,
        decisionReason: version.decisionReason,
        decidedAt: version.decidedAt,
        decidedBy: version.decidedBy,
        openedAt: version.createdAt,
      })
    }
    const documents = run.filter((version) => version.itemIndex !== null)
    // The grouping also summarises the decider's role, which a round does not carry.
    const groups = groupDocVersionRounds(
      documents.map((version) => ({ ...version, decidedByRole: null })),
    )
    for (const group of groups) {
      const first = group.members[0]!
      rounds.push({
        taskId: first.taskId,
        reviewNodeId: first.reviewNodeId,
        reviewNodeRunId: first.reviewNodeRunId,
        sourceNodeId: first.sourceNodeId,
        versions: group.members,
        multiDocument: true,
        decision: group.decision,
        decisionReason: group.decisionReason,
        decidedAt: group.decidedAt,
        decidedBy: group.decidedBy,
        openedAt: group.createdAt,
      })
    }
  }
  return rounds
}

/** What became of the review node run that holds a round still awaiting a decision. */
export interface ReviewRunEnd {
  /** The run no longer waits for a reviewer. */
  readonly ended: boolean
  readonly finishedAt: number | null
}

/**
 * A review run in a terminal state under a version still `pending` means the
 * platform closed the run around it — the task was canceled, or finished —
 * and left the version as it was: nobody can decide it any more. (The review
 * page counts a pending review by the same rule: the run must be waiting.)
 */
export function reviewRunEndOf(run: {
  readonly status: NodeRunStatus
  readonly finishedAt: number | null
}): ReviewRunEnd {
  return { ended: isTerminalNodeRunStatus(run.status), finishedAt: run.finishedAt }
}

function reviewRoundClose(round: ReviewRound, run: ReviewRunEnd | null = null): RoundClose {
  if (round.decision === 'pending') {
    if (run === null || !run.ended) return STILL_OPEN
    // Closed by the platform, not by a decision: void, and over when the run ended.
    return {
      void: true,
      closedAt: Math.max(round.openedAt, run.finishedAt ?? round.openedAt),
      outcome: 'canceled',
      deciderUserId: null,
    }
  }
  // Every writer stamps the decision time; a row that lost it still closed, where it opened.
  const closedAt = round.decidedAt ?? round.openedAt
  // Retired because the upstream produced a fresher version while this one waited.
  if (round.decision === 'superseded')
    return { void: true, closedAt, outcome: 'superseded', deciderUserId: null }
  // A sibling review's rejection stamps this review's pending versions `rejected` with the
  // system as decider: the framework disposed of them, no person decided anything.
  if (isSystemDecision(round.decidedBy))
    return { void: true, closedAt, outcome: 'voided', deciderUserId: null }
  return {
    void: false,
    closedAt,
    outcome: round.decision,
    deciderUserId: personOf(round.decidedBy),
  }
}

function reviewRoundCounts(
  round: ReviewRound,
  commentAuthors: readonly string[],
): Pick<GateRoundDraft, 'measures' | 'people'> {
  const byAuthor = new Map<string, number>()
  for (const author of commentAuthors) byAuthor.set(author, (byAuthor.get(author) ?? 0) + 1)
  // The local user is one commenter, but has no account a per-person row could name.
  const byUser = new Map<string, number>()
  for (const [author, comments] of byAuthor) {
    const userId = personOf(author)
    if (userId !== null) byUser.set(userId, comments)
  }
  return {
    measures: keepCounts({
      comments: commentAuthors.length,
      commenters: byAuthor.size,
      ...(round.multiDocument
        ? {
            documents: round.versions.length,
            documentsAccepted: round.versions.filter((version) => version.selection === 'accepted')
              .length,
          }
        : {}),
    }),
    people: peopleOf(byUser, 'comments'),
  }
}

/**
 * One review round as a gate row. `commentAuthors` holds the author of every
 * comment on the round's versions; null when only the interval is wanted.
 * `run` says what became of the review node run, for a round still awaiting a
 * decision; without it such a round reads as open.
 */
export function reviewRoundDraft(
  round: ReviewRound,
  commentAuthors: readonly string[] | null,
  run: ReviewRunEnd | null = null,
): GateRoundDraft {
  return {
    taskId: round.taskId,
    kind: 'review',
    stageNodeId: round.reviewNodeId,
    relatedNodeId: round.sourceNodeId,
    askingShardKey: null,
    gateNodeRunId: round.reviewNodeRunId,
    // A review node run is reused across iterate and reject, and minted anew per loop round.
    instanceKey: round.reviewNodeRunId,
    ...reviewRoundClose(round, run),
    openedAt: round.openedAt,
    mindmap: false,
    ...(commentAuthors === null ? NOTHING_COUNTED : reviewRoundCounts(round, commentAuthors)),
  }
}

/** A review comment as text: what was written and when. */
export interface ReviewCommentText {
  readonly text: string
  readonly at: number | null
}

export interface ArchivedReviewComment extends ReviewCommentText {
  readonly author: string
}

/** The comments a decision froze on its version. A missing or damaged archive holds none. */
export function parseArchivedReviewComments(json: string | null): ArchivedReviewComment[] {
  // Every version nobody commented on stores '[]': the common case needs no parse.
  if (json === null || json === '' || json === '[]') return []
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const comments: ArchivedReviewComment[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const comment = entry as { author?: unknown; commentText?: unknown; createdAt?: unknown }
    comments.push({
      // A comment without an author gets the writer's own fallback, the local user.
      author: textOrNull(comment.author) ?? LOCAL_DECIDER,
      text: typeof comment.commentText === 'string' ? comment.commentText : '',
      at:
        typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
          ? comment.createdAt
          : null,
    })
  }
  return comments
}

/** What reviewers wrote on one round: every comment, and the reason of a rejection. */
export function reviewRoundTexts(
  round: ReviewRound,
  comments: readonly ReviewCommentText[],
): ProcessTextItem[] {
  // Judged on the version alone: comments on a version still pending are what reviewers
  // wrote, whatever became of the run that held it.
  const close = reviewRoundClose(round)
  // A void round records what the framework did with a version, not a reviewer's conclusion.
  if (close.void) return []
  const item = (text: string, at: number): ProcessTextItem => ({
    source: 'review',
    taskId: round.taskId,
    caseId: null,
    stageRef: round.sourceNodeId,
    at,
    text,
  })
  const settledAt = close.closedAt ?? round.openedAt
  const items = comments
    .filter((comment) => comment.text.trim() !== '')
    .map((comment) => item(comment.text, comment.at ?? settledAt))
  // Only a rejection stores a reason somebody typed. An iterated version stores its own
  // comments there, rendered for the rerun prompt, which would repeat every comment above.
  const reason = round.decision === 'rejected' ? (round.decisionReason ?? '').trim() : ''
  if (reason !== '') items.push(item(reason, settledAt))
  return items
}

// --- clarify ------------------------------------------------------------------

/** The columns of a clarify round the round rules read. */
export interface ClarifyRoundFact {
  readonly id: string
  readonly taskId: string
  readonly askingNodeId: string
  readonly askingShardKey: string | null
  readonly intermediaryNodeId: string
  readonly intermediaryNodeRunId: string
  readonly status: string
  readonly directive: string | null
  readonly createdAt: number
  readonly answeredAt: number | null
  readonly answeredBy: string | null
  readonly abandonedAt: number | null
}

/** What a round asked and what was answered. */
export interface ClarifyRoundContent {
  readonly questions: readonly ClarifyQuestion[]
  /** The sealed answers; null when none were recorded or the stored payload is not an answer list. */
  readonly answers: readonly ClarifyAnswer[] | null
  readonly attributions: ClarifyAnswerAttributions | null
}

/**
 * A canceled round records no time of its own, and an abandoned one may lack
 * its timestamp: both closed when their mediator node run did.
 */
export function clarifyRoundClosesWithMediator(round: ClarifyRoundFact): boolean {
  return round.status === 'canceled' || (round.status === 'abandoned' && round.abandonedAt === null)
}

function clarifyRoundClose(round: ClarifyRoundFact, mediatorFinishedAt: number | null): RoundClose {
  if (round.status === 'answered')
    return {
      void: false,
      closedAt: round.answeredAt ?? round.createdAt,
      // Rounds answered before the directive existed kept asking, which is what `continue` means.
      outcome: round.directive ?? 'continue',
      deciderUserId: personOf(round.answeredBy),
    }
  if (round.status === 'canceled' || round.status === 'abandoned') {
    const endedAt = round.abandonedAt ?? mediatorFinishedAt
    return {
      void: true,
      // Without a recorded end the round closes where it opened: a void round must never
      // stretch to the end of its task.
      closedAt: endedAt === null ? round.createdAt : Math.max(round.createdAt, endedAt),
      outcome: round.status,
      deciderUserId: null,
    }
  }
  return STILL_OPEN
}

/** The stored questions that are objects; anything else in the list is dropped. */
export function parseStoredQuestions(json: string | null): ClarifyQuestion[] {
  if (json === null || json === '') return []
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return []
  }
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is ClarifyQuestion =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : []
}

interface StoredMindmap {
  readonly categoryPath?: unknown
  readonly parentQuestionId?: unknown
  readonly requestId?: unknown
}

function mindmapOf(question: ClarifyQuestion): StoredMindmap | null {
  const mindmap: unknown = question.mindmap
  return typeof mindmap === 'object' && mindmap !== null ? (mindmap as StoredMindmap) : null
}

const parentIdOf = (question: ClarifyQuestion) => textOrNull(mindmapOf(question)?.parentQuestionId)
/** Only a question a follow-up generated carries the id of the request that produced it. */
const requestIdOf = (question: ClarifyQuestion) => textOrNull(mindmapOf(question)?.requestId)

function categoryRootOf(question: ClarifyQuestion): string | null {
  const path = mindmapOf(question)?.categoryPath
  return Array.isArray(path) ? textOrNull((path as unknown[])[0]) : null
}

function optionsOf(question: ClarifyQuestion): readonly unknown[] {
  const options: unknown = question.options
  return Array.isArray(options) ? (options as unknown[]) : []
}

/** Rounds stored before options carried metadata hold plain strings: a label, never a recommendation. */
function isRecommended(option: unknown): boolean {
  return (
    typeof option === 'object' &&
    option !== null &&
    (option as { recommended?: unknown }).recommended === true
  )
}

function optionLabel(option: unknown): string {
  if (typeof option === 'string') return option
  if (typeof option !== 'object' || option === null) return ''
  return textOrNull((option as { label?: unknown }).label) ?? ''
}

/**
 * The depth of every question, in list order: a question whose parent is absent
 * or unknown is depth 1, and each parent hop adds 1. Iterative, because a
 * follow-up chain has no bound.
 */
export function clarifyQuestionDepths(questions: readonly ClarifyQuestion[]): number[] {
  const byId = new Map<string, ClarifyQuestion>()
  for (const question of questions) if (!byId.has(question.id)) byId.set(question.id, question)
  const depthById = new Map<string, number>()
  for (const question of questions) {
    const chain: string[] = []
    const walked = new Set<string>()
    let current: ClarifyQuestion | undefined = question
    let depth = 0
    while (current !== undefined) {
      const known = depthById.get(current.id)
      if (known !== undefined) {
        depth = known
        break
      }
      // A parent loop cannot be ranked: the question that closes it counts as a root.
      if (walked.has(current.id)) break
      walked.add(current.id)
      chain.push(current.id)
      const parentId = parentIdOf(current)
      current = parentId === null ? undefined : byId.get(parentId)
    }
    for (let index = chain.length - 1; index >= 0; index--) depthById.set(chain[index]!, ++depth)
  }
  return questions.map((question) => depthById.get(question.id) ?? 1)
}

function questionCounts(questions: readonly ClarifyQuestion[]): GateCounts {
  const depths = clarifyQuestionDepths(questions)
  const requests = new Set<string>()
  let followups = 0
  for (const question of questions) {
    const requestId = requestIdOf(question)
    if (requestId !== null) {
      followups++
      requests.add(requestId)
    }
  }
  return {
    questions: questions.length,
    questionsInitial: questions.length - followups,
    questionsFollowup: followups,
    followupRequests: requests.size,
    depthSum: depths.reduce((sum, depth) => sum + depth, 0),
    depthMax: depths.reduce((max, depth) => Math.max(max, depth), 0),
  }
}

/** The top-level categories the questions fall under, each once, in first-seen order. */
function categoryRootsOf(questions: readonly ClarifyQuestion[]): string[] {
  const roots = new Set<string>()
  for (const question of questions) {
    const root = categoryRootOf(question)
    if (root !== null) roots.add(root)
  }
  return [...roots]
}

/** A sealed answer reduced to what the person gave. */
interface GivenAnswer {
  readonly indices: readonly number[]
  readonly labels: readonly string[]
  readonly customText: string
  readonly decision: ClarifyDraftValue['decision']
}

function givenAnswer(raw: unknown): GivenAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null
  const answer = raw as Partial<Record<keyof ClarifyAnswer, unknown>>
  const indices: unknown[] = Array.isArray(answer.selectedOptionIndices)
    ? answer.selectedOptionIndices
    : []
  const labels: unknown[] = Array.isArray(answer.selectedOptionLabels)
    ? answer.selectedOptionLabels
    : []
  return {
    indices: indices.filter((index): index is number => Number.isInteger(index)),
    labels: labels.filter((label): label is string => typeof label === 'string' && label !== ''),
    customText: typeof answer.customText === 'string' ? answer.customText.trim() : '',
    decision:
      typeof answer.decision === 'object' && answer.decision !== null
        ? (answer.decision as ClarifyDraftValue['decision'])
        : undefined,
  }
}

function answersByQuestion(answers: readonly ClarifyAnswer[]): Map<string, GivenAnswer> {
  const byQuestion = new Map<string, GivenAnswer>()
  for (const raw of answers as readonly unknown[]) {
    const given = givenAnswer(raw)
    if (given === null) continue
    const questionId = textOrNull((raw as { questionId?: unknown }).questionId)
    // A question sealed more than once in history keeps its last answer, as the answer queue reads it.
    if (questionId !== null) byQuestion.set(questionId, given)
  }
  return byQuestion
}

/** The answer when something was chosen in it — an option or text of the person's own; null otherwise. */
function choiceOf(given: GivenAnswer | undefined): GivenAnswer | null {
  return given !== undefined && (given.indices.length > 0 || given.customText !== '') ? given : null
}

type AnswerMeasure = 'answersRecommended' | 'answersOther' | 'answersCustom' | 'answersSkipped'

/**
 * How one question of a submitted round was answered. A skip status takes
 * effect only on an answer with nothing chosen (`clarifySkipStatus`), and the
 * blank answer a round submit pads an untouched question with leaves it just as
 * undecided, so "nothing chosen" is the whole test for a skip.
 */
function answerMeasureOf(question: ClarifyQuestion, choice: GivenAnswer | null): AnswerMeasure {
  if (choice === null) return 'answersSkipped'
  if (choice.customText !== '') return 'answersCustom'
  const options = optionsOf(question)
  return choice.indices.every((index) => isRecommended(options[index]))
    ? 'answersRecommended'
    : 'answersOther'
}

/** A skip the person marked, as opposed to a question nobody touched. */
function isMarkedSkip(given: GivenAnswer | undefined): boolean {
  return (
    given !== undefined &&
    clarifySkipStatus({
      selectedOptionIndices: [...given.indices],
      customText: given.customText,
      decision: given.decision,
    }) !== undefined
  )
}

function answerText(question: ClarifyQuestion, given: GivenAnswer): string {
  const options = optionsOf(question)
  // The seal refills the labels from the indices; older answers may hold the indices alone.
  const labels =
    given.labels.length > 0
      ? given.labels
      : given.indices.map((index) => optionLabel(options[index])).filter((label) => label !== '')
  return [...labels, given.customText].filter((part) => part !== '').join('; ')
}

function clarifyRoundCounts(
  round: ClarifyRoundFact,
  content: ClarifyRoundContent,
): Pick<GateRoundDraft, 'measures' | 'people'> {
  const counts = questionCounts(content.questions)
  // Answers describe a submitted round only: until then they are still being edited, and a
  // payload that is not an answer list says nothing about how the questions were answered.
  if (round.status !== 'answered' || content.answers === null)
    return { measures: keepCounts(counts), people: [] }
  const given = answersByQuestion(content.answers)
  const tally = {
    answersRecommended: 0,
    answersOther: 0,
    answersCustom: 0,
    answersSkipped: 0,
    questionsWithRecommendation: 0,
    maturityDecided: 0,
    maturityProvisional: 0,
    maturityUnmarked: 0,
  } satisfies GateCounts
  const byUser = new Map<string, number>()
  for (const question of content.questions) {
    const answer = given.get(question.id)
    const choice = choiceOf(answer)
    tally[answerMeasureOf(question, choice)]++
    if (choice !== null) {
      // The adoption rate of recommendations is taken over the questions that offered one.
      if (optionsOf(question).some(isRecommended)) tally.questionsWithRecommendation++
      const status = choice.decision?.status
      if (status === 'decided') tally.maturityDecided++
      else if (status === 'provisional') tally.maturityProvisional++
      else tally.maturityUnmarked++
    }
    // A person answered a question by choosing something or by marking it skipped.
    if (choice !== null || isMarkedSkip(answer)) {
      const userId = personOf(content.attributions?.[question.id]?.userId)
      if (userId !== null) byUser.set(userId, (byUser.get(userId) ?? 0) + 1)
    }
  }
  return { measures: keepCounts({ ...counts, ...tally }), people: peopleOf(byUser, 'answers') }
}

/**
 * One clarify round as a gate row. `mediatorFinishedAt` is the finish time of
 * the round's mediator node run when it is known. `content` is null when only
 * the interval is wanted; the row then cannot say whether it is a mindmap,
 * because that is read off the questions.
 */
export function clarifyRoundDraft(
  round: ClarifyRoundFact,
  mediatorFinishedAt: number | null,
  content: ClarifyRoundContent | null,
): GateRoundDraft {
  return {
    taskId: round.taskId,
    kind: 'clarify',
    stageNodeId: round.intermediaryNodeId,
    relatedNodeId: round.askingNodeId,
    askingShardKey: round.askingShardKey,
    gateNodeRunId: round.intermediaryNodeRunId,
    // The same asker within the task: an asking node, and its shard when it has one.
    instanceKey: `${round.askingNodeId}|${round.askingShardKey ?? ''}`,
    ...clarifyRoundClose(round, mediatorFinishedAt),
    openedAt: round.createdAt,
    mindmap: content !== null && isMindmapRound(content.questions),
    ...(content === null ? NOTHING_COUNTED : clarifyRoundCounts(round, content)),
    ...(content !== null && isMindmapRound(content.questions)
      ? { categories: categoryRootsOf(content.questions) }
      : {}),
  }
}

/** The questions of a submitted round with the answers people gave them. */
export function clarifyRoundTexts(
  round: ClarifyRoundFact,
  content: ClarifyRoundContent,
): ProcessTextItem[] {
  if (round.status !== 'answered' || content.answers === null) return []
  const given = answersByQuestion(content.answers)
  const items: ProcessTextItem[] = []
  for (const question of content.questions) {
    const choice = choiceOf(given.get(question.id))
    // A skipped or untouched question has no answer text to analyse.
    if (choice === null) continue
    const text = answerText(question, choice)
    if (text === '') continue
    items.push({
      source: 'clarify',
      taskId: round.taskId,
      caseId: null,
      stageRef: round.askingNodeId,
      at: round.answeredAt ?? round.createdAt,
      text: `Q: ${textOrNull(question.title) ?? ''}\nA: ${text}`,
    })
  }
  return items
}

// --- numbering and order ------------------------------------------------------------

/**
 * Number the rounds of every gate instance and return them in a fixed order:
 * by task in the order given, then by ready time.
 *
 * Within one instance the valid rounds are numbered from 1 by ready time; a void
 * round is 0 and does not take a number. Drafts of one instance must arrive in
 * the order they were produced: rounds that became ready in the same millisecond
 * keep that order.
 */
export function numberGateRounds(
  taskIds: readonly string[],
  drafts: readonly GateRoundDraft[],
): ProcessTaskGateRoundRow[] {
  const instances = new Map<string, GateRoundDraft[]>()
  for (const draft of drafts) {
    const key = `${draft.taskId}\u0000${draft.kind}\u0000${draft.instanceKey}`
    const instance = instances.get(key)
    if (instance === undefined) instances.set(key, [draft])
    else instance.push(draft)
  }
  const taskOrder = new Map(taskIds.map((taskId, index) => [taskId, index]))
  const placed: { readonly row: ProcessTaskGateRoundRow; readonly position: number }[] = []
  for (const instance of instances.values()) {
    let ordinal = 0
    // Array.prototype.sort is stable, which is what keeps same-millisecond rounds in order.
    const ordered = [...instance].sort((a, b) => a.openedAt - b.openedAt)
    ordered.forEach((draft, position) => {
      placed.push({ row: { ...draft, ordinal: draft.void ? 0 : ++ordinal }, position })
    })
  }
  return placed
    .sort(
      (a, b) =>
        (taskOrder.get(a.row.taskId) ?? 0) - (taskOrder.get(b.row.taskId) ?? 0) ||
        a.row.openedAt - b.row.openedAt ||
        compareText(a.row.kind, b.row.kind) ||
        compareText(a.row.instanceKey, b.row.instanceKey) ||
        a.position - b.position,
    )
    .map((entry) => entry.row)
}

/** Text items in a fixed order: by task in the order given, then by time. */
export function orderTextItems(
  taskIds: readonly string[],
  items: readonly ProcessTextItem[],
): ProcessTextItem[] {
  const taskOrder = new Map(taskIds.map((taskId, index) => [taskId, index]))
  const orderOf = (item: ProcessTextItem) =>
    item.taskId === null ? -1 : (taskOrder.get(item.taskId) ?? 0)
  return [...items].sort(
    (a, b) =>
      orderOf(a) - orderOf(b) ||
      a.at - b.at ||
      compareText(a.source, b.source) ||
      compareText(a.text, b.text),
  )
}
