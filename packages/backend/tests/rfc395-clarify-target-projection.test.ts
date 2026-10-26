// RFC-395 C: target projections preserve occurrence order, raw legacy values and independent attribution.
import { expect, test } from 'bun:test'
import { projectClarifyAnswerRows } from '@/modules/collaboration/infrastructure/clarifyAnswerQueries'
import { decomposeClarifyRound } from '@/modules/collaboration/infrastructure/migration/clarifyRule'
import { roundRow } from './helpers/rfc395V2/collabFixtures'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'

const round = {
  id: 'r',
  answersRecorded: false,
  draftsRecorded: false,
  attributionsRecorded: false,
  legacyAnswersJson: null,
}
const row = (questionId: string, occurrence: number, ordinal: number, value: unknown) => ({
  questionId,
  occurrence,
  ordinal,
  valueJson: JSON.stringify(value),
})

test('NULL and empty arrays/maps remain distinct, including attribution without answers or drafts', () => {
  const absent = projectClarifyAnswerRows(round, [], [], [])
  expect(absent.answers).toBeNull()
  expect(absent.draftAnswers).toBeNull()
  expect(absent.answerAttributions).toBeNull()
  const empty = projectClarifyAnswerRows(
    { ...round, answersRecorded: true, draftsRecorded: true, attributionsRecorded: true },
    [],
    [],
    [],
  )
  expect(empty.answers).toEqual([])
  expect(empty.draftAnswers).toEqual({})
  expect(empty.answerAttributions).toEqual({})
  const attribution = { userId: 'historical', role: 'owner' as const, updatedAt: 10 }
  const independent = projectClarifyAnswerRows(
    { ...round, attributionsRecorded: true },
    [],
    [],
    [row('q', 0, 0, attribution)],
  )
  expect(independent.answers).toBeNull()
  expect(independent.draftAnswers).toBeNull()
  expect(independent.answerAttributions).toEqual({ q: attribution })
})

test('duplicate occurrences retain ordinal array order, first board answer and last queue answer', () => {
  const first = {
    questionId: 'same',
    customText: 'first',
    selectedOptionIndices: [],
    selectedOptionLabels: [],
  }
  const last = { ...first, customText: 'last' }
  const other = { ...first, questionId: 'other', customText: 'other' }
  const firstAttribution = { userId: 'first', role: 'owner' as const, updatedAt: 1 }
  const lastAttribution = { userId: 'last', role: 'owner' as const, updatedAt: 2 }
  const projection = projectClarifyAnswerRows(
    { ...round, answersRecorded: true, attributionsRecorded: true },
    [row('same', 1, 2, last), row('other', 0, 1, other), row('same', 0, 0, first)],
    [],
    [row('same', 0, 0, firstAttribution), row('same', 1, 1, lastAttribution)],
  )
  expect(projection.answers).toEqual([first, other, last])
  expect(projection.firstAnswer('same')).toEqual(first)
  expect(projection.answerMap().get('same')).toEqual(last)
  expect(projection.answerAttributions?.same).toEqual(lastAttribution)
})

for (const raw of [' { "legacy" : [1, 2] }\n', 'null', 'not-json'])
  test(`legacy answer bytes survive conversion: ${JSON.stringify(raw)}`, () => {
    const values = { ...roundRow('r'), answers_json: raw }
    const key = [canonicalValue('r')]
    const source: SourceRow = {
      table: 'clarify_rounds',
      phase: 'current',
      values,
      key,
      encodedKey: encodeMigrationKey('clarify_rounds', key),
      canonical: { key, values: Object.values(values).map(canonicalValue) },
    }
    const converted = decomposeClarifyRound(source, undefined, 'terminal-history')
    expect(converted.round.legacy_answers_json).toBe(raw)
    const projection = projectClarifyAnswerRows({ ...round, legacyAnswersJson: raw }, [], [], [])
    if (raw === 'not-json') {
      expect(projection.content).toEqual({ kind: 'malformed', text: raw })
      expect(() => projection.requireAnswers()).toThrow()
    } else {
      expect(projection.detailAnswers).toEqual(JSON.parse(raw))
      expect(projection.content).toEqual({
        kind: 'legacy-value',
        json: JSON.stringify(JSON.parse(raw)),
      })
    }
  })
