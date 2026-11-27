// RFC-616 §5.2 — the review and clarify rounds offered to process metrics.
//
// Collaboration owns the ledgers a human gate leaves behind: doc versions with
// their comments, clarify rounds with their answers. It is therefore the one
// context that turns them into the neutral gate rows of
// `platform/contracts/processFacts`; process metrics never read these tables.
// Read-only and derived on demand: nothing here writes or caches.
//
// Every query is one task-scoped scan (the task indexes of `doc_versions` and
// `clarify_rounds`) plus id-chunked follow-ups, so a batch of 500 tasks costs a
// handful of statements however many rounds it holds. The round rules
// themselves are pure and live in `domain/processGateRounds`.

import { inArray } from 'drizzle-orm'
import { databaseContentText } from '@/platform/content/infrastructure/contentStore'
import {
  PROCESS_FACT_ID_BATCH,
  type ProcessGateFacts,
  type ProcessTextItem,
} from '@/platform/contracts/processFacts'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { chunkedAll } from '@/platform/persistence/sqlChunk'
import {
  clarifyRoundClosesWithMediator,
  clarifyRoundDraft,
  clarifyRoundTexts,
  groupReviewRounds,
  numberGateRounds,
  orderTextItems,
  parseArchivedReviewComments,
  parseStoredQuestions,
  reviewRoundDraft,
  reviewRoundTexts,
  reviewRunEndOf,
  type ClarifyRoundContent,
  type ClarifyRoundFact,
  type GateRoundDraft,
  type ReviewCommentText,
  type ReviewRound,
  type ReviewRunEnd,
  type ReviewVersionFact,
} from '../domain/processGateRounds'
import { projectClarifyAnswerRows } from './clarifyAnswerQueries'
import type { TaskExecutionParticipantBindings } from './taskExecutionParticipantBindings'

/**
 * The node-run reads a canceled clarify round needs to find when it ended, and
 * a review left pending needs to learn that its run no longer waits.
 * The participant bindings the assembly root already builds satisfy it.
 */
export type ProcessGateNodeRunReads = Pick<TaskExecutionParticipantBindings, 'createNodeRunQueries'>

function boundedIds(taskIds: readonly string[]): string[] {
  if (taskIds.length > PROCESS_FACT_ID_BATCH)
    throw new RangeError(`task id batch exceeds ${PROCESS_FACT_ID_BATCH}`)
  return [...new Set(taskIds)]
}

function gather<T>(byKey: Map<string, T[]>, key: string, value: T): void {
  const values = byKey.get(key)
  if (values === undefined) byKey.set(key, [value])
  else values.push(value)
}

const numberOrNull = (value: number | null): number | null =>
  value === null ? null : Number(value)

// --- review -------------------------------------------------------------------

type StoredVersion = ReviewVersionFact & { readonly commentsJson: string | null }

interface VersionColumns {
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
  readonly decidedAt: number | null
  readonly decidedBy: string | null
  readonly createdAt: number
}

// Built per query: schema columns are provider projections and must not be captured at load time.
function versionColumns(db: object) {
  const { docVersions } = tablesOf(db)
  return {
    id: docVersions.id,
    taskId: docVersions.taskId,
    reviewNodeId: docVersions.reviewNodeId,
    reviewNodeRunId: docVersions.reviewNodeRunId,
    sourceNodeId: docVersions.sourceNodeId,
    versionIndex: docVersions.versionIndex,
    reviewIteration: docVersions.reviewIteration,
    roundGeneration: docVersions.roundGeneration,
    itemIndex: docVersions.itemIndex,
    selection: docVersions.selection,
    decision: docVersions.decision,
    decidedAt: docVersions.decidedAt,
    decidedBy: docVersions.decidedBy,
    createdAt: docVersions.createdAt,
  }
}

function storedVersion(
  row: VersionColumns,
  commentsJson: string | null,
  decisionReason: string | null,
): StoredVersion {
  return {
    id: row.id,
    taskId: row.taskId,
    reviewNodeId: row.reviewNodeId,
    reviewNodeRunId: row.reviewNodeRunId,
    sourceNodeId: row.sourceNodeId,
    versionIndex: Number(row.versionIndex),
    reviewIteration: Number(row.reviewIteration),
    roundGeneration: numberOrNull(row.roundGeneration),
    itemIndex: numberOrNull(row.itemIndex),
    selection: row.selection,
    decision: row.decision,
    decisionReason,
    decidedAt: numberOrNull(row.decidedAt),
    decidedBy: row.decidedBy,
    createdAt: Number(row.createdAt),
    commentsJson,
  }
}

/**
 * The doc versions of the tasks. The comment archive and the decision reason
 * are the heavy columns, so each caller loads only the ones it reads: the
 * interval listing neither, the measures the archive, the texts both.
 */
async function loadVersions(
  db: PersistenceDb,
  taskIds: string[],
  content: 'intervals' | 'comments' | 'texts',
): Promise<StoredVersion[]> {
  const { docVersions } = tablesOf(db)
  const columns = versionColumns(db)
  const ofTasks = inArray(docVersions.taskId, taskIds)
  if (content === 'intervals') {
    const rows = await db.select(columns).from(docVersions).where(ofTasks)
    return rows.map((row) => storedVersion(row, null, null))
  }
  if (content === 'comments') {
    const rows = await db
      .select({ ...columns, commentsJson: docVersions.commentsJson })
      .from(docVersions)
      .where(ofTasks)
    return rows.map((row) => storedVersion(row, row.commentsJson, null))
  }
  const rows = await db
    .select({
      ...columns,
      commentsJson: docVersions.commentsJson,
      decisionReason: docVersions.decisionReason,
    })
    .from(docVersions)
    .where(ofTasks)
  return rows.map((row) => storedVersion(row, row.commentsJson, row.decisionReason))
}

/**
 * A pending version's comments are live rows; a decision freezes them into the
 * version's archive and deletes the rows. The review page reads them by the
 * same rule, which is what keeps a round's count unchanged across its decision.
 */
function pendingVersionIds(rounds: readonly ReviewRound<StoredVersion>[]): string[] {
  return rounds.flatMap((round) =>
    round.versions.filter((version) => version.decision === 'pending').map((version) => version.id),
  )
}

async function liveCommentAuthors(
  db: PersistenceDb,
  versionIds: string[],
): Promise<Map<string, string[]>> {
  const rows = await chunkedAll(versionIds, (chunk) => {
    const { reviewComments } = tablesOf(db)
    return db
      .select({ docVersionId: reviewComments.docVersionId, author: reviewComments.author })
      .from(reviewComments)
      .where(inArray(reviewComments.docVersionId, chunk))
  })
  const byVersion = new Map<string, string[]>()
  for (const row of rows) gather(byVersion, row.docVersionId, row.author)
  return byVersion
}

async function liveCommentTexts(
  db: PersistenceDb,
  versionIds: string[],
): Promise<Map<string, ReviewCommentText[]>> {
  const rows = await chunkedAll(versionIds, (chunk) => {
    const { reviewComments } = tablesOf(db)
    return db
      .select({
        docVersionId: reviewComments.docVersionId,
        createdAt: reviewComments.createdAt,
        contentRefJson: reviewComments.contentRefJson,
        contentInlineBytes: reviewComments.contentInlineBytes,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.docVersionId, chunk))
  })
  const byVersion = new Map<string, ReviewCommentText[]>()
  for (const row of rows) {
    // A live comment's body is a content reference; the review page resolves it the same way.
    const text = await databaseContentText(db, row)
    gather(byVersion, row.docVersionId, { text, at: Number(row.createdAt) })
  }
  return byVersion
}

/**
 * What became of the review node runs that hold a round still awaiting a
 * decision. A task that is canceled, or finishes, closes the waiting run and
 * leaves the version `pending`; only the run says that the wait is over.
 */
async function pendingReviewRunEnds(
  db: PersistenceDb,
  nodeRuns: ProcessGateNodeRunReads | undefined,
  rounds: readonly ReviewRound<StoredVersion>[],
): Promise<Map<string, ReviewRunEnd>> {
  const ends = new Map<string, ReviewRunEnd>()
  if (nodeRuns === undefined) return ends
  const runIds = [
    ...new Set(
      rounds.filter((round) => round.decision === 'pending').map((round) => round.reviewNodeRunId),
    ),
  ]
  const runs = await chunkedAll(runIds, async (chunk) => [
    ...(await nodeRuns
      .createNodeRunQueries(db)
      .listHistoryFields({ runIds: chunk }, ['id', 'status', 'finishedAt'])),
  ])
  for (const run of runs) {
    ends.set(
      run.id,
      reviewRunEndOf({
        status: run.status,
        finishedAt: run.finishedAt === null ? null : Number(run.finishedAt),
      }),
    )
  }
  return ends
}

async function reviewDrafts(
  db: PersistenceDb,
  nodeRuns: ProcessGateNodeRunReads | undefined,
  taskIds: string[],
  measures: boolean,
): Promise<GateRoundDraft[]> {
  const rounds = groupReviewRounds(
    await loadVersions(db, taskIds, measures ? 'comments' : 'intervals'),
  )
  const ends = await pendingReviewRunEnds(db, nodeRuns, rounds)
  const endOf = (round: ReviewRound) => ends.get(round.reviewNodeRunId) ?? null
  if (!measures) return rounds.map((round) => reviewRoundDraft(round, null, endOf(round)))
  const live = await liveCommentAuthors(db, pendingVersionIds(rounds))
  return rounds.map((round) =>
    reviewRoundDraft(
      round,
      round.versions.flatMap((version) =>
        version.decision === 'pending'
          ? (live.get(version.id) ?? [])
          : parseArchivedReviewComments(version.commentsJson).map((comment) => comment.author),
      ),
      endOf(round),
    ),
  )
}

async function reviewTexts(db: PersistenceDb, taskIds: string[]): Promise<ProcessTextItem[]> {
  const rounds = groupReviewRounds(await loadVersions(db, taskIds, 'texts'))
  const live = await liveCommentTexts(db, pendingVersionIds(rounds))
  return rounds.flatMap((round) =>
    reviewRoundTexts(
      round,
      round.versions.flatMap((version): ReviewCommentText[] =>
        version.decision === 'pending'
          ? (live.get(version.id) ?? [])
          : parseArchivedReviewComments(version.commentsJson),
      ),
    ),
  )
}

// --- clarify ------------------------------------------------------------------

interface StoredRound extends ClarifyRoundFact {
  readonly questionsJson: string | null
  readonly answersRecorded: boolean
  readonly attributionsRecorded: boolean
  readonly legacyAnswersJson: string | null
}

interface RoundColumns {
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

type RoundAnswerColumns = Pick<
  StoredRound,
  'questionsJson' | 'answersRecorded' | 'attributionsRecorded' | 'legacyAnswersJson'
>

const NO_ANSWER_COLUMNS: RoundAnswerColumns = {
  questionsJson: null,
  answersRecorded: false,
  attributionsRecorded: false,
  legacyAnswersJson: null,
}

// Built per query: schema columns are provider projections and must not be captured at load time.
function roundColumns(db: object) {
  const { clarifyRounds } = tablesOf(db)
  return {
    id: clarifyRounds.id,
    taskId: clarifyRounds.taskId,
    askingNodeId: clarifyRounds.askingNodeId,
    askingShardKey: clarifyRounds.askingShardKey,
    intermediaryNodeId: clarifyRounds.intermediaryNodeId,
    intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId,
    status: clarifyRounds.status,
    directive: clarifyRounds.directive,
    createdAt: clarifyRounds.createdAt,
    answeredAt: clarifyRounds.answeredAt,
    answeredBy: clarifyRounds.answeredBy,
    abandonedAt: clarifyRounds.abandonedAt,
  }
}

function storedRound(row: RoundColumns, answers: RoundAnswerColumns): StoredRound {
  return {
    id: row.id,
    taskId: row.taskId,
    askingNodeId: row.askingNodeId,
    askingShardKey: row.askingShardKey,
    intermediaryNodeId: row.intermediaryNodeId,
    intermediaryNodeRunId: row.intermediaryNodeRunId,
    status: row.status,
    directive: row.directive,
    createdAt: Number(row.createdAt),
    answeredAt: numberOrNull(row.answeredAt),
    answeredBy: row.answeredBy,
    abandonedAt: numberOrNull(row.abandonedAt),
    questionsJson: answers.questionsJson,
    answersRecorded: answers.answersRecorded,
    attributionsRecorded: answers.attributionsRecorded,
    legacyAnswersJson: answers.legacyAnswersJson,
  }
}

/**
 * The clarify rounds of the tasks, each asker's rounds in the order they were
 * asked. The questions and the answer bookkeeping are loaded only when the
 * caller reads them.
 */
async function loadRounds(
  db: PersistenceDb,
  taskIds: string[],
  content: boolean,
): Promise<StoredRound[]> {
  const { clarifyRounds } = tablesOf(db)
  const columns = roundColumns(db)
  const ofTasks = inArray(clarifyRounds.taskId, taskIds)
  const rounds = content
    ? (
        await db
          .select({
            ...columns,
            questionsJson: clarifyRounds.questionsJson,
            answersRecorded: clarifyRounds.answersRecorded,
            attributionsRecorded: clarifyRounds.attributionsRecorded,
            legacyAnswersJson: clarifyRounds.legacyAnswersJson,
          })
          .from(clarifyRounds)
          .where(ofTasks)
      ).map((row) => storedRound(row, row))
    : (await db.select(columns).from(clarifyRounds).where(ofTasks)).map((row) =>
        storedRound(row, NO_ANSWER_COLUMNS),
      )
  // Sorted here rather than in SQL: text ordering differs between the two engines.
  return rounds.sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

interface AnswerRow {
  readonly questionId: string
  readonly occurrence: number
  readonly ordinal: number
  readonly valueJson: string
}

async function answerRowsByRound(
  db: PersistenceDb,
  rows: 'clarifyAnswers' | 'clarifyAnswerAttributions',
  roundIds: string[],
): Promise<Map<string, AnswerRow[]>> {
  const stored = await chunkedAll(roundIds, (chunk) => {
    const table = tablesOf(db)[rows]
    return db
      .select({
        roundId: table.roundId,
        questionId: table.questionId,
        occurrence: table.occurrence,
        ordinal: table.ordinal,
        valueJson: table.valueJson,
      })
      .from(table)
      .where(inArray(table.roundId, chunk))
  })
  const byRound = new Map<string, AnswerRow[]>()
  for (const row of stored) {
    gather(byRound, row.roundId, {
      questionId: row.questionId,
      occurrence: Number(row.occurrence),
      ordinal: Number(row.ordinal),
      valueJson: row.valueJson,
    })
  }
  return byRound
}

/**
 * What each round asked and, for a submitted round, what was answered. The
 * answers go through the projection every other clarify reader uses, so the
 * recorded rows and the legacy answers column are decoded by one rule; the rows
 * are loaded for all rounds at once instead of round by round. `people` also
 * loads who answered each question.
 */
async function clarifyContents(
  db: PersistenceDb,
  rounds: readonly StoredRound[],
  people: boolean,
): Promise<Map<string, ClarifyRoundContent>> {
  const submitted = rounds.filter((round) => round.status === 'answered')
  const answers = await answerRowsByRound(
    db,
    'clarifyAnswers',
    submitted.filter((round) => round.answersRecorded).map((round) => round.id),
  )
  const attributions = people
    ? await answerRowsByRound(
        db,
        'clarifyAnswerAttributions',
        submitted.filter((round) => round.attributionsRecorded).map((round) => round.id),
      )
    : new Map<string, AnswerRow[]>()
  const contents = new Map<string, ClarifyRoundContent>()
  for (const round of rounds) {
    const questions = parseStoredQuestions(round.questionsJson)
    if (round.status !== 'answered') {
      contents.set(round.id, { questions, answers: null, attributions: null })
      continue
    }
    const projection = projectClarifyAnswerRows(
      {
        id: round.id,
        answersRecorded: round.answersRecorded,
        // Drafts are what a round held before it was submitted; a submitted round is read from its answers.
        draftsRecorded: false,
        attributionsRecorded: people && round.attributionsRecorded,
        legacyAnswersJson: round.legacyAnswersJson,
      },
      answers.get(round.id) ?? [],
      [],
      attributions.get(round.id) ?? [],
    )
    contents.set(round.id, {
      questions,
      answers: projection.answers,
      attributions: projection.answerAttributions,
    })
  }
  return contents
}

/** When the mediator node runs finished, for the rounds that record no end of their own. */
async function mediatorFinishTimes(
  db: PersistenceDb,
  nodeRuns: ProcessGateNodeRunReads | undefined,
  rounds: readonly StoredRound[],
): Promise<Map<string, number>> {
  const finished = new Map<string, number>()
  if (nodeRuns === undefined) return finished
  const runIds = [
    ...new Set(
      rounds.filter(clarifyRoundClosesWithMediator).map((round) => round.intermediaryNodeRunId),
    ),
  ]
  // The history read also covers runs carried over from before the current schema.
  const runs = await chunkedAll(runIds, async (chunk) => [
    ...(await nodeRuns
      .createNodeRunQueries(db)
      .listHistoryFields({ runIds: chunk }, ['id', 'finishedAt'])),
  ])
  for (const run of runs) {
    if (run.finishedAt !== null) finished.set(run.id, Number(run.finishedAt))
  }
  return finished
}

async function clarifyDrafts(
  db: PersistenceDb,
  nodeRuns: ProcessGateNodeRunReads | undefined,
  taskIds: string[],
  measures: boolean,
): Promise<GateRoundDraft[]> {
  const rounds = await loadRounds(db, taskIds, measures)
  const finished = await mediatorFinishTimes(db, nodeRuns, rounds)
  const contents = measures ? await clarifyContents(db, rounds, true) : null
  return rounds.map((round) =>
    clarifyRoundDraft(
      round,
      finished.get(round.intermediaryNodeRunId) ?? null,
      contents?.get(round.id) ?? null,
    ),
  )
}

async function clarifyTexts(db: PersistenceDb, taskIds: string[]): Promise<ProcessTextItem[]> {
  const rounds = (await loadRounds(db, taskIds, true)).filter(
    (round) => round.status === 'answered',
  )
  const contents = await clarifyContents(db, rounds, false)
  return rounds.flatMap((round) => {
    const content = contents.get(round.id)
    return content === undefined ? [] : clarifyRoundTexts(round, content)
  })
}

/**
 * RFC-616: review and clarify rounds as facts for process metrics.
 *
 * `nodeRuns` is optional: without it a canceled clarify round closes where it
 * opened, because only its mediator node run records when it ended, and a
 * review left pending on a run the platform closed still reads as open.
 */
export function createProcessGateFacts(
  db: PersistenceDb,
  nodeRuns?: ProcessGateNodeRunReads,
): ProcessGateFacts {
  return {
    async rounds(taskIds, options) {
      const ids = boundedIds(taskIds)
      if (ids.length === 0) return []
      return numberGateRounds(ids, [
        ...(await reviewDrafts(db, nodeRuns, ids, options.measures)),
        ...(await clarifyDrafts(db, nodeRuns, ids, options.measures)),
      ])
    },

    async texts(taskIds, sources) {
      const ids = boundedIds(taskIds)
      if (ids.length === 0) return []
      const wanted = new Set(sources)
      const review = wanted.has('review') ? await reviewTexts(db, ids) : []
      const clarify = wanted.has('clarify') ? await clarifyTexts(db, ids) : []
      return orderTextItems(ids, [...review, ...clarify])
    },
  }
}
