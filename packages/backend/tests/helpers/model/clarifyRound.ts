// RFC-395 II-a A1: ClarifyRound fixtures keep public projection names while storage changes in II-b.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { createFixtureAdapter, decodeFixture, encodeFixture } from './core'
import type { ClarifyRoundFixtureSpec } from './clarifyRound.spec'
export type { ClarifyRoundFixtureSpec } from './clarifyRound.spec'
export type ClarifyRoundFixtureRow = Omit<
  PersistenceTables['clarifyRounds']['$inferSelect'],
  | 'questionsJson'
  | 'answersJson'
  | 'truncationWarningsJson'
  | 'answerAttributionsJson'
  | 'draftAnswersJson'
> & {
  questions: PersistenceTables['clarifyRounds']['$inferSelect']['questionsJson']
  answers: PersistenceTables['clarifyRounds']['$inferSelect']['answersJson']
  truncationWarnings: PersistenceTables['clarifyRounds']['$inferSelect']['truncationWarningsJson']
  answerAttributions: PersistenceTables['clarifyRounds']['$inferSelect']['answerAttributionsJson']
  draftAnswers: PersistenceTables['clarifyRounds']['$inferSelect']['draftAnswersJson']
}
const adapter = createFixtureAdapter<
  ClarifyRoundFixtureSpec,
  PersistenceTables['clarifyRounds'],
  ClarifyRoundFixtureRow
>({
  table: (db) => tablesOf(db).clarifyRounds,
  physicalTable: 'clarify_rounds',
  keys: ['id'],
  project: async (_db, row) => decodeFixture('clarify_rounds', row) as ClarifyRoundFixtureRow,
})
export const clarifyRoundFixture = adapter.insert
export const patchClarifyRoundFixture = adapter.patch
export const readClarifyRoundFixtures = adapter.read

/** A3 replaces this epoch-1 input adapter when clarify reconciliation accepts the projection. */
export function clarifyRoundFixtureRuntimeInput(
  row: ClarifyRoundFixtureRow,
): PersistenceTables['clarifyRounds']['$inferSelect'] {
  return encodeFixture('clarify_rounds', row) as PersistenceTables['clarifyRounds']['$inferSelect']
}
