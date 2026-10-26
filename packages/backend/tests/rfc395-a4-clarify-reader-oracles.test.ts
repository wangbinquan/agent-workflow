// RFC-395 II-a A4: strict inline readers retain HEAD's values and exception boundaries.
// Expectations execute frozen HEAD fragments, never candidate projection output.
// II-b: the queue reads the converter's epoch-2 storage through the async answer projection.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decodeLegacyClarifyAnswerColumns } from '@/modules/collaboration/infrastructure/clarifyAnswerCodec'
import { projectClarifyAnswerRows } from '@/modules/collaboration/infrastructure/clarifyAnswerQueries'
import { decomposeClarifyRound } from '@/modules/collaboration/infrastructure/migration/clarifyRule'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { headClarifyReaders } from './helpers/rfc395A4HeadReaders'
import { roundRow } from './helpers/rfc395V2/collabFixtures'

const answer = (questionId: string, customText = '') => ({
  questionId,
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText,
})
const UNREPRESENTABLE_ANSWERS: readonly (string | null)[] = ['[null]', '[{}]']
const shapes = [
  null,
  '',
  '{broken',
  'null',
  '{}',
  '0',
  'false',
  '"legacy"',
  '[]',
  '[null]',
  '[{}]',
  JSON.stringify([answer('a', 'first'), answer('b'), answer('a', 'last')]),
]

function failure(error: unknown): unknown {
  // The refactor may change a TypeError's local variable name; its class and
  // whether it escapes the reader are the behavior contract.
  if (!(error instanceof Error)) throw error
  return error instanceof TypeError
    ? { error: error.name }
    : { error: error.name, message: error.message }
}

function outcome(run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    return failure(error)
  }
}

async function asyncOutcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { value: await run() }
  } catch (error) {
    return failure(error)
  }
}

function compile(
  body: string,
  signature = 'function read(round)',
): (...args: unknown[]) => unknown {
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${signature} { ${body} }`)
  return new Function(`${js}\nreturn read`)() as (...args: unknown[]) => unknown
}

function queueReader(source: string, signature?: string) {
  return compile(
    `
    const originId = 'origin'
    const roundByOrigin = new Map()
    const log = { warn() {} }
    const db = undefined
    for (const ignored of [0]) {
      ${source}
    }
    return roundByOrigin.get(originId)
  `,
    signature,
  )
}

type Epoch1Round = {
  id: string
  status: string
  answersJson: string | null
  questionsJson: string
  askingShardKey: null
}

/** The live epoch-2 round the converter writes for an epoch-1 round; undefined when it keeps none. */
function converted(epoch1: Epoch1Round) {
  const values = roundRow(epoch1.id, 'task', {
    status: epoch1.status,
    answers_json: epoch1.answersJson,
    questions_json: epoch1.questionsJson,
    asking_shard_key: epoch1.askingShardKey,
  })
  const key = [canonicalValue(epoch1.id)]
  const result = decomposeClarifyRound(
    {
      table: 'clarify_rounds',
      phase: 'current',
      values,
      key,
      encodedKey: encodeMigrationKey('clarify_rounds', key),
      canonical: { key, values: Object.values(values).map(canonicalValue) },
    },
    undefined,
    'terminal-history',
  )
  if (!result.representable) return undefined
  const answers = result.answers.map((row) => ({
    questionId: String(row.question_id),
    occurrence: Number(row.occurrence),
    ordinal: Number(row.ordinal),
    valueJson: String(row.value_json),
  }))
  const round = {
    id: epoch1.id,
    status: epoch1.status,
    questionsJson: String(result.round.questions_json),
    askingShardKey: epoch1.askingShardKey,
    answersRecorded: result.round.answers_recorded === true,
    draftsRecorded: result.round.drafts_recorded === true,
    attributionsRecorded: result.round.attributions_recorded === true,
    legacyAnswersJson:
      typeof result.round.legacy_answers_json === 'string'
        ? result.round.legacy_answers_json
        : null,
  }
  // The live reader loads exactly these child rows for the round.
  const readClarifyAnswerProjection = async (_db: unknown, target: typeof round) =>
    projectClarifyAnswerRows(target, answers, [], [])
  return { read: () => currentQueue(round, readClarifyAnswerProjection) as Promise<unknown> }
}

const queueSource = readFileSync(
  resolve(import.meta.dir, '../src/modules/collaboration/infrastructure/clarify/queue.ts'),
  'utf8',
)
const queueStart = queueSource.indexOf('    if (\n      round === undefined')
const queueEnd = queueSource.indexOf('\n  }\n\n  const result: AgentQueueEntry[]', queueStart)
if (queueStart < 0 || queueEnd < queueStart)
  throw new Error('clarify-queue-reader-source-not-found')
const currentQueue = queueReader(
  queueSource.slice(queueStart, queueEnd),
  'async function read(round, readClarifyAnswerProjection)',
)
const headQueue = queueReader(headClarifyReaders.queue.source)
const headStrict = compile(`return ${headClarifyReaders.strictAnswers.source}`)
const headFollowup = compile(`
  ${headClarifyReaders.effective.source.replace(/^export /, '')}
  return ${headClarifyReaders.followup.source}
`)

describe('RFC-395 A4 HEAD inline-reader oracles', () => {
  for (const answersJson of shapes) {
    test(`strict answers preserve HEAD JSON shape: ${String(answersJson)}`, () => {
      const round = { answersJson }
      expect(outcome(() => decodeLegacyClarifyAnswerColumns(round).requireAnswers())).toEqual(
        outcome(() => headStrict(round)),
      )
    })
    for (const status of ['awaiting_human', 'answered', 'canceled', 'abandoned']) {
      test(`queue ${status} / ${String(answersJson)} preserves parse-skip versus map-throw`, async () => {
        const round = {
          id: 'round',
          status,
          answersJson,
          questionsJson: '[{"id":"a"},{"id":"b"}]',
          askingShardKey: null,
        }
        const target = converted(round)
        // Answers without a string questionId stay raw conversion evidence, not a live round.
        if (UNREPRESENTABLE_ANSWERS.includes(answersJson)) expect(target).toBeUndefined()
        else expect(await asyncOutcome(target!.read)).toEqual(outcome(() => headQueue(round)))
      })
    }
    for (const draftAnswersJson of [
      null,
      '',
      '{broken',
      'null',
      '[]',
      '{}',
      '"old"',
      JSON.stringify({ a: answer('a', 'draft'), c: answer('c', 'kept') }),
    ]) {
      test(`follow-up answers ${String(answersJson)} / drafts ${String(draftAnswersJson)}`, () => {
        const round = { answersJson, draftAnswersJson }
        expect(
          outcome(() => decodeLegacyClarifyAnswerColumns(round).requireEffectiveAnswers()),
        ).toEqual(outcome(() => headFollowup(round)))
      })
    }
  }
  test('queue rejects malformed question JSON in the same catch, but non-array questions escape it', async () => {
    for (const questionsJson of ['', '{bad', 'null', '{}', '[]', '[null]']) {
      const round = {
        id: 'round',
        status: 'answered',
        answersJson: '[]',
        questionsJson,
        askingShardKey: null,
      }
      expect(await asyncOutcome(converted(round)!.read)).toEqual(outcome(() => headQueue(round)))
    }
  })
  test('strict answer maps retain last duplicate and reject non-array / null entries', () => {
    for (const answersJson of shapes) {
      const round = { answersJson }
      const headMap = () => {
        const values = headStrict(round) as Array<{ questionId: string }>
        return new Map(values.map((value) => [value.questionId, value]))
      }
      expect(outcome(() => decodeLegacyClarifyAnswerColumns(round).requireAnswerMap())).toEqual(
        outcome(headMap),
      )
    }
  })
})
