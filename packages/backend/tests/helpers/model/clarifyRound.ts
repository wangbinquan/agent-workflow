// Clarify fixtures preserve recorded-empty, absence, occurrences and independent attribution rows.
import { clarifyQuestionSetKey, type ClarifyQuestion } from '@agent-workflow/shared'
import { asc, eq } from 'drizzle-orm'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { decodeLegacyClarifyAnswerColumns } from '@/modules/collaboration/infrastructure/clarifyAnswerCodec'
import { scanJsonObjectEntries } from '@/platform/persistence/migration/conversion/orderedJson'
import {
  createFixtureAdapter,
  encodeFixture,
  fixtureJson,
  type FixtureHandle,
  type FixturePatch,
} from './core'
import type { ClarifyRoundFixtureSpec } from './clarifyRound.spec'
export type { ClarifyRoundFixtureSpec } from './clarifyRound.spec'
type Round = PersistenceTables['clarifyRounds']['$inferSelect']
export type ClarifyRoundFixtureRow = Round & {
  questions: string
  answers: string | null
  truncationWarnings: string | null
  answerAttributions: string | null
  draftAnswers: string | null
}
async function writeAnswers(
  db: FixtureHandle,
  row: Round,
  spec: FixturePatch<ClarifyRoundFixtureSpec>,
) {
  const { clarifyRounds, clarifyAnswers, clarifyAnswerDrafts, clarifyAnswerAttributions } =
    tablesOf(db)
  const patch: Partial<Round> = {}
  const encoded = encodeFixture('clarify_rounds', spec)
  const projection = decodeLegacyClarifyAnswerColumns(encoded)
  if (spec.answers !== undefined) {
    await db.delete(clarifyAnswers).where(eq(clarifyAnswers.roundId, row.id))
    patch.answersRecorded = projection.answers !== null
    patch.legacyAnswersJson =
      projection.answers === null ? (encoded.answersJson as string | null) : null
    const occurrences = new Map<string, number>()
    const values = (projection.answers ?? []).map((answer, ordinal) => {
      if (typeof answer.questionId !== 'string')
        throw new Error('fixture-clarify-answer-key-required')
      const occurrence = occurrences.get(answer.questionId) ?? 0
      occurrences.set(answer.questionId, occurrence + 1)
      return {
        roundId: row.id,
        questionId: answer.questionId,
        occurrence,
        ordinal,
        valueJson: JSON.stringify(answer),
        revision: 1,
        questionsRevision: row.questionsRevision,
        updatedAt: row.answeredAt ?? row.createdAt,
      }
    })
    if (values.length) await db.insert(clarifyAnswers).values(values)
  }
  for (const [field, column, table, recorded] of [
    ['draftAnswers', 'draftAnswersJson', clarifyAnswerDrafts, 'draftsRecorded'],
    [
      'answerAttributions',
      'answerAttributionsJson',
      clarifyAnswerAttributions,
      'attributionsRecorded',
    ],
  ] as const) {
    if (spec[field] === undefined) continue
    const raw = encoded[column] as string | null
    const value = projection[field]
    patch[recorded] = value !== null
    await db.delete(table).where(eq(table.roundId, row.id))
    const occurrences = new Map<string, number>()
    const entries = value === null ? [] : scanJsonObjectEntries(raw!)
    for (const entry of entries) {
      const occurrence = occurrences.get(entry.key) ?? 0
      occurrences.set(entry.key, occurrence + 1)
      const common = {
        roundId: row.id,
        questionId: entry.key,
        occurrence,
        ordinal: entry.ordinal,
        valueJson: entry.rawValue,
      }
      if (field === 'draftAnswers')
        await db.insert(clarifyAnswerDrafts).values({
          ...common,
          revision: 1,
          questionsRevision: row.questionsRevision,
          updatedAt: row.createdAt,
        })
      else await db.insert(clarifyAnswerAttributions).values(common)
    }
  }
  if (Object.keys(patch).length)
    await db.update(clarifyRounds).set(patch).where(eq(clarifyRounds.id, row.id))
}
const adapter = createFixtureAdapter<
  ClarifyRoundFixtureSpec,
  PersistenceTables['clarifyRounds'],
  ClarifyRoundFixtureRow
>({
  table: (db) => tablesOf(db).clarifyRounds,
  physicalTable: 'clarify_rounds',
  keys: ['id'],
  async prepare(_db, row, spec) {
    row.questionsRevision = 1
    row.sealedQuestionSetKey =
      spec.status === 'answered'
        ? clarifyQuestionSetKey(
            JSON.parse(fixtureJson(spec.questions) ?? '[]') as ClarifyQuestion[],
          )
        : null
  },
  afterWrite: writeAnswers,
  async afterPatch(db, row, spec) {
    const table = tablesOf(db).clarifyRounds
    const [current] = await db.select().from(table).where(eq(table.id, row.id))
    if (!current) throw new Error('fixture-clarify-round-missing')
    const questionsRevision = row.questionsRevision + (spec.questions === undefined ? 0 : 1)
    const sealedQuestionSetKey =
      current.status === 'answered'
        ? clarifyQuestionSetKey(JSON.parse(current.questionsJson) as ClarifyQuestion[])
        : null
    await db
      .update(table)
      .set({ questionsRevision, sealedQuestionSetKey })
      .where(eq(table.id, row.id))
    await writeAnswers(db, { ...current, questionsRevision, sealedQuestionSetKey }, spec)
  },
  async project(db, original) {
    const tables = tablesOf(db)
    const [row] = await db
      .select()
      .from(tables.clarifyRounds)
      .where(eq(tables.clarifyRounds.id, original.id))
    if (!row) throw new Error('fixture-clarify-round-missing')
    const list = async (
      table:
        | typeof tables.clarifyAnswers
        | typeof tables.clarifyAnswerDrafts
        | typeof tables.clarifyAnswerAttributions,
    ) =>
      db
        .select({ questionId: table.questionId, valueJson: table.valueJson })
        .from(table)
        .where(eq(table.roundId, row.id))
        .orderBy(asc(table.ordinal))
    const answers = row.answersRecorded ? await list(tables.clarifyAnswers) : null
    const map = async (
      table: typeof tables.clarifyAnswerDrafts | typeof tables.clarifyAnswerAttributions,
    ) =>
      `{${(await list(table)).map((entry) => `${JSON.stringify(entry.questionId)}:${entry.valueJson}`).join(',')}}`
    return {
      ...row,
      questions: row.questionsJson,
      answers:
        row.legacyAnswersJson ??
        (answers === null ? null : `[${answers.map((entry) => entry.valueJson).join(',')}]`),
      truncationWarnings: row.truncationWarningsJson,
      draftAnswers: row.draftsRecorded ? await map(tables.clarifyAnswerDrafts) : null,
      answerAttributions: row.attributionsRecorded
        ? await map(tables.clarifyAnswerAttributions)
        : null,
    }
  },
})
export const clarifyRoundFixture = adapter.insert
export const patchClarifyRoundFixture = adapter.patch
export const readClarifyRoundFixtures = adapter.read
export function clarifyRoundFixtureRuntimeInput(row: ClarifyRoundFixtureRow): Round {
  return row
}
