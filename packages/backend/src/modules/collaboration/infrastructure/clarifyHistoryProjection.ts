import { createTaskGateQueries } from '@/modules/task-execution/public/queries'
import {
  readDispositionArchives,
  initializeDispositionArchives,
} from '@/platform/persistence/schema/history/dispositionArchive'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  databaseHandleContext,
  tablesOf,
  type PersistenceTables,
} from '@/platform/persistence/sessionTables'
import { inArray } from 'drizzle-orm'
import { chunkedAll } from '@/util/sqlChunk'
import { decodeLegacyClarifyAnswerColumns } from './clarifyAnswerCodec'

export type ClarifyHistoryRound = PersistenceTables['clarifyRounds']['$inferSelect'] & {
  readonly legacyProjection?: ReturnType<typeof decodeLegacyClarifyAnswerColumns>
}
interface ClarifyHistoryFilter {
  readonly taskId?: string
  readonly roundIds?: readonly string[]
  readonly intermediaryNodeRunId?: string
  readonly status?: string
  readonly kind?: string
}
interface ClarifyHistoryIndex {
  readonly rows: readonly ClarifyHistoryRound[]
  readonly tasks: ReadonlyMap<string, readonly ClarifyHistoryRound[]>
  readonly rounds: ReadonlyMap<string, ClarifyHistoryRound>
  readonly runs: ReadonlyMap<string, readonly ClarifyHistoryRound[]>
}
const runtimeIndexes = new WeakMap<object, Promise<ClarifyHistoryIndex>>()

function cacheHistoryIndex(db: PersistenceDb, pending: Promise<ClarifyHistoryIndex>) {
  const runtime = databaseHandleContext(db)
  runtimeIndexes.set(runtime, pending)
  void pending.catch(() => {
    if (runtimeIndexes.get(runtime) === pending) runtimeIndexes.delete(runtime)
  })
  return pending
}

/** Bootstrap primes this once before serving; failed loads remain retryable by reads. */
export async function initializeClarifyHistory(db: PersistenceDb): Promise<void> {
  const pending = initializeDispositionArchives(db, 'clarify_rounds').then(() =>
    loadHistoryIndex(db),
  )
  await cacheHistoryIndex(db, pending)
}
function historyIndex(db: PersistenceDb): Promise<ClarifyHistoryIndex> {
  const runtime = databaseHandleContext(db)
  let pending = runtimeIndexes.get(runtime)
  if (!pending) {
    pending = cacheHistoryIndex(db, loadHistoryIndex(db))
  }
  return pending
}
async function loadHistoryIndex(db: PersistenceDb): Promise<ClarifyHistoryIndex> {
  const archives = await readDispositionArchives(db, 'clarify_rounds')
  const rows = new Map<string, ClarifyHistoryRound>()
  for (const archive of archives) {
    const v = archive.values
    const text = (column: string) => (typeof v[column] === 'string' ? v[column] : null)
    if (typeof v.id !== 'string' || typeof v.task_id !== 'string')
      throw new Error('clarify-history-identity-missing')
    const legacyProjection = decodeLegacyClarifyAnswerColumns({
      answersJson: text('answers_json'),
      draftAnswersJson: text('draft_answers_json'),
      answerAttributionsJson: text('answer_attributions_json'),
    })
    const values = Object.fromEntries(
      Object.entries(v)
        .filter(
          ([key]) =>
            !['answers_json', 'draft_answers_json', 'answer_attributions_json'].includes(key),
        )
        .map(([key, value]) => [
          key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          value,
        ]),
    )
    rows.set(v.id, {
      ...values,
      questionsRevision: 1,
      sealedQuestionSetKey: null,
      answersRecorded: false,
      draftsRecorded: false,
      attributionsRecorded: false,
      legacyAnswersJson: text('answers_json'),
      legacyProjection,
    } as ClarifyHistoryRound)
  }
  const tasks = new Map<string, ClarifyHistoryRound[]>()
  const runs = new Map<string, ClarifyHistoryRound[]>()
  for (const row of rows.values()) {
    const taskRows = tasks.get(row.taskId) ?? []
    taskRows.push(row)
    tasks.set(row.taskId, taskRows)
    const runRows = runs.get(row.intermediaryNodeRunId) ?? []
    runRows.push(row)
    runs.set(row.intermediaryNodeRunId, runRows)
  }
  return { rows: [...rows.values()], tasks, rounds: rows, runs }
}

/** Immutable candidates only; callers must check live-row precedence and task presence. */
export async function readClarifyHistoryCandidates(
  db: PersistenceDb,
  filter: ClarifyHistoryFilter = {},
): Promise<readonly ClarifyHistoryRound[]> {
  const index = await historyIndex(db)
  const candidates =
    filter.taskId !== undefined
      ? (index.tasks.get(filter.taskId) ?? [])
      : filter.roundIds !== undefined
        ? filter.roundIds.flatMap((id) => index.rounds.get(id) ?? [])
        : filter.intermediaryNodeRunId !== undefined
          ? (index.runs.get(filter.intermediaryNodeRunId) ?? [])
          : index.rows
  return candidates.filter(
    (row) =>
      (filter.status === undefined || row.status === filter.status) &&
      (filter.kind === undefined || row.kind === filter.kind),
  )
}

/** Only history readers call this; archived rows never enter control-channel decisions. */
export async function readClarifyHistory(
  db: PersistenceDb,
  filter: ClarifyHistoryFilter = {},
): Promise<readonly ClarifyHistoryRound[]> {
  const candidates = await readClarifyHistoryCandidates(db, filter)
  if (candidates.length === 0) return []
  // A present live row may have been legitimately updated after the switch.
  const { clarifyRounds } = tablesOf(db)
  const live = new Set(
    (
      await chunkedAll(
        candidates.map((row) => row.id),
        (ids) =>
          db
            .select({ id: clarifyRounds.id })
            .from(clarifyRounds)
            .where(inArray(clarifyRounds.id, ids)),
      )
    ).map((row) => row.id),
  )
  const existing = new Set(
    (
      await createTaskGateQueries(db).listContexts([
        ...new Set(candidates.map((row) => row.taskId)),
      ])
    ).map((task) => task.id),
  )
  return candidates.filter((row) => existing.has(row.taskId) && !live.has(row.id))
}
export function mergeClarifyHistory<T extends { readonly id: string }>(
  live: readonly T[],
  history: readonly T[],
): T[] {
  return [...new Map([...history, ...live].map((row) => [row.id, row])).values()]
}
